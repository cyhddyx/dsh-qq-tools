// dsh-qq-tools —— 给大肥鱼会话用的轻量 QQ 群/私聊工具 + 唤醒（共享核心）
//
// 结构（2026-10-23 拆分，2026-10-24 加表情和私聊）：
//   · 每个工具是一个独立的 cordis 组件，由 cordis.patch.yml 里的 8 个 insert 行加载；
//     插件详情页「包含的组件」会列出 8 个工具，每个都有自己的开关。
//   · 本文件只放共享逻辑：配置、OneBot、目标会话挂载、@ 轮询、私聊唤醒、戳一戳、表情、观察窗。
//   · 发群消息组件负责 @ 提醒轮询；戳一戳组件负责接收戳一戳事件；
//     收藏表情组件负责 QQ 收藏夹（走 SnowLuma 的自定义表情接口，和 QQ 客户端同步）；
//     私聊组件负责好友/私聊记录/发私聊消息，以及私聊消息唤醒。
//
// 设计目标（按用户要求）：
//   · 群聊不逐条转发、不自动回；由「主动搭话」或「有人 @」触发，
//     模型自己用工具看 2~3 个群的最近 30 条，再决定要不要发、发哪个群；
//   · 私聊消息逐条唤醒目标会话，模型用 qq_get_private_history / qq_send_private_message 看和回；
//   · 所有工具只在目标会话的 agent 上注册，其他会话看不到；
//   · 唤醒通过 agent.followup 进入同一个会话：
//     群 @ = qq-mention，群后续 = qq-followup，群戳一戳 = qq-poke，私聊 = qq-private。
//
// 配置：~/.dsh/qq-tools-config.json（首次启动自动创建）
//   {
//     "napCat": "http://127.0.0.1:3000",
//     "accessToken": "",
//     "targetSession": "",                  // 目标会话 ID；留空 = 不挂工具
//     "groups": [],                        // 允许看/发的群；空数组 = 工具不限制（提醒也不轮询）
//     "historyCount": 30,
//     "maxHistoryCount": 50,
//     "pollMs": 5000,
//     "mentionEnabled": true,               // @ 提醒轮询（跟着「发群消息」组件走）
//     "pokeEnabled": true,                  // 接收戳一戳事件（跟着「戳一戳」组件走）
//     "privateEnabled": true,               // 私聊唤醒（跟着「私聊」组件走）
//     "privateUsers": [],                   // 允许唤醒的私聊 QQ 号；空数组 = 不限制
//     "timeoutMs": 6000
//   }
//
// 工具本身的开关在 DSH 插件页的组件列表里：关掉某个组件，它就不再注册对应工具。

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(DSH_HOME, 'qq-tools-config.json')
const DIAG_PATH = join(DSH_HOME, 'qq-tools-diag.log')


const requireFromHere = createRequire(import.meta.url)
let sharpSource = ''

function sharpFromDir(dir) {
  try {
    const s = createRequire(join(String(dir), 'noop.js'))('sharp')
    return s || null
  } catch (error) {
    return null
  }
}

function sharpFromCache() {
  try {
    const cache = requireFromHere.cache || {}
    for (const key of Object.keys(cache)) {
      if (!/[\\/]node_modules[\\/]sharp[\\/]/.test(key)) continue
      const mod = cache[key]
      if (mod && mod.exports) return mod.exports
    }
  } catch (error) {}
  return null
}

// sharp 是可选的，按顺序找：SHARP_PATH → 插件自己装的 → 宿主 runtime → 常见宿主目录。
// 关键的一条是 process.argv[2]：DSH 桌面版的 dsh-desktop-host 用 argv[2] 接 runtimeDir，
// 插件和宿主在同一个进程里，所以 runtimeDir/node_modules/sharp 就是宿主实际加载的那份。
// 不写死安装路径；找不到时核心图片逻辑照常工作，只是不拆 GIF 帧，
// 尺寸被宿主拒绝时也没法兜底重编码。
function loadSharp() {
  const probes = []
  const add = (label, fn) => probes.push({ label, fn })

  if (process.env.SHARP_PATH) add('SHARP_PATH', () => requireFromHere(process.env.SHARP_PATH))
  add('插件 node_modules', () => requireFromHere('sharp'))
  if (process.argv[1]) add('宿主入口', () => createRequire(process.argv[1])('sharp'))
  if (process.argv[2]) add('宿主 runtimeDir', () => sharpFromDir(process.argv[2]))

  // 不同启动方式下 runtimeDir 的位置可能变；把 argv 里看起来像目录的路径都试一遍。
  for (let i = 1; i < process.argv.length; i++) {
    const raw = String(process.argv[i] || '')
    if (!raw) continue
    try {
      if (existsSync(raw) && statSync(raw).isDirectory()) add('argv 目录 ' + raw, () => sharpFromDir(raw))
    } catch (error) {}
  }

  if (process.cwd()) add('当前目录', () => sharpFromDir(process.cwd()))
  if (process.resourcesPath) {
    for (const root of [
      join(process.resourcesPath, 'app.asar', 'dsh'),
      join(process.resourcesPath, 'app.asar.unpacked', 'dsh'),
      join(process.resourcesPath, 'app.asar'),
      join(process.resourcesPath, 'app.asar.unpacked'),
      join(process.resourcesPath, 'runtime'),
    ]) {
      add('resources ' + root, () => sharpFromDir(root))
    }
  }
  add('已加载模块缓存', sharpFromCache)

  for (const probe of probes) {
    try {
      const s = probe.fn()
      if (s) {
        sharpSource = probe.label
        return s
      }
    } catch (error) {}
  }
  return null
}

const sharp = loadSharp()
diag('sharp：' + (sharp
  ? '已加载（' + sharpSource + '）'
  : '没找到；GIF 只取首帧，大图交给 DSH 归一化，图片不会因此丢失'))
let gifWarned = false

const DEFAULT_GROUPS = []
const DEFAULT_CFG = {
  napCat: 'http://127.0.0.1:3000',
  accessToken: '',
  targetSession: '',
  groups: DEFAULT_GROUPS,
  historyCount: 30,
  maxHistoryCount: 50,
  pollMs: 5000,
  mentionEnabled: true,
  wsUrl: 'ws://127.0.0.1:3001',
  pokeEnabled: true,
  privateEnabled: true,
  privateUsers: [],
  observationMs: 60000,
  timeoutMs: 6000,
}

function diag(msg) {
  try {
    appendFileSync(DIAG_PATH, new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch (error) {}
}


function clean(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

function ensureCfg() {
  try {
    if (existsSync(CFG_PATH)) return
    mkdirSync(DSH_HOME, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2), 'utf8')
    diag('已创建配置：' + CFG_PATH)
  } catch (error) {}
}

function loadCfg() {
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    const out = { ...DEFAULT_CFG, ...(raw && typeof raw === 'object' ? raw : {}) }
    out.groups = Array.isArray(out.groups) ? out.groups.map((x) => Number(x)).filter(Number.isFinite) : DEFAULT_GROUPS
    out.napCat = String(out.napCat || DEFAULT_CFG.napCat).replace(/\/+$/, '')
    out.historyCount = Math.max(1, Math.min(Number(out.historyCount) || 30, Number(out.maxHistoryCount) || 50))
    out.maxHistoryCount = Math.max(out.historyCount, Math.min(Number(out.maxHistoryCount) || 50, 100))
    out.pollMs = Math.max(2000, Math.min(Number(out.pollMs) || 5000, 60000))
    out.timeoutMs = Math.max(1000, Math.min(Number(out.timeoutMs) || 6000, 15000))
    out.mentionEnabled = out.mentionEnabled !== false
    out.wsUrl = String(out.wsUrl || DEFAULT_CFG.wsUrl)
    out.pokeEnabled = out.pokeEnabled !== false
    out.privateEnabled = out.privateEnabled !== false
    out.privateUsers = Array.isArray(out.privateUsers) ? out.privateUsers.map((x) => Number(x)).filter(Number.isFinite) : []
    out.observationMs = Math.max(30000, Math.min(Number(out.observationMs) || 60000, 600000))
    return out
  } catch (error) {
    return { ...DEFAULT_CFG }
  }
}

// UI 保存挂载会话时只覆盖传进来的字段，其余配置原样保留；先写临时文件再换名，
// 避免写一半留下坏 JSON 让后面所有工具都退回默认配置。
export function saveCfg(patch) {
  ensureCfg()
  let current = {}
  try {
    const raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) current = raw
  } catch (error) {}
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    const tmp = CFG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, CFG_PATH)
  } catch (error) {
    diag('保存配置失败：' + String((error && error.message) || error))
    throw error
  }
  return next
}

function targetSessionId() {
  const cfg = loadCfg()
  return String(cfg.targetSession || '')
}

function sessionIdOf(agent) {
  try {
    const s = agent && agent.session
    return String((s && (s.id || s.sessionId)) || (agent && agent.id) || '')
  } catch (error) {
    return ''
  }
}

function findAgent(agents, id) {
  const raw = String(id || '').trim()
  if (!raw) return undefined
  const candidates = [raw]
  if (raw.startsWith('session-')) candidates.push(raw.slice('session-'.length))
  else candidates.push('session-' + raw)
  for (const one of candidates) {
    try {
      const a = agents.get(one)
      if (a !== undefined) return a
    } catch (error) {}
  }
  try {
    for (const a of agents.list() || []) {
      const sid = sessionIdOf(a)
      if (sid === raw || 'session-' + sid === raw || sid === raw.replace(/^session-/, '')) return a
    }
  } catch (error) {}
  return undefined
}


// ---------- 目标会话 UI 接口（由「挂载会话」组件启动） ----------
// 浏览器半侧只读写 targetSession：GET 返回当前值和活着的会话，POST 写回配置文件；
// 其他组件仍然每 3 秒 loadCfg()，所以保存后不需要重启。
const TARGET_SESSION_ROUTE = '/api/dsh-qq-tools/target-session'

function replyJson(res, status, body) {
  const text = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  } catch (error) {}
}

async function readRequestJson(req, max = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > max) throw new Error('body too large')
    chunks.push(buf)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sameOriginRequest(req) {
  const origin = String((req.headers && req.headers.origin) || '')
  if (!origin) return true
  try {
    return new URL(origin).host === String((req.headers && req.headers.host) || '')
  } catch (error) {
    return false
  }
}

export function mountTargetSessionRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    diag('挂载会话：宿主没有 webServer，设置页接口不可用')
    return
  }
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: TARGET_SESSION_ROUTE,
      handler: async (req, res) => {
        if (!sameOriginRequest(req)) {
          replyJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const method = String(req.method || 'GET').toUpperCase()
        if (method === 'GET') {
          const liveSessionIds = []
          try {
            const agents = ctx.get('agents') || ctx.agents
            for (const agent of (agents && agents.list()) || []) {
              const sid = sessionIdOf(agent)
              if (sid) liveSessionIds.push(sid)
            }
          } catch (error) {}
          replyJson(res, 200, { ok: true, targetSession: targetSessionId(), liveSessionIds })
          return
        }
        if (method !== 'POST') {
          replyJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        let body
        try {
          body = await readRequestJson(req)
        } catch (error) {
          replyJson(res, 400, { ok: false, error: 'invalid body' })
          return
        }
        const raw = body && typeof body.targetSession === 'string' ? body.targetSession : ''
        const targetSession = clean(raw).slice(0, 200)
        try {
          saveCfg({ targetSession })
        } catch (error) {
          replyJson(res, 500, { ok: false, error: 'save failed' })
          return
        }
        diag('目标会话已更新：' + (targetSession || '（不挂载）'))
        replyJson(res, 200, { ok: true, targetSession })
      },
    })
    return () => {
      try { dispose() } catch (error) {}
    }
  }, 'qq-tools: target session route')
}

function allowedGroup(groupId, cfg) {
  if (!Array.isArray(cfg.groups) || cfg.groups.length === 0) return true
  return cfg.groups.includes(Number(groupId))
}

function allowedPrivate(userId, cfg) {
  if (!Array.isArray(cfg.privateUsers) || cfg.privateUsers.length === 0) return true
  return cfg.privateUsers.includes(Number(userId))
}

async function onebot(action, body, cfg) {
  const base = String(cfg.napCat || '').replace(/\/+$/, '')
  if (!base) throw new Error('没有配置 OneBot 地址')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('OneBot 请求超时')), cfg.timeoutMs || 6000)
  try {
    const headers = { 'content-type': 'application/json' }
    if (cfg.accessToken) headers.authorization = 'Bearer ' + cfg.accessToken
    const r = await fetch(base + '/' + action, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    })
    const text = await r.text()
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new Error('OneBot 返回不是 JSON：' + text.slice(0, 200))
    }
    if (!r.ok) throw new Error('OneBot HTTP ' + r.status + '：' + text.slice(0, 200))
    if (data && data.status && data.status !== 'ok') {
      throw new Error('OneBot 错误：' + String(data.message || data.wording || ('retcode ' + data.retcode)))
    }
    return data && data.data !== undefined ? data.data : data
  } finally {
    clearTimeout(timer)
  }
}

function segText(segs) {
  const list = Array.isArray(segs) ? segs : []
  let media = 0
  return clean(list
    .map((s) => {
      if (!s) return ''
      if (s.type === 'text') return String((s.data && s.data.text) || '')
      if (s.type === 'at') {
        const qq = s.data && s.data.qq
        return '@' + (qq === 'all' ? '全体' : String((s.data && s.data.name) || qq || ''))
      }
      if (s.type === 'image') return '[图片#' + (media++) + ']'
      if (s.type === 'mface') return '[表情包#' + (media++) + ']'
      if (s.type === 'face') {
        const id = s.data && s.data.id
        return id != null && id !== '' ? '[表情:' + id + ']' : '[表情]'
      }
      return ''
    })
    .join(''))
}

// 这里只做「优先展示动图」的排序提示，不决定 mediaType。
// QQ 的 [动画表情] 摘要经常贴在静态 PNG/JPEG 上，所以别再信 summary 里的「动画」；
// 真正是不是 GIF 由后面按字节嗅探，只有 mface 和 .gif 扩展名算动图候选。
function animatedSeg(seg) {
  if (!seg || !seg.data) return false
  if (seg.type === 'mface') return true
  const d = seg.data
  return /\.gif(?:[?#]|$)/i.test(String(d.file || '')) || /\.gif(?:[?#]|$)/i.test(String(d.url || ''))
}

function fmtTime(sec) {
  const t = Number(sec)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function senderName(m) {
  const s = (m && m.sender) || {}
  return clean(s.card || s.nickname || s.user_id || (m && m.user_id) || '?')
}

function senderId(m) {
  const s = (m && m.sender) || {}
  return clean(s.user_id || (m && m.user_id) || '')
}


function renderTool(_args, v) {
  if (!v || !v.ok) return [{ type: 'text', text: 'QQ 工具失败：' + String((v && v.error) || '未知错误') }]
  if (Array.isArray(v.groups)) {
    if (!v.groups.length) return [{ type: 'text', text: '现在没有允许查看的群。' }]
    return [{ type: 'text', text: '可以去的群：\n' + v.groups.map((g) => `- ${g.name || g.id}（群号 ${g.id}，${g.member_count} 人）`).join('\n') }]
  }
  if (Array.isArray(v.friends)) {
    if (!v.friends.length) return [{ type: 'text', text: v.query ? '没有匹配的好友。' : '好友列表是空的。' }]
    const lines = v.friends.map((f) => `- ${f.remark || f.nickname || f.user_id}（${f.nickname || ''}，QQ ${f.user_id}）`)
    return [{ type: 'text', text: `你的好友（${v.total} 个）：\n` + lines.join('\n') }]
  }
  if (Array.isArray(v.messages)) {
    const where = v.group_id != null ? `群 ${v.group_id}` : `QQ ${v.user_id}`
    if (!v.messages.length) return [{ type: 'text', text: `${where} 最近没有消息。` }]
    const lines = v.messages.map((m) => `${m.t || ''} [#${m.message_id || '?'}] ${m.sender}(${m.user_id})：${m.text || '（空）'}`)
    const blocks = [{ type: 'text', text: `${where} 最近 ${v.count} 条：\n` + lines.join('\n') }]
    if (Array.isArray(v.images) && v.images.length) {
      blocks.push({ type: 'text', text: '下面是这些图片（按消息顺序）：' })
      for (const img of v.images) {
        if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
        if (img && img.block) blocks.push(img.block)
      }
    }
    return blocks
  }
  if (Array.isArray(v.members)) {
    const lines = v.members.map((m) => `- ${m.card || m.nickname || m.user_id}（QQ ${m.user_id}，${m.role || 'member'}）`)
    return [{ type: 'text', text: `群 ${v.group_id} 成员：\n` + (lines.join('\n') || '（空）') }]
  }
  if (v.poke) {
    return [{ type: 'text', text: `戳回去了：${v.group_id ? '群 ' + v.group_id : '私聊'} QQ ${v.user_id}。` }]
  }
  if (v.group_id != null && v.message_id != null) {
    return [{ type: 'text', text: `已发到群 ${v.group_id}（消息 ${v.message_id || '?'}）。` }]
  }
  if (v.user_id != null && v.message_id != null) {
    return [{ type: 'text', text: `已发给 QQ ${v.user_id}（消息 ${v.message_id || '?'}）。` }]
  }
  return [{ type: 'text', text: JSON.stringify(v).slice(0, 2000) }]
}


function listOf(data, key) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[key])) return data[key]
  return []
}

export function makeListTool() {
  return {
    name: 'qq_list_groups',
    description:
      '看看你所在的 QQ 群。返回允许你查看/发言的群号、群名、人数。' +
      '群聊里想说话时先用这个挑群；群号可以直接传给 qq_get_group_history / qq_send_group_message。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute() {
      const cfg = loadCfg()
      try {
        const data = await onebot('get_group_list', {}, cfg)
        const groups = (Array.isArray(data) ? data : [])
          .map((g) => ({
            id: Number(g.group_id),
            name: clean(g.group_name || g.group_id || ''),
            member_count: Number(g.member_count || 0),
          }))
          .filter((g) => Number.isFinite(g.id) && allowedGroup(g.id, cfg))
        return { ok: true, groups }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看群列表失败：' + String((v && v.error) || '未知错误') }]
      if (!v.groups.length) return [{ type: 'text', text: '现在没有允许查看的群。' }]
      return [{
        type: 'text',
        text: '可以去的群：\n' + v.groups.map((g) => `- ${g.name || g.id}（群号 ${g.id}，${g.member_count} 人）`).join('\n'),
      }]
    },
  }
}


// ---------- 图片类型与尺寸 ----------
// DSH 附件层按真实字节复核 mediaType（IMAGE_TYPE_MISMATCH），文件名和 QQ 的
// animated 提示都可能撒谎，所以只信字节。大图不依赖 sharp：DSH 默认单张源图
// 上限 20MiB、归一化目标 4MiB，直接交给它处理；sharp 只用于 GIF 拆帧和
// admit 被尺寸拒绝后的兜底重编码。
const ADMIT_IMAGE_LIMIT = 6
const IMAGE_SOFT_LIMIT = 4 * 1024 * 1024
const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

async function sharpImageType(bytes) {
  if (!sharp) return ''
  try {
    const meta = await sharp(bytes, { animated: true }).metadata()
    return IMAGE_MEDIA_TYPES[String((meta && meta.format) || '').toLowerCase()] || ''
  } catch (error) {
    return ''
  }
}

// DSH 只收 png/jpeg/webp/gif；sharp 能解的其他格式（TIFF 等）先转成它认识的格式。
async function convertImage(bytes) {
  if (!sharp) return null
  try {
    const meta = await sharp(bytes).metadata()
    const hasAlpha = !!meta.hasAlpha
    const out = hasAlpha
      ? await sharp(bytes).webp({ quality: 82 }).toBuffer()
      : await sharp(bytes).jpeg({ quality: 82 }).toBuffer()
    return { bytes: out, mediaType: hasAlpha ? 'image/webp' : 'image/jpeg' }
  } catch (error) {
    return null
  }
}

// 大图不丢：超过 DSH 归一化目标就先缩到 2048 长边并重编码，通常能压到 1MiB 以内。
async function shrinkImage(bytes) {
  if (!sharp || !bytes || !bytes.length) return null
  try {
    const meta = await sharp(bytes, { animated: false }).metadata()
    const width = Number(meta && meta.width) || 0
    const height = Number(meta && meta.height) || 0
    if (!width || !height) return null
    const hasAlpha = !!meta.hasAlpha
    const scale = Math.min(1, 2048 / Math.max(width, height))
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))
    for (const quality of [82, 70, 58]) {
      const pipeline = sharp(bytes, { animated: false })
        .rotate()
        .resize({ width: targetWidth, height: targetHeight, fit: 'inside', withoutEnlargement: true })
      const out = hasAlpha
        ? await pipeline.webp({ quality }).toBuffer()
        : await pipeline.jpeg({ quality }).toBuffer()
      if (out.length <= IMAGE_SOFT_LIMIT) {
        return { bytes: out, mediaType: hasAlpha ? 'image/webp' : 'image/jpeg' }
      }
    }
  } catch (error) {}
  return null
}


async function gifFrames(bytes, max = 3) {
  if (!sharp || !bytes || !bytes.length) return null
  try {
    const meta = await sharp(bytes, { animated: true }).metadata()
    const pages = Number(meta.pages || 1)
    if (!(pages > 1)) return null
    const indices = pages <= max
      ? Array.from({ length: pages }, (_, i) => i)
      : [0, Math.floor((pages - 1) / 2), pages - 1]
    const out = []
    for (const i of indices) {
      try {
        const buf = await sharp(bytes, { page: i, pages: 1 })
          .resize({ width: 1024, withoutEnlargement: true })
          .png()
          .toBuffer()
        if (buf && buf.length) out.push({ bytes: buf, page: i + 1, pages })
      } catch (error) {}
    }
    return out.length ? out : null
  } catch (error) {
    return null
  }
}

async function imageBytes(data, cfg) {
  const d = data || {}
  const url = String(d.url || '').trim()
  if (/^https?:/i.test(url)) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      try {
        const r = await fetch(url, { signal: ctrl.signal })
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {}
  }
  const file = String(d.file || '').trim()
  if (file.startsWith('base64://')) {
    try { return Buffer.from(file.slice('base64://'.length), 'base64') } catch (error) {}
  }
  if (/^https?:/i.test(file)) {
    try {
      const r = await fetch(file)
      if (r.ok) return Buffer.from(await r.arrayBuffer())
    } catch (error) {}
  }
  if (file && (file.includes('/') || file.includes('\\'))) {
    try { return readFileSync(file) } catch (error) {}
  }
  if (file) {
    try {
      const info = await onebot('get_image', { file }, cfg)
      const u = String((info && (info.url || info.file)) || '').trim()
      if (/^https?:/i.test(u)) {
        const r = await fetch(u)
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      }
      if (u && (u.includes('/') || u.includes('\\'))) {
        try { return readFileSync(u) } catch (error) {}
      }
    } catch (error) {}
  }
  return null
}

function admitErrorText(error) {
  if (!error) return '未知错误'
  return (error.code ? String(error.code) + '：' : '') + String(error.message || error)
}

// 单张被拒时可以重编码再试；批量/存储层错误重试没有意义。
const RETRYABLE_IMAGE_ERRORS = new Set([
  'IMAGE_TYPE_MISMATCH',
  'INVALID_IMAGE',
  'UNSUPPORTED_IMAGE_TYPE',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
])

async function admitOneImage(attachments, block) {
  try {
    const out = await attachments.admitPromptContent([block])
    const hit = (Array.isArray(out) ? out : []).find((x) => x && x.type === 'image')
    return hit ? { block: hit } : { error: new Error('附件层没有返回图片') }
  } catch (error) {
    return { error }
  }
}

async function retryImageBlock(block) {
  let bytes
  try {
    bytes = Buffer.from(String((block && block.data) || ''), 'base64')
  } catch (error) {
    return null
  }
  if (!bytes || !bytes.length) return null
  const type = sniffImageType(bytes)
  const fixed = type ? await shrinkImage(bytes) : await convertImage(bytes)
  if (!fixed) return null
  return { ...block, data: fixed.bytes.toString('base64'), mediaType: fixed.mediaType }
}

// 一张坏图不能拖垮整批：先整批送，失败后退回逐张，逐张失败的再重编码试一次。
async function admitPreparedImages(attachments, prepared) {
  const blocks = prepared.map((x) => x.block)
  try {
    const out = await attachments.admitPromptContent(blocks)
    const images = (Array.isArray(out) ? out : []).filter((x) => x && x.type === 'image')
    if (images.length === blocks.length) {
      return images.map((block, i) => ({ caption: prepared[i].caption, block }))
    }
    diag('图片 admit 返回数量不符（' + images.length + '/' + blocks.length + '），改为逐张处理')
  } catch (error) {
    diag('图片批量 admit 失败，改为逐张重试：' + admitErrorText(error))
  }
  const admitted = []
  let firstError = ''
  for (const item of prepared) {
    let result = await admitOneImage(attachments, item.block)
    if (result.error && RETRYABLE_IMAGE_ERRORS.has(String(result.error.code || ''))) {
      const retried = await retryImageBlock(item.block)
      if (retried) result = await admitOneImage(attachments, retried)
    }
    if (result.block) admitted.push({ caption: item.caption, block: result.block })
    else if (!firstError) firstError = admitErrorText(result.error)
  }
  if (firstError && admitted.length < prepared.length) {
    diag('有图片没能进来（已跳过，其余保留）：' + firstError)
  }
  return admitted
}

export function admitImagesFor(ctx) {
  return async function admitImages(list) {
    const attachments = ctx.attachments || (typeof ctx.get === 'function' ? ctx.get('attachments') : null)
    if (!attachments || typeof attachments.admitPromptContent !== 'function') return []
    const prepared = []
    for (const x of Array.isArray(list) ? list : []) {
      if (prepared.length >= ADMIT_IMAGE_LIMIT) break
      let bytes = await imageBytes(x.data, x.cfg || loadCfg())
      if (!bytes || !bytes.length) continue
      const name = String(x.name || 'qq-image.jpg')
      // animated 只是提示，type 一律按字节来；猜错会被 DSH 按 IMAGE_TYPE_MISMATCH 整批拒掉。
      let mediaType = sniffImageType(bytes) || (await sharpImageType(bytes))
      if (!mediaType) {
        const converted = await convertImage(bytes)
        if (!converted) {
          diag('图片跳过：认不出格式（' + name + '）')
          continue
        }
        bytes = converted.bytes
        mediaType = converted.mediaType
      }
      if (mediaType === 'image/gif') {
        const frames = await gifFrames(bytes, 3)
        if (frames) {
          for (const f of frames) {
            prepared.push({
              caption: String(x.caption || '') + `（GIF 第 ${f.page}/${f.pages} 帧）`,
              block: {
                type: 'image',
                data: f.bytes.toString('base64'),
                mediaType: 'image/png',
                name: name.replace(/\.[^.]+$/, '') + `-gif-${f.page}.png`,
              },
            })
            if (prepared.length >= ADMIT_IMAGE_LIMIT) break
          }
          continue
        }
        if (!sharp && !gifWarned) {
          gifWarned = true
          diag('GIF 帧拆分不可用：没有加载到 sharp，动图会按静图处理')
        }
      }
      // 大图不在这里预缩放：DSH 自己会把源图归一化到 4MiB，20MiB 以内都能收。
      // 只有 admit 因尺寸被拒时才在 retryImageBlock 里用 sharp 兜底重编码。
      prepared.push({
        caption: String(x.caption || ''),
        block: { type: 'image', data: bytes.toString('base64'), mediaType, name },
      })
    }
    if (!prepared.length) return []
    return admitPreparedImages(attachments, prepared)
  }
}

export function makeHistoryTool(admitImages) {
  return {
    name: 'qq_get_group_history',
    description:
      '看某个群最近的聊天记录（只读）。默认最近 30 条，最多 50 条。' +
      '主动搭话或有人 @ 你时，可以用它看 2~3 个群，再决定要不要说话、在哪个群说。' +
      '群号从 qq_list_groups 或 @ 提醒里拿。消息前面的 #编号 是 message_id，' +
      '可以用 qq_send_face 回复，或用 qq_favorite_face 收藏消息里的图片。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号' },
        count: { type: 'number', description: '看最近多少条，默认 30，最多 50' },
        include_images: { type: 'boolean', description: '要不要把最近的图片也给你看（最多 4 张，默认 true）' },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const groupId = Number(args && args.group_id)
      if (!Number.isFinite(groupId)) return { ok: false, error: 'group_id 不是有效群号' }
      if (!allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      const count = Math.max(1, Math.min(Number(args && args.count) || cfg.historyCount, cfg.maxHistoryCount))
      try {
        const data = await onebot('get_group_msg_history', { group_id: groupId, count }, cfg)
        const raw = listOf(data, 'messages')
        const messages = raw
          .map((m) => ({
            time: Number(m.time || 0),
            t: fmtTime(m.time),
            sender: senderName(m),
            user_id: senderId(m),
            text: segText(m.message),
            message_id: m.message_id,
          }))
          .sort((a, b) => a.time - b.time)
        let images = []
        if (args && args.include_images !== false) {
          const picked = []
          for (const m of raw.slice().sort((a, b) => (a.time || 0) - (b.time || 0))) {
            const segs = Array.isArray(m.message) ? m.message : []
            for (const seg of segs) {
              if (!seg || (seg.type !== 'image' && seg.type !== 'mface') || !seg.data) continue
              picked.push({ m, seg, animated: animatedSeg(seg) })
            }
          }
          const anim = picked.filter((x) => x.animated).slice(-2)
          const stat = picked.filter((x) => !x.animated).slice(-2)
          const last = [...anim, ...stat].slice(0, 4)
          if (last.length && typeof admitImages === 'function') {
            images = await admitImages(last.map(({ m, seg, animated }, i) => ({
              data: seg.data,
              cfg,
              animated,
              name: (seg.data && seg.data.file) || `qq-${m.message_id || 'x'}-${i}.jpg`,
              caption: `群 ${groupId} ${senderName(m)} 发的图片（消息 ${m.message_id || '?'}）`,
            })))
          }
        }
        return { ok: true, group_id: groupId, count: messages.length, messages, images }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看群记录失败：' + String((v && v.error) || '未知错误') }]
      if (!v.messages.length) return [{ type: 'text', text: `群 ${v.group_id} 最近没有消息。` }]
      const lines = v.messages.map((m) => `${m.t || ''} [#${m.message_id || '?'}] ${m.sender}(${m.user_id})：${m.text || '（空）'}`)
      return [{ type: 'text', text: `群 ${v.group_id} 最近 ${v.count} 条：\n` + lines.join('\n') }]
    },
  }
}

export function makeMembersTool() {
  return {
    name: 'qq_get_group_members',
    description: '看看某个群的成员（昵称、群名片、QQ 号、身份）。需要知道谁是谁时用。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号' },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const groupId = Number(args && args.group_id)
      if (!Number.isFinite(groupId)) return { ok: false, error: 'group_id 不是有效群号' }
      if (!allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      try {
        const data = await onebot('get_group_member_list', { group_id: groupId }, cfg)
        const members = listOf(data, 'members').slice(0, 100).map((m) => ({
          user_id: String(m.user_id || ''),
          nickname: String(m.nickname || ''),
          card: String(m.card || ''),
          role: String(m.role || ''),
        }))
        return { ok: true, group_id: groupId, members }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看群成员失败：' + String((v && v.error) || '未知错误') }]
      const lines = v.members.map((m) => `- ${m.card || m.nickname || m.user_id}（QQ ${m.user_id}，${m.role || 'member'}）`)
      return [{ type: 'text', text: `群 ${v.group_id} 成员：\n` + (lines.join('\n') || '（空）') }]
    },
  }
}

export function makeSendTool(onSent) {
  return {
    name: 'qq_send_group_message',
    description:
      '在指定群里发一条消息。发之前先确认群号；只发到允许的群。' +
      '普通闲聊不要用 Markdown；一句话短一点，像群友随手打的。' +
      '不想说话就不要调用这个工具；调用后不要再重复说自己发了什么。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号' },
        message: { type: 'string', description: '要发到群里的文字，不要 Markdown' },
      },
      required: ['group_id', 'message'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const groupId = Number(args && args.group_id)
      const text = String((args && args.message) || '').trim()
      if (!Number.isFinite(groupId)) return { ok: false, error: 'group_id 不是有效群号' }
      if (!text) return { ok: false, error: '消息是空的' }
      if (!allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      try {
        const data = await onebot(
          'send_group_msg',
          { group_id: groupId, message: [{ type: 'text', data: { text: text.slice(0, 1000) } }] },
          cfg,
        )
        try { if (typeof onSent === 'function') onSent(groupId, '发群消息') } catch (error) {}
        return { ok: true, group_id: groupId, message_id: data && data.message_id }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '发群消息失败：' + String((v && v.error) || '未知错误') }]
      return [{ type: 'text', text: `已发到群 ${v.group_id}（消息 ${v.message_id || '?'}）。` }]
    },
  }
}


// ---------- 私聊：好友列表 / 私聊记录 / 发私聊消息 ----------
export function makeListFriendsTool() {
  return {
    name: 'qq_list_friends',
    description:
      '看看你的 QQ 好友列表。想私聊谁时先用这个拿 QQ 号；可以按昵称、备注或 QQ 号搜。' +
      '私聊消息唤醒里也会直接给出发送者的 QQ 号。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按昵称、备注或 QQ 号模糊找；不传就列全部' },
        count: { type: 'number', description: '最多列多少个，默认 100，最多 500' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const q = String((args && args.query) || '').trim().toLowerCase()
      const count = Math.max(1, Math.min(Number(args && args.count) || 100, 500))
      try {
        const data = await onebot('get_friend_list', {}, cfg)
        const friends = (Array.isArray(data) ? data : [])
          .map((f) => ({
            user_id: String(f.user_id || ''),
            nickname: clean(f.nickname),
            remark: clean(f.remark),
          }))
          .filter((f) => f.user_id && allowedPrivate(f.user_id, cfg))
          .filter((f) => !q || (f.nickname + ' ' + f.remark + ' ' + f.user_id).toLowerCase().includes(q))
        return { ok: true, query: q, total: friends.length, friends: friends.slice(0, count) }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看好友列表失败：' + String((v && v.error) || '未知错误') }]
      if (!v.friends.length) return [{ type: 'text', text: v.query ? '没有匹配的好友。' : '好友列表是空的。' }]
      const lines = v.friends.map((f) => `- ${f.remark || f.nickname || f.user_id}（${f.nickname || ''}，QQ ${f.user_id}）`)
      const more = v.total > v.friends.length ? `，只列了前 ${v.friends.length} 个` : ''
      return [{ type: 'text', text: `你的好友（${v.total} 个${more}）：\n` + lines.join('\n') }]
    },
  }
}

export function makePrivateHistoryTool(admitImages) {
  return {
    name: 'qq_get_private_history',
    description:
      '看和某个 QQ 好友的私聊记录（只读）。默认最近 30 条，最多 50 条。' +
      '消息前面的 #编号 是 message_id，可以用于回复或收藏图片。' +
      'user_id 从 qq_list_friends 或私聊唤醒提示里拿。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '对方的 QQ 号' },
        count: { type: 'number', description: '看最近多少条，默认 30，最多 50' },
        include_images: { type: 'boolean', description: '要不要把最近的图片也给你看（最多 4 张，默认 true）' },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      const count = Math.max(1, Math.min(Number(args && args.count) || cfg.historyCount, cfg.maxHistoryCount))
      try {
        const data = await onebot('get_friend_msg_history', { user_id: userId, count }, cfg)
        const raw = listOf(data, 'messages')
        if (!selfId) {
          try {
            const info = await onebot('get_login_info', {}, cfg)
            selfId = String((info && info.user_id) || '')
          } catch (error) {}
        }
        const messages = raw
          .map((m) => {
            const uid = senderId(m)
            const isSelf = !!selfId && uid === selfId
            return {
              time: Number(m.time || 0),
              t: fmtTime(m.time),
              sender: isSelf ? '我' : senderName(m),
              user_id: uid,
              self: isSelf,
              text: segText(m.message),
              message_id: m.message_id,
            }
          })
          .sort((a, b) => a.time - b.time)
        let images = []
        if (args && args.include_images !== false) {
          const picked = []
          for (const m of raw.slice().sort((a, b) => (a.time || 0) - (b.time || 0))) {
            const segs = Array.isArray(m.message) ? m.message : []
            for (const seg of segs) {
              if (!seg || (seg.type !== 'image' && seg.type !== 'mface') || !seg.data) continue
              picked.push({ m, seg, animated: animatedSeg(seg) })
            }
          }
          const anim = picked.filter((x) => x.animated).slice(-2)
          const stat = picked.filter((x) => !x.animated).slice(-2)
          const last = [...anim, ...stat].slice(0, 4)
          if (last.length && typeof admitImages === 'function') {
            images = await admitImages(last.map(({ m, seg, animated }, i) => ({
              data: seg.data,
              cfg,
              animated,
              name: (seg.data && seg.data.file) || `qq-private-${m.message_id || 'x'}-${i}.jpg`,
              caption: `私聊 ${senderName(m)} 发的图片（消息 ${m.message_id || '?'}）`,
            })))
          }
        }
        return { ok: true, user_id: userId, count: messages.length, messages, images }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看私聊记录失败：' + String((v && v.error) || '未知错误') }]
      if (!v.messages.length) return [{ type: 'text', text: `和 QQ ${v.user_id} 最近没有消息。` }]
      const lines = v.messages.map((m) => `${m.t || ''} [#${m.message_id || '?'}] ${m.sender}(${m.user_id})：${m.text || '（空）'}`)
      const blocks = [{ type: 'text', text: `和 QQ ${v.user_id} 最近 ${v.count} 条：\n` + lines.join('\n') }]
      for (const img of Array.isArray(v.images) ? v.images : []) {
        if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
        if (img && img.block) blocks.push(img.block)
      }
      return blocks
    },
  }
}

export function makeSendPrivateTool() {
  return {
    name: 'qq_send_private_message',
    description:
      '给某个 QQ 好友发一条私聊消息。user_id 从 qq_list_friends 或私聊唤醒提示里拿。' +
      '普通闲聊不要用 Markdown；一句话短一点，像聊天一样。' +
      '不想说话就不要调用；调用后不要再重复说自己发了什么。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '对方的 QQ 号' },
        message: { type: 'string', description: '要发的文字，不要 Markdown' },
        reply_to: { type: 'string', description: '要回复的消息 ID，可选' },
        group_id: { type: 'number', description: '临时会话的来源群号，可选；普通好友私聊不用传' },
      },
      required: ['user_id', 'message'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      const text = String((args && args.message) || '').trim()
      const groupId = args && args.group_id != null ? Number(args.group_id) : 0
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!text) return { ok: false, error: '消息是空的' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      try {
        const message = []
        const replyTo = args && args.reply_to
        if (replyTo != null && replyTo !== '') message.push({ type: 'reply', data: { id: String(replyTo) } })
        message.push({ type: 'text', data: { text: text.slice(0, 1000) } })
        const body = { user_id: userId, message }
        if (groupId) body.group_id = groupId
        const data = await onebot('send_private_msg', body, cfg)
        return { ok: true, user_id: userId, message_id: data && data.message_id }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '发私聊消息失败：' + String((v && v.error) || '未知错误') }]
      return [{ type: 'text', text: `已发给 QQ ${v.user_id}（消息 ${v.message_id || '?'}）。` }]
    },
  }
}


// ---------- 表情：系统表情编号表 + SnowLuma 收藏表情 ----------
// 发表情走 OneBot 11 的 face 段，SnowLuma 会按表情目录自动选 classic / small / super 编码。
// 收藏表情走 SnowLuma 的自定义表情扩展接口：
//   fetch_custom_face_detail / add_custom_face / delete_custom_face /
//   modify_custom_face / move_custom_face_to_front / send_custom_face
// 这些接口 NapCat 没有；读不到时只影响收藏表情，系统表情照常可用。
const COMMON_FACES = [
  [0, '惊讶'], [1, '撇嘴'], [2, '色'], [3, '发呆'], [4, '得意'], [5, '流泪'], [6, '害羞'],
  [7, '闭嘴'], [8, '睡'], [9, '大哭'], [10, '尴尬'], [11, '发怒'], [12, '调皮'], [13, '呲牙'],
  [14, '微笑'], [15, '难过'], [16, '酷'], [17, '抓狂'], [18, '吐'], [19, '偷笑'], [20, '可爱'],
  [21, '白眼'], [22, '傲慢'], [23, '饥饿'], [24, '困'], [25, '惊恐'], [26, '流汗'], [27, '憨笑'],
  [28, '大兵'], [29, '奋斗'], [30, '咒骂'], [31, '疑问'], [32, '嘘'], [33, '晕'], [34, '折磨'],
  [35, '衰'], [36, '骷髅'], [37, '敲打'], [38, '再见'], [39, '擦汗'], [40, '抠鼻'], [41, '鼓掌'],
  [42, '糗大了'], [43, '坏笑'], [44, '左哼哼'], [45, '右哼哼'], [46, '哈欠'], [47, '鄙视'],
  [48, '委屈'], [49, '快哭了'], [50, '阴险'], [51, '亲亲'], [52, '吓'], [53, '可怜'], [54, '菜刀'],
  [55, '西瓜'], [56, '啤酒'], [57, '篮球'], [58, '乒乓'], [59, '咖啡'], [60, '饭'], [61, '猪头'],
  [62, '玫瑰'], [63, '凋谢'], [64, '示爱'], [65, '爱心'], [66, '心碎'], [67, '蛋糕'], [68, '闪电'],
  [69, '炸弹'], [70, '刀'], [71, '足球'], [72, '瓢虫'], [73, '便便'], [74, '月亮'], [75, '太阳'],
  [76, '礼物'], [77, '拥抱'], [78, '强'], [79, '弱'], [80, '握手'], [81, '胜利'], [82, '抱拳'],
  [83, '勾引'], [84, '拳头'], [85, '差劲'], [86, '爱你'], [87, 'NO'], [88, 'OK'], [89, '爱情'],
  [90, '飞吻'], [91, '跳跳'], [92, '发抖'], [93, '怄火'], [94, '转圈'], [95, '磕头'], [96, '回头'],
  [97, '跳绳'], [98, '挥手'], [99, '激动'], [100, '街舞'], [101, '献吻'], [102, '左太极'],
  [103, '右太极'], [104, '双喜'], [105, '鞭炮'], [106, '灯笼'], [107, '发财'], [108, 'K歌'],
  [109, '购物'], [110, '邮件'], [111, '帅'], [112, '喝彩'], [113, '祈祷'], [114, '爆筋'],
  [115, '棒棒糖'], [116, '喝奶'], [118, '香蕉'], [119, '飞机'], [120, '开车'], [124, '多云'],
  [125, '下雨'], [126, '钞票'], [127, '熊猫'], [128, '灯泡'], [129, '风车'], [130, '闹钟'],
  [131, '打伞'], [132, '彩球'], [133, '钻戒'], [134, '沙发'], [136, '药'], [137, '手枪'],
  [138, '青蛙'],
].map(([id, name]) => ({ id, name }))

const CUSTOM_FACE_COUNT = 100

function sysFaceOf(entry) {
  const id = Number(entry && entry.q_sid)
  return {
    face_id: Number.isInteger(id) && id >= 0 ? id : null,
    name: clean(entry && (entry.q_des || entry.desc || '')),
    aliases: Array.isArray(entry && entry.emoji_name_alias) ? entry.emoji_name_alias.map(clean).filter(Boolean) : [],
    is_super: !!(entry && entry.is_super),
    url: String((entry && entry.url) || ''),
  }
}

function customFaceOf(entry) {
  return {
    emoji_id: String((entry && (entry.emoji_id || entry.emojiId || entry.resId)) || ''),
    desc: clean(entry && entry.desc),
    md5: String((entry && entry.md5) || ''),
    url: String((entry && entry.url) || ''),
  }
}

async function fetchCustomFaces(cfg, count = CUSTOM_FACE_COUNT) {
  const data = await onebot('fetch_custom_face_detail', { count }, cfg)
  return (Array.isArray(data) ? data : []).map(customFaceOf).filter((f) => f.emoji_id)
}

async function searchSysFaces(cfg, query) {
  const data = await onebot('search_sys_faces', { query }, cfg)
  const faces = Array.isArray(data && data.faces) ? data.faces : []
  return faces.map(sysFaceOf).filter((f) => f.face_id != null)
}

// SnowLuma 的 add_custom_face 只认 file:///、base64://、http(s)://，
// 本机路径要先转成 file:/// URL，data:image/... 转成 base64://。
function imageSourceOf(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^(https?:\/\/|base64:\/\/|file:\/\/)/i.test(s)) return s
  const dataUrl = s.match(/^data:[^;,]*;base64,(.*)$/is)
  if (dataUrl) return 'base64://' + dataUrl[1].replace(/\s+/g, '')
  try {
    if (existsSync(s)) return pathToFileURL(s).href
  } catch (error) {}
  return s
}

export function makeSendFaceTool(onSent) {
  return {
    name: 'qq_send_face',
    description:
      '发一个表情：QQ 系统表情（face_id）或你 QQ 收藏夹里的自定义表情（emoji_id），二选一。' +
      '群聊传 group_id；私聊传 user_id（可选 group_id 表示临时会话来源群）。' +
      'face_id 从 qq_list_faces 按名字搜；emoji_id 从 qq_list_faces 的收藏列表拿。' +
      '可以顺带一句话 text；发收藏表情时文字会单独先发一条。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号；私聊时如果是从群里发起的临时会话，也可以传来源群号' },
        user_id: { type: 'number', description: '对方 QQ 号；传了就是私聊，和只传 group_id 的群聊区分开' },
        face_id: { type: 'number', description: 'QQ 系统表情编号（>=0），和 emoji_id 二选一' },
        emoji_id: { type: 'string', description: 'QQ 收藏表情的 emoji_id（SnowLuma），和 face_id 二选一' },
        text: { type: 'string', description: '跟着表情一起发的文字，可选，不要 Markdown' },
        reply_to: { type: 'string', description: '要回复的消息 ID，可选' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const hasUser = args && args.user_id != null && args.user_id !== ''
      const userId = hasUser ? Number(args.user_id) : 0
      const groupId = args && args.group_id != null && args.group_id !== '' ? Number(args.group_id) : 0
      const hasFace = args && args.face_id != null && args.face_id !== ''
      const faceId = hasFace ? Number(args.face_id) : null
      const emojiId = String((args && args.emoji_id) || '').trim()
      const text = String((args && args.text) || '').trim()
      if (hasUser) {
        if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
        if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
        if (groupId && !allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      } else {
        if (!Number.isFinite(groupId) || !groupId) return { ok: false, error: 'group_id 和 user_id 至少传一个' }
        if (!allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      }
      if (hasFace && emojiId) return { ok: false, error: 'face_id 和 emoji_id 只能二选一' }
      if (!hasFace && !emojiId) return { ok: false, error: 'face_id 和 emoji_id 至少传一个' }
      const target = hasUser
        ? { user_id: userId, ...(groupId ? { group_id: groupId } : {}) }
        : { group_id: groupId }
      try {
        if (hasFace) {
          if (!Number.isInteger(faceId) || faceId < 0 || faceId > 1000000) {
            return { ok: false, error: 'face_id 不是有效表情编号' }
          }
          const message = []
          const replyTo = args && args.reply_to
          if (replyTo != null && replyTo !== '') message.push({ type: 'reply', data: { id: String(replyTo) } })
          if (text) message.push({ type: 'text', data: { text: text.slice(0, 1000) } })
          message.push({ type: 'face', data: { id: String(faceId) } })
          const action = hasUser ? 'send_private_msg' : 'send_group_msg'
          const data = await onebot(action, { ...target, message }, cfg)
          try { if (!hasUser && typeof onSent === 'function') onSent(groupId, '发表情') } catch (error) {}
          return {
            ok: true,
            kind: 'system',
            chat: hasUser ? 'private' : 'group',
            group_id: hasUser ? (groupId || null) : groupId,
            user_id: hasUser ? userId : null,
            message_id: data && data.message_id,
            face_id: faceId,
          }
        }
        let textMessageId = null
        if (text) {
          const action = hasUser ? 'send_private_msg' : 'send_group_msg'
          const t = await onebot(
            action,
            { ...target, message: [{ type: 'text', data: { text: text.slice(0, 1000) } }] },
            cfg,
          )
          textMessageId = t && t.message_id
        }
        const body = { emoji_id: emojiId, ...target }
        const replyTo = args && args.reply_to
        if (replyTo != null && replyTo !== '') body.reply_to = String(replyTo)
        const data = await onebot('send_custom_face', body, cfg)
        try { if (!hasUser && typeof onSent === 'function') onSent(groupId, '发表情') } catch (error) {}
        return {
          ok: true,
          kind: 'custom',
          chat: hasUser ? 'private' : 'group',
          group_id: hasUser ? (groupId || null) : groupId,
          user_id: hasUser ? userId : null,
          message_id: data && data.message_id,
          text_message_id: textMessageId,
          emoji_id: emojiId,
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '发表情失败：' + String((v && v.error) || '未知错误') }]
      const where = v.chat === 'private'
        ? (v.group_id ? '群 ' + v.group_id + ' 的临时会话 QQ ' + v.user_id : 'QQ ' + v.user_id)
        : '群 ' + v.group_id
      if (v.kind === 'custom') {
        const parts = []
        if (v.text_message_id) parts.push('文字已发（消息 ' + v.text_message_id + '）')
        parts.push('收藏表情 ' + v.emoji_id + ' 已发到' + where + '（消息 ' + (v.message_id || '?') + '）')
        return [{ type: 'text', text: parts.join('；') + '。' }]
      }
      return [{ type: 'text', text: `已在${where}发出系统表情 ${v.face_id}（消息 ${v.message_id || '?'}）。` }]
    },
  }
}

export function makeListFacesTool(admitImages) {
  return {
    name: 'qq_list_faces',
    description:
      '看表情：你 QQ 收藏夹里的自定义表情（emoji_id + 备注 + 预览图），以及 QQ 系统表情编号。' +
      '默认给 3 张不同位置的预览；想看指定表情就传 preview（列表序号或 emoji_id，最多 6 张）。' +
      '按名字找系统表情就传 query，比如「笑」「哭」「点赞」。收藏/取消收藏用 qq_favorite_face；发表情用 qq_send_face。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按名字/别名/编号搜系统表情，或按备注搜收藏表情；不传就列收藏夹 + 常用表情' },
        count: { type: 'number', description: '最多列多少个收藏表情，默认 50，最多 200' },
        preview: { type: 'string', description: '想看图的收藏表情：序号（从 1 开始）或 emoji_id，用逗号分隔，最多 6 个；不传就默认看 3 张不同位置的预览' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const q = String((args && args.query) || '').trim().toLowerCase()
      const count = Math.max(1, Math.min(Number(args && args.count) || 50, 200))
      let favorites = []
      let favoritesError = ''
      try {
        favorites = await fetchCustomFaces(cfg, Math.max(count, CUSTOM_FACE_COUNT))
      } catch (error) {
        favoritesError = String((error && error.message) || error)
      }
      const matched = q
        ? favorites.filter((f) => (f.desc + ' ' + f.emoji_id + ' ' + f.md5).toLowerCase().includes(q))
        : favorites
      const previewRaw = String((args && args.preview) || '').trim()
      const previewList = previewRaw ? previewRaw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : []
      const previewIndex = new Map(matched.map((f, i) => [f.emoji_id, i + 1]))
      let picks = []
      if (previewList.length) {
        const seen = new Set()
        for (const want of previewList) {
          let hit = null
          if (/^\d+$/.test(want)) {
            const i = Number(want) - 1
            if (i >= 0 && i < matched.length) hit = matched[i]
          }
          if (!hit) hit = matched.find((f) => f.emoji_id === want) || null
          if (!hit) hit = matched.find((f) => f.md5 && f.md5.toLowerCase() === want.toLowerCase()) || null
          if (hit && !seen.has(hit.emoji_id)) {
            seen.add(hit.emoji_id)
            picks.push(hit)
          }
          if (picks.length >= 6) break
        }
      } else if (matched.length) {
        // 默认不按前几张来，挑开头、中间、结尾三张，让模型先有个整体印象。
        if (matched.length <= 3) picks = matched.slice()
        else picks = [matched[0], matched[Math.floor(matched.length / 2)], matched[matched.length - 1]]
      }
      let images = []
      if (typeof admitImages === 'function') {
        const shown = picks.filter((f) => /^https?:/i.test(f.url))
        if (shown.length) {
          images = await admitImages(shown.map((f) => ({
            data: { url: f.url },
            cfg,
            name: `qq-face-${f.emoji_id}.jpg`,
            caption: `收藏表情 #${previewIndex.get(f.emoji_id) || '?'} ${f.desc || f.emoji_id}`,
          })))
        }
      }
      let sysFaces = []
      let sysSource = 'builtin'
      if (q) {
        try {
          sysFaces = (await searchSysFaces(cfg, q)).slice(0, 30)
          if (sysFaces.length) sysSource = 'snowluma'
        } catch (error) {}
        if (!sysFaces.length) {
          sysFaces = COMMON_FACES
            .filter((f) => f.name.toLowerCase().includes(q) || String(f.id) === q)
            .map((f) => ({ face_id: f.id, name: f.name, aliases: [], is_super: false, url: '' }))
        }
      } else {
        sysFaces = COMMON_FACES.map((f) => ({ face_id: f.id, name: f.name, aliases: [], is_super: false, url: '' }))
      }
      return {
        ok: true,
        query: q,
        favorites: matched.slice(0, count),
        favorites_total: favorites.length,
        favorites_error: favoritesError,
        images,
        preview_requested: previewList,
        preview_matched: picks.map((f) => previewIndex.get(f.emoji_id)).filter(Boolean),
        sys_faces: sysFaces,
        sys_source: sysSource,
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看表情失败：' + String((v && v.error) || '未知错误') }]
      const lines = []
      if (v.favorites.length) {
        lines.push('你 QQ 收藏夹里的表情：')
        v.favorites.forEach((f, i) => {
          lines.push(`${i + 1}. ${f.desc || '（无备注）'}  emoji_id=${f.emoji_id}`)
        })
        if (v.favorites_total > v.favorites.length) {
          lines.push(`（共 ${v.favorites_total} 个，只列了前 ${v.favorites.length} 个）`)
        }
        if (v.preview_requested && v.preview_requested.length && !v.images.length) {
          lines.push('preview 没匹配到可看的收藏表情；序号从 1 开始，也可以直接传 emoji_id。')
        } else {
          lines.push('想看指定表情的图：再调一次 qq_list_faces，preview 传序号或 emoji_id（最多 6 张）。')
        }
      } else if (v.favorites_error) {
        lines.push('收藏表情读不到（SnowLuma 自定义表情接口不可用）：' + String(v.favorites_error).slice(0, 200))
      } else if (!v.query) {
        lines.push('QQ 收藏夹里还没有表情。用 qq_favorite_face 从图片或消息收藏。')
      }
      if (v.sys_faces.length) {
        lines.push(v.query ? '搜到的系统表情（编号 名字）：' : '常用系统表情（编号 名字）：')
        lines.push(v.sys_faces.map((f) => `${f.face_id} ${f.name}${f.is_super ? '（超级表情）' : ''}`).join('，'))
      } else if (v.query) {
        lines.push('没有匹配的系统表情。')
      }
      const blocks = [{ type: 'text', text: lines.join('\n') || '没有匹配的表情，换个词试试。' }]
      for (const img of Array.isArray(v.images) ? v.images : []) {
        if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
        if (img && img.block) blocks.push(img.block)
      }
      return blocks
    },
  }
}

export function makeFavoriteFaceTool() {
  return {
    name: 'qq_favorite_face',
    description:
      '管理你 QQ 账号的收藏表情（SnowLuma）：收藏一张图片、取消收藏、改备注、移到最前。' +
      '收藏来源可以是 http(s) 图片链接、base64://、本机文件路径，或某条消息里的图片（message_id + index）。' +
      'emoji_id 从 qq_list_faces 的收藏列表拿；发表情用 qq_send_face。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要收藏的图片：http(s) 链接、base64:// 或本机文件路径；和 message_id 二选一' },
        message_id: { type: 'string', description: '从这条消息里取图片收藏；和 file 二选一' },
        index: { type: 'number', description: 'message_id 里第几张图片，从 0 开始，默认 0' },
        emoji_id: { type: 'string', description: '已收藏表情的 emoji_id；取消收藏、改备注、移到最前时用' },
        desc: { type: 'string', description: '收藏表情的备注名；收藏时可选，配合 emoji_id 可修改' },
        remove: { type: 'boolean', description: 'true = 取消收藏（需要 emoji_id）' },
        move_to_front: { type: 'boolean', description: 'true = 移到收藏夹最前（需要 emoji_id）' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const emojiId = String((args && args.emoji_id) || '').trim()
      const desc = clean(args && args.desc)
      const remove = args && args.remove === true
      const moveToFront = args && args.move_to_front === true
      if (remove && moveToFront) return { ok: false, error: 'remove 和 move_to_front 只能选一个' }
      try {
        if (remove || moveToFront) {
          if (!emojiId) return { ok: false, error: (remove ? '取消收藏' : '移到最前') + '需要 emoji_id' }
          if (remove) {
            await onebot('delete_custom_face', { emoji_id: emojiId }, cfg)
            return { ok: true, removed: true, emoji_id: emojiId }
          }
          await onebot('move_custom_face_to_front', { emoji_id: emojiId }, cfg)
          return { ok: true, moved: true, emoji_id: emojiId }
        }
        if (emojiId) {
          if (args && args.desc == null) return { ok: false, error: '改备注需要同时传 emoji_id 和 desc' }
          await onebot('modify_custom_face', { emoji_id: emojiId, desc }, cfg)
          return { ok: true, updated: true, emoji_id: emojiId, desc }
        }
        let source = imageSourceOf(args && args.file)
        if (!source && args && args.message_id != null && args.message_id !== '') {
          const msg = await onebot('get_msg', { message_id: args.message_id }, cfg)
          const segs = Array.isArray(msg && msg.message) ? msg.message : []
          const images = segs.filter((s) => s && (s.type === 'image' || s.type === 'mface') && s.data)
          const idx = Number.isInteger(Number(args.index)) ? Math.max(0, Number(args.index)) : 0
          const pick = images[idx]
          if (!pick) {
            return { ok: false, error: `这条消息里没有第 ${idx} 张图片（共 ${images.length} 张）` }
          }
          source = imageSourceOf(pick.data.url || pick.data.file)
          if (!source) return { ok: false, error: '拿不到这条消息里的图片地址' }
        }
        if (!source) return { ok: false, error: '要收藏就传 file 或 message_id' }
        const data = await onebot('add_custom_face', { file: source }, cfg)
        const newId = String((data && (data.emoji_id || data.emojiId || data.resId)) || '')
        let descSet = true
        let warning = ''
        if (desc) {
          if (newId) {
            try {
              await onebot('modify_custom_face', { emoji_id: newId, desc }, cfg)
            } catch (error) {
              descSet = false
              warning = String((error && error.message) || error)
            }
          } else {
            descSet = false
            warning = '没有拿到新表情的 emoji_id，备注未设置'
          }
        }
        return { ok: true, added: true, emoji_id: newId, desc, desc_set: descSet, warning, source }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '收藏表情失败：' + String((v && v.error) || '未知错误') }]
      if (v.removed) return [{ type: 'text', text: `已取消收藏表情 ${v.emoji_id}。` }]
      if (v.moved) return [{ type: 'text', text: `已把表情 ${v.emoji_id} 移到收藏夹最前。` }]
      if (v.updated) return [{ type: 'text', text: `已把表情 ${v.emoji_id} 的备注改成「${v.desc || '空'}」。` }]
      let text = `已收藏表情${v.desc ? '「' + v.desc + '」' : ''}（emoji_id: ${v.emoji_id || '?'}）。`
      if (v.desc && v.desc_set === false) text += ` 备注没设置成功：${String(v.warning || '').slice(0, 200)}`
      return [{ type: 'text', text }]
    },
  }
}


export function makePokeTool(onSent) {
  return {
    name: 'qq_send_poke',
    description:
      '戳一戳某人。群聊传 group_id + user_id；私聊只传 user_id。' +
      '别人戳你时可以戳回去，但别频繁；戳完不用再解释。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '对方的 QQ 号' },
        group_id: { type: 'number', description: '群号；私聊不传' },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      const groupId = args && args.group_id != null ? Number(args.group_id) : 0
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (groupId && !allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      if (!groupId && !allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      try {
        const body = { user_id: userId }
        if (groupId) body.group_id = groupId
        await onebot('send_poke', body, cfg)
        try { if (groupId && typeof onSent === 'function') onSent(groupId, '戳回去') } catch (error) {}
        return { ok: true, poke: true, user_id: userId, group_id: groupId || null }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
  }
}


// ---------- 当前活着的工具组件 ----------
// @ 提醒的提示词只提还开着的工具，免得模型去调一个被关掉的组件。
const activeCounts = new Map()

function markActive(name, delta) {
  const next = Math.max(0, (activeCounts.get(name) || 0) + delta)
  if (next === 0) activeCounts.delete(name)
  else activeCounts.set(name, next)
}

export function hasActiveTool(name) {
  return (activeCounts.get(name) || 0) > 0
}

function lookHint() {
  const parts = []
  if (hasActiveTool('qq_list_groups')) parts.push('先用 qq_list_groups 看看群')
  if (hasActiveTool('qq_get_group_history')) parts.push('再用 qq_get_group_history 看 2~3 个群最近 30 条')
  return parts.length ? '你可以' + parts.join('，') + '，' : ''
}


// ---------- 观察窗（群聊发消息 / 戳回去之后的后续消息） ----------
// 私聊不走观察窗：每条私聊消息都会直接唤醒目标会话。
const windows = new Map()

export function startObservation(groupId, reason) {
  const cfg = loadCfg()
  const id = String(groupId || '')
  if (!id) return
  const ms = Math.max(30000, Math.min(Number(cfg.observationMs) || 60000, 600000))
  windows.set(id, Date.now() + ms)
  diag('观察窗：群 ' + id + ' 保持 ' + Math.round(ms / 1000) + ' 秒（' + String(reason || '') + '）')
}


// ---------- 把一个工具挂到目标会话 ----------
// 每个工具组件各自调用一次：自己找目标会话、自己挂、自己卸，
// 所以关掉某个组件只会影响它自己的工具。
export function mountOneTool(ctx, tool) {
  ensureCfg()
  markActive(tool.name, 1)
  const mounted = new Map()

  function unmountAll(reason) {
    for (const [sid, v] of mounted) {
      try {
        if (typeof v.off === 'function') v.off()
      } catch (error) {}
      diag('工具 ' + tool.name + ' 已从会话 ' + sid + ' 卸下：' + reason)
    }
    mounted.clear()
  }

  function tick() {
    const target = targetSessionId()
    if (!target) {
      if (mounted.size) unmountAll('没有目标会话')
      return
    }
    const agent = findAgent(ctx.agents, target)
    if (!agent) {
      if (mounted.size) unmountAll('目标会话没有活着')
      return
    }
    const sid = sessionIdOf(agent)
    if (mounted.has(sid)) return
    unmountAll('目标会话变了')
    try {
      const off = agent.ctx.tools.register(tool)
      mounted.set(sid, { agent, off })
      diag('工具 ' + tool.name + ' 已挂到会话 ' + sid)
    } catch (error) {
      diag('工具挂载失败 ' + tool.name + '：' + String((error && error.message) || error))
    }
  }

  tick()
  ctx.effect(() => ctx.interval(tick, 3000))
  ctx.effect(() => () => {
    markActive(tool.name, -1)
    unmountAll('插件卸载')
  })
  return { tool, tick, unmountAll, mounted }
}


// ---------- @ 提醒轮询（由「发群消息」组件启动） ----------
let selfId = ''
let names = new Map()
let namesAt = 0
let lastSeen = new Map()
let seen = new Set()
let busy = false
let noAgentAt = 0

async function refreshNames(cfg) {
  if (names.size && Date.now() - namesAt < 300000) return
  try {
    const data = await onebot('get_group_list', {}, cfg)
    const next = new Map()
    for (const g of Array.isArray(data) ? data : []) next.set(String(g.group_id), clean(g.group_name || g.group_id))
    if (next.size) {
      names = next
      namesAt = Date.now()
    }
  } catch (error) {}
}

async function pollMentions(ctx) {
  const cfg = loadCfg()
  if (!cfg.mentionEnabled) return
  if (busy) return
  busy = true
  try {
    const target = targetSessionId()
    const agent = findAgent(ctx.agents, target)
    if (!agent) {
      if (Date.now() - noAgentAt > 60000) {
        noAgentAt = Date.now()
        diag('@ 轮询：目标会话没有活着（' + (target || '未设置') + '）')
      }
      return
    }
    if (!selfId) {
      try {
        const info = await onebot('get_login_info', {}, cfg)
        selfId = String((info && info.user_id) || '')
      } catch (error) {}
    }
    const now = Math.floor(Date.now() / 1000)
    if (!lastSeen.size) {
      for (const gid of cfg.groups) lastSeen.set(String(gid), now)
      diag('@ 轮询初始化，从现在开始（' + now + '）')
    }
    await refreshNames(cfg)
    const mentions = []
    const followups = new Map()
    for (const gid of cfg.groups) {
      let messages = []
      try {
        messages = listOf(await onebot('get_group_msg_history', { group_id: Number(gid), count: 10 }, cfg), 'messages')
      } catch (error) {
        continue
      }
      const prev = lastSeen.get(String(gid)) || 0
      let maxTime = prev
      for (const m of listOf(messages, 'messages').slice().sort((a, b) => (a.time || 0) - (b.time || 0))) {
        const t = Number(m.time || 0)
        if (t < prev) continue
        if (t > maxTime) maxTime = t
        const mid = m.message_id
        if (mid != null) {
          if (seen.has(mid)) continue
          seen.add(mid)
        }
        const uid = Number((m.sender && m.sender.user_id) || m.user_id || 0)
        if (selfId && uid === Number(selfId)) continue
        const segs = Array.isArray(m.message) ? m.message : []
        const atMe = segs.some(
          (s) => s && s.type === 'at' && (String(s.data && s.data.qq) === selfId || String(s.data && s.data.qq) === 'all'),
        )
        const text = segText(segs) || '（没有文字）'
        const name = clean((m.sender && (m.sender.card || m.sender.nickname)) || String(uid))
        const winUntil = windows.get(String(gid)) || 0
        if (Date.now() < winUntil) {
          const arr = followups.get(String(gid)) || []
          arr.push({ gid: String(gid), group: names.get(String(gid)) || String(gid), sender: name, text, time: t })
          followups.set(String(gid), arr)
        } else if (atMe) {
          mentions.push({ gid: String(gid), group: names.get(String(gid)) || String(gid), sender: name, text, time: t })
        }
      }
      lastSeen.set(String(gid), maxTime)
    }
    if (seen.size > 500) seen.clear()
    for (const [gid, until] of windows) if (Date.now() >= until) windows.delete(gid)
    if (!mentions.length && followups.size === 0) return
    const lines = mentions.slice(-5).map((x) => `群「${x.group}」${x.sender}：${x.text}`)
    const sendTools = []
    if (hasActiveTool('qq_send_group_message')) sendTools.push('qq_send_group_message')
    if (hasActiveTool('qq_send_face')) sendTools.push('qq_send_face')
    const sendHint = sendTools.length ? '想说话可以用 ' + sendTools.join(' / ') + ' 回复；' : ''
    const prompt =
      '【群聊 @ 提醒】有人 @ 了你：\n' +
      lines.join('\n') +
      '\n' + lookHint() + '再决定要不要回复、回哪个群。' + sendHint + '不想说话就安静待着；' +
      '不要用 Markdown，不要提工具和私聊内容，短一点。'
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'qq-mention' },
    }
    if (mentions.length) {
      await agent.followup(message)
      diag('@ 提醒已送进会话：' + lines.join(' | ').slice(0, 300))
    }
    for (const [gid, list] of followups) {
      const group = list[0] && list[0].group ? list[0].group : gid
      const lines2 = list.slice(-10).map((x) => `${x.sender}：${x.text}`)
      const prompt2 =
        '【群聊后续】你刚才在群「' + group + '」里说过话，现在又有人说话：\n' +
        lines2.join('\n') +
        '\n想接就接；' +
        (hasActiveTool('qq_send_group_message') ? '想说话用 qq_send_group_message 发到这个群；' : '') +
        (hasActiveTool('qq_send_face') ? '想回表情用 qq_send_face；' : '') +
        '不想接就安静待着。不要用 Markdown，短一点。'
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt2 }],
        source: { kind: 'qq-followup' },
      })
      diag('群后续 → 会话：群 ' + gid + ' ' + lines2.join(' | ').slice(0, 240))
    }
  } catch (error) {
    diag('@ 轮询出错：' + String((error && error.message) || error))
  } finally {
    busy = false
  }
}

export function startMentionPolling(ctx) {
  // 组件重新加载时从头开始，避免把停用期间的旧 @ 一次性翻出来。
  selfId = ''
  names = new Map()
  namesAt = 0
  lastSeen = new Map()
  seen = new Set()
  busy = false
  noAgentAt = 0
  ctx.effect(() => ctx.interval(() => pollMentions(ctx), loadCfg().pollMs))
}


// ---------- 戳一戳（由「戳一戳」组件启动） ----------
const pokeSeen = new Set()
const memberNames = new Map()

async function memberName(groupId, userId) {
  const key = String(groupId) + ':' + String(userId)
  const hit = memberNames.get(key)
  if (hit && Date.now() - hit.at < 300000) return hit.name
  try {
    const d = await onebot('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) }, loadCfg())
    const name = clean((d && (d.card || d.nickname)) || userId)
    memberNames.set(key, { name, at: Date.now() })
    return name
  } catch (error) {
    return String(userId)
  }
}

async function handlePoke(ctx, ev) {
  const cfg = loadCfg()
  if (!cfg.pokeEnabled) return
  const self = String(ev.self_id || selfId || '')
  const sender = String(ev.user_id || ev.sender_id || '')
  const target = String(ev.target_id || '')
  if (!self || !sender || sender === self) return
  if (target && target !== self) return
  const groupId = ev.group_id ? String(ev.group_id) : ''
  if (!groupId && !allowedPrivate(sender, cfg)) return
  const key = [ev.time, groupId, sender, target].join('|')
  if (pokeSeen.has(key)) return
  pokeSeen.add(key)
  if (pokeSeen.size > 300) pokeSeen.clear()
  const agent = findAgent(ctx.agents, targetSessionId())
  if (!agent) {
    diag('戳一戳：目标会话没有活着')
    return
  }
  const name = groupId ? await memberName(groupId, sender) : sender
  const groupName = groupId ? (names.get(groupId) || groupId) : ''
  let prompt
  if (groupId) {
    const actions = []
    if (hasActiveTool('qq_send_group_message')) actions.push('想回就用 qq_send_group_message 发到这个群')
    if (hasActiveTool('qq_send_face')) actions.push('想回个表情用 qq_send_face（group_id=' + groupId + '）')
    if (hasActiveTool('qq_send_poke')) actions.push(`想戳回去用 qq_send_poke（group_id=${groupId}, user_id=${sender}）`)
    prompt = `【戳一戳】群「${groupName}」里 ${name}(${sender}) 戳了你一下。`
      + (actions.length ? actions.join('；') + '。不想回就安静待着。' : '不用回复。')
      + '不要用 Markdown，短一点。'
  } else {
    const actions = []
    if (hasActiveTool('qq_send_private_message')) actions.push(`想回就用 qq_send_private_message（user_id=${sender}）`)
    if (hasActiveTool('qq_send_face')) actions.push(`想回表情用 qq_send_face（user_id=${sender}）`)
    if (hasActiveTool('qq_send_poke')) actions.push(`想戳回去用 qq_send_poke（user_id=${sender}）`)
    prompt = `【戳一戳】${sender} 在私聊里戳了你一下。`
      + (actions.length ? actions.join('；') + '。不想回就安静待着。' : '不用回复。')
      + '不要用 Markdown，短一点。'
  }
  const sourceKind = groupId ? 'qq-poke' : 'qq-private'
  await agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: sourceKind },
  })
  diag('戳一戳 → 会话：' + (groupId ? '群 ' + groupId : '私聊') + ' ' + sender)
}

const privateSeen = new Set()

async function handlePrivateMessage(ctx, ev, admitImages) {
  const cfg = loadCfg()
  if (!cfg.privateEnabled) return
  const self = String(ev.self_id || selfId || '')
  const userId = String(ev.user_id || (ev.sender && ev.sender.user_id) || '')
  if (!userId) return
  if (self && userId === self) return
  if (!allowedPrivate(userId, cfg)) return
  const key = String(ev.message_id != null ? ev.message_id : [ev.time, userId].join('|'))
  if (privateSeen.has(key)) return
  privateSeen.add(key)
  if (privateSeen.size > 500) privateSeen.clear()
  const agent = findAgent(ctx.agents, targetSessionId())
  if (!agent) {
    diag('私聊：目标会话没有活着')
    return
  }
  if (!selfId) {
    try {
      const info = await onebot('get_login_info', {}, cfg)
      selfId = String((info && info.user_id) || '')
    } catch (error) {}
  }
  const name = clean((ev.sender && (ev.sender.card || ev.sender.nickname)) || userId)
  const segs = Array.isArray(ev.message) ? ev.message : []
  const text = segText(segs) || clean(ev.raw_message) || '（没有文字）'
  const groupId = ev.group_id ? String(ev.group_id) : ''
  const actions = []
  if (hasActiveTool('qq_get_private_history')) {
    actions.push('想看上下文用 qq_get_private_history（user_id=' + userId + '）')
  }
  if (hasActiveTool('qq_send_private_message')) {
    actions.push('想回就用 qq_send_private_message（user_id=' + userId + (groupId ? ', group_id=' + groupId : '') + '）')
  }
  if (hasActiveTool('qq_send_face')) {
    actions.push('想回表情用 qq_send_face（user_id=' + userId + (groupId ? ', group_id=' + groupId : '') + '）')
  }
  const where = groupId ? '群 ' + groupId + ' 的临时会话' : '私聊'
  const prompt =
    '【QQ ' + where + '】' + name + '(' + userId + ') 给你发消息：\n' + text +
    (ev.message_id != null ? '\n（消息 #' + ev.message_id + '）' : '') +
    '\n' + (actions.length ? actions.join('；') + '。' : '') +
    '不想回就安静待着；不要用 Markdown，不要提工具，短一点。'
  const content = [{ type: 'text', text: prompt }]
  if (typeof admitImages === 'function') {
    // 和群/私聊记录一样：先保证最近两张动图能进来，剩下的名额给静图。
    const anim = []
    const stat = []
    for (const seg of segs) {
      if (!seg || (seg.type !== 'image' && seg.type !== 'mface') || !seg.data) continue
      const item = { seg, animated: animatedSeg(seg) }
      if (item.animated) anim.push(item)
      else stat.push(item)
    }
    const animPick = anim.slice(-2)
    const picked = [...animPick, ...stat.slice(-(4 - animPick.length))]
    if (picked.length) {
      const images = await admitImages(picked.map(({ seg, animated }, i) => ({
        data: seg.data,
        cfg,
        animated,
        name: (seg.data && seg.data.file) || `qq-private-${ev.message_id || 'x'}-${i}.jpg`,
        caption: `私聊 ${name} 发的图片（消息 ${ev.message_id || '?'}）`,
      })))
      for (const img of images) {
        if (img && img.caption) content.push({ type: 'text', text: img.caption })
        if (img && img.block) content.push(img.block)
      }
    }
  }
  await agent.followup({
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'qq-private' },
  })
  diag('私聊消息 → 会话：' + userId + ' ' + text.slice(0, 200))
}

function startWsWatcher(ctx, tag, enabled, onEvent) {
  let ws = null
  let stopped = false
  let timer = null

  function connectWs() {
    if (stopped) return
    const cfg = loadCfg()
    if (!enabled(cfg)) return
    const url = String(cfg.wsUrl || '')
    if (!url) return
    if (typeof WebSocket === 'undefined') {
      diag(tag + '：WS 不可用，当前 Node 没有 WebSocket')
      return
    }
    try {
      let targetUrl = url
      if (cfg.accessToken) {
        const u = new URL(url)
        u.searchParams.set('access_token', cfg.accessToken)
        targetUrl = u.toString()
      }
      const socket = new WebSocket(targetUrl)
      ws = socket
      socket.onopen = () => diag(tag + '：WS 已连接')
      socket.onmessage = (event) => {
        try {
          const ev = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
          if (ev) {
            void Promise.resolve(onEvent(ev, cfg)).catch((error) =>
              diag(tag + '：处理事件失败 ' + String((error && error.message) || error)),
            )
          }
        } catch (error) {}
      }
      socket.onclose = () => {
        if (ws === socket) ws = null
        if (!stopped) timer = setTimeout(connectWs, 5000)
      }
      socket.onerror = () => {
        try { socket.close() } catch (error) {}
      }
    } catch (error) {
      diag(tag + '：WS 连接失败 ' + String((error && error.message) || error))
      if (!stopped) timer = setTimeout(connectWs, 5000)
    }
  }

  ctx.effect(() => {
    connectWs()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch (error) {}
    }
  })
}

export function startPokeWatcher(ctx) {
  startWsWatcher(ctx, '戳一戳', (cfg) => cfg.pokeEnabled, (ev) => {
    if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      return handlePoke(ctx, ev)
    }
  })
}

export function startPrivateWatcher(ctx, admitImages) {
  startWsWatcher(ctx, '私聊', (cfg) => cfg.privateEnabled, (ev) => {
    if (ev.post_type === 'message' && ev.message_type === 'private') {
      return handlePrivateMessage(ctx, ev, admitImages)
    }
  })
}


// ---------- 兼容：老的整体插件入口（一个插件挂全部工具） ----------
export function mountAll(ctx) {
  const admitImages = admitImagesFor(ctx)
  const list = mountOneTool(ctx, makeListTool())
  const history = mountOneTool(ctx, makeHistoryTool(admitImages))
  const members = mountOneTool(ctx, makeMembersTool())
  const send = mountOneTool(ctx, makeSendTool(startObservation))
  const face = mountOneTool(ctx, makeSendFaceTool(startObservation))
  const faceList = mountOneTool(ctx, makeListFacesTool(admitImages))
  const faceFav = mountOneTool(ctx, makeFavoriteFaceTool())
  const poke = mountOneTool(ctx, makePokeTool(startObservation))
  const friends = mountOneTool(ctx, makeListFriendsTool())
  const privateHistory = mountOneTool(ctx, makePrivateHistoryTool(admitImages))
  const privateSend = mountOneTool(ctx, makeSendPrivateTool())
  startMentionPolling(ctx)
  startPokeWatcher(ctx)
  startPrivateWatcher(ctx, admitImages)
  return {
    tools: [list, history, members, send, face, faceList, faceFav, poke, friends, privateHistory, privateSend],
    startObservation,
  }
}
