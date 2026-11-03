// 目标会话解析、工具挂载、挂载会话 HTTP 接口，以及当前活着的工具表。

import { clean } from './utils.js'
import { ensureCfg, loadCfg, saveCfg, diag } from './config.js'

export function targetSessionId() {
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

export function findAgent(agents, id) {
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
