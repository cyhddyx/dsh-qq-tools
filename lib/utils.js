// 通用文本与消息格式工具。

export function clean(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

// 说说正文和评论要保留换行；只清掉控制字符，不折叠空白。
export function cleanMultiline(s, max = 4000) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max)
}

export function segText(segs) {
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
export function animatedSeg(seg) {
  if (!seg || !seg.data) return false
  if (seg.type === 'mface') return true
  const d = seg.data
  return /\.gif(?:[?#]|$)/i.test(String(d.file || '')) || /\.gif(?:[?#]|$)/i.test(String(d.url || ''))
}

export function fmtTime(sec) {
  const t = Number(sec)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function senderName(m) {
  const s = (m && m.sender) || {}
  return clean(s.card || s.nickname || s.user_id || (m && m.user_id) || '?')
}

export function senderId(m) {
  const s = (m && m.sender) || {}
  return clean(s.user_id || (m && m.user_id) || '')
}

// 聊天记录一次最多带 10 张图：动图最多留 3 张，剩下的名额按时间给最近的静图。
export const CHAT_IMAGE_LIMIT = 10

export function pickChatImages(picked, max = CHAT_IMAGE_LIMIT) {
  const anim = picked.filter((x) => x.animated).slice(-3)
  const stat = picked.filter((x) => !x.animated).slice(-(max - anim.length))
  return [...anim, ...stat].slice(0, max)
}
