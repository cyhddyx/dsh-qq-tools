// sharp 加载、图片准入（DSH 附件层）、GIF 拆帧，以及从消息/本机路径取图。

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { onebot } from './onebot.js'
import { loadCfg, diag } from './config.js'

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

// ---------- 图片类型与尺寸 ----------
// DSH 附件层按真实字节复核 mediaType（IMAGE_TYPE_MISMATCH），文件名和 QQ 的
// animated 提示都可能撒谎，所以只信字节。大图不依赖 sharp：DSH 默认单张源图
// 上限 20MiB、归一化目标 4MiB，直接交给它处理；sharp 只用于 GIF 拆帧和
// admit 被尺寸拒绝后的兜底重编码。
// 一次 admit 最多处理 10 张：聊天记录现在最多带 10 张图，GIF 拆帧也共用这个上限。
const ADMIT_IMAGE_LIMIT = 10
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

// SnowLuma 的 add_custom_face 只认 file:///、base64://、http(s)://，
// 本机路径要先转成 file:/// URL，data:image/... 转成 base64://。
export function imageSourceOf(raw) {
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

// 从聊天消息里取图片：get_msg → 图片段 → 可直接交给 SnowLuma 的 file 来源。
// 收藏表情、换头像、发说说都用这一条路径，索引从 0 开始。
export async function imageSourceFromMessage(messageId, index, cfg) {
  const msg = await onebot('get_msg', { message_id: messageId }, cfg)
  const segs = Array.isArray(msg && msg.message) ? msg.message : []
  const images = segs.filter((s) => s && (s.type === 'image' || s.type === 'mface') && s.data)
  const idx = Number.isInteger(Number(index)) ? Math.max(0, Number(index)) : 0
  const pick = images[idx]
  if (!pick) return { error: `这条消息里没有第 ${idx} 张图片（共 ${images.length} 张）` }
  const source = imageSourceOf(pick.data.url || pick.data.file)
  if (!source) return { error: '拿不到这条消息里的图片地址' }
  return { source, total: images.length }
}

export async function imageSourcesFromMessage(messageId, indexes, cfg, max = 9) {
  const msg = await onebot('get_msg', { message_id: messageId }, cfg)
  const segs = Array.isArray(msg && msg.message) ? msg.message : []
  const picks = segs.filter((s) => s && (s.type === 'image' || s.type === 'mface') && s.data)
  const wanted = Array.isArray(indexes) && indexes.length
    ? indexes.map((x) => Number(x)).filter((x) => Number.isInteger(x))
    : picks.map((_, i) => i)
  const sources = []
  for (const i of wanted) {
    if (sources.length >= max) break
    const pick = picks[i]
    if (!pick) continue
    const source = imageSourceOf(pick.data.url || pick.data.file)
    if (source) sources.push(source)
  }
  return { sources, total: picks.length }
}

// 工具回执里不要把 base64 原样吐回去，不然一次换头像就能塞满上下文。
export function describeSource(source) {
  const s = String(source || '')
  if (/^base64:\/\//i.test(s)) return 'base64://…'
  if (/^file:\/\//i.test(s)) {
    try {
      return decodeURIComponent(new URL(s).pathname).split('/').pop() || '本机图片'
    } catch (error) {
      return '本机图片'
    }
  }
  if (/^https?:/i.test(s)) return s.length > 200 ? s.slice(0, 200) + '…' : s
  return s.slice(0, 200)
}
