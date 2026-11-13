// 收藏表情工具：发、列、收藏/取消收藏/改备注。

import { loadCfg, allowedGroup, allowedPrivate } from '../config.js'
import { onebot } from '../onebot.js'
import { clean } from '../utils.js'
import { renderTool } from '../render.js'
import { imageSourceOf, imageSourceFromMessage } from '../images.js'

// ---------- 表情：只走 QQ 收藏表情（SnowLuma 自定义表情） ----------
// 发表情走 SnowLuma 的 send_custom_face，不走 OneBot 11 的 face 段，也不用系统表情编号。
// 收藏表情还用到这些扩展接口：
//   fetch_custom_face_detail / add_custom_face / delete_custom_face /
//   modify_custom_face / move_custom_face_to_front / send_custom_face
// 这些接口是 SnowLuma 扩展；本插件只支持 SnowLuma，其他 OneBot 实现没有这些接口。
const CUSTOM_FACE_COUNT = 200

function customFaceOf(entry) {
  return {
    emoji_id: String((entry && (entry.emoji_id || entry.emojiId || entry.resId)) || ''),
    desc: clean(entry && entry.desc),
    url: String((entry && entry.url) || ''),
  }
}

async function fetchCustomFaces(cfg, count = CUSTOM_FACE_COUNT) {
  const data = await onebot('fetch_custom_face_detail', { count }, cfg)
  return (Array.isArray(data) ? data : []).map(customFaceOf).filter((f) => f.emoji_id)
}



// preview 只取这一张表情的图，不走发送；列表平时只有备注，省 token。
async function previewFace(cfg, emojiId, admitImages) {
  if (typeof admitImages !== 'function') {
    return { ok: false, error: '当前宿主不支持图片预览' }
  }
  let faces = []
  try {
    faces = await fetchCustomFaces(cfg, CUSTOM_FACE_COUNT)
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  const hit = faces.find((f) => f.emoji_id === emojiId)
  if (!hit) return { ok: false, error: '收藏夹里没有这个 emoji_id（先用 qq_list_faces 对一下）' }
  if (!/^https?:/i.test(hit.url)) return { ok: false, error: '这个表情没有可预览的图片地址' }
  const images = await admitImages([{
    data: { url: hit.url },
    cfg,
    name: `qq-face-${hit.emoji_id}.jpg`,
    caption: `收藏表情预览 ${hit.desc || hit.emoji_id}`,
  }])
  if (!images.length) return { ok: false, error: '预览图没能送进来（下载失败或宿主不支持图片）' }
  return { ok: true, preview: true, emoji_id: emojiId, desc: hit.desc, images }
}

export function makeSendFaceTool(onSent, admitImages) {
  return {
    name: 'qq_send_face',
    description:
      '发一个你 QQ 收藏夹里的自定义表情（emoji_id）。' +
      '适合日常聊天中主动表达好笑、惊讶、无语、赞同等反应，不用等对方要求；可以只发表情，也可以配一句短话。' +
      '群聊传 group_id；私聊传 user_id（可选 group_id 表示临时会话来源群）。' +
      'emoji_id 从 qq_list_faces 的收藏列表拿。' +
      '没看过这张图时先传 preview=true：只返回这一张表情图让你确认，不发送；确认合适再去掉 preview 真发。同一会话已预览确认的表情可以直接复用。' +
      '可以顺带一句话 text；文字会先单独发一条。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号；私聊时如果是从群里发起的临时会话，也可以传来源群号' },
        user_id: { type: 'number', description: '对方 QQ 号；传了就是私聊，和只传 group_id 的群聊区分开' },
        emoji_id: { type: 'string', description: 'QQ 收藏表情的 emoji_id（SnowLuma），必填' },
        preview: { type: 'boolean', description: 'true = 只看这张表情的预览图，不发送' },
        text: { type: 'string', description: '跟着表情一起发的文字，可选，不要 Markdown' },
        reply_to: { type: 'string', description: '要回复的消息 ID，可选' },
      },
      required: ['emoji_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const hasUser = args && args.user_id != null && args.user_id !== ''
      const userId = hasUser ? Number(args.user_id) : 0
      const groupId = args && args.group_id != null && args.group_id !== '' ? Number(args.group_id) : 0
      const emojiId = String((args && args.emoji_id) || '').trim()
      const text = String((args && args.text) || '').trim()
      const previewOnly = args && args.preview === true
      if (!emojiId) return { ok: false, error: '要发表情就传 emoji_id（从 qq_list_faces 拿）' }
      if (previewOnly) return previewFace(cfg, emojiId, admitImages)
      if (hasUser) {
        if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
        if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
        if (groupId && !allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      } else {
        if (!Number.isFinite(groupId) || !groupId) return { ok: false, error: 'group_id 和 user_id 至少传一个' }
        if (!allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      }
      const target = hasUser
        ? { user_id: userId, ...(groupId ? { group_id: groupId } : {}) }
        : { group_id: groupId }
      try {
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
      if (v.preview) {
        const blocks = [{ type: 'text', text: '收藏表情预览 ' + (v.desc ? '「' + v.desc + '」' : '') + '（emoji_id=' + v.emoji_id + '）：合适就再去掉 preview 正式发。' }]
        for (const img of Array.isArray(v.images) ? v.images : []) {
          if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
          if (img && img.block) blocks.push(img.block)
        }
        return blocks
      }
      const where = v.chat === 'private'
        ? (v.group_id ? '群 ' + v.group_id + ' 的临时会话 QQ ' + v.user_id : 'QQ ' + v.user_id)
        : '群 ' + v.group_id
      const parts = []
      if (v.text_message_id) parts.push('文字已发（消息 ' + v.text_message_id + '）')
      parts.push('收藏表情 ' + v.emoji_id + ' 已发到' + where + '（消息 ' + (v.message_id || '?') + '）')
      return [{ type: 'text', text: parts.join('；') + '。' }]
    },
  }
}

export function makeListFacesTool() {
  return {
    name: 'qq_list_faces',
    description:
      '看你 QQ 收藏夹里的表情：每个只返回 emoji_id 和文字备注，不发图片。' +
      '按备注找就传 query；不传就列收藏夹。' +
      '收藏/取消收藏用 qq_favorite_face；发表情用 qq_send_face。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按备注或 emoji_id 搜收藏表情；不传就列全部' },
        count: { type: 'number', description: '最多列多少个收藏表情，默认 200，最多 500' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const q = String((args && args.query) || '').trim().toLowerCase()
      const count = Math.max(1, Math.min(Number(args && args.count) || CUSTOM_FACE_COUNT, 500))
      let favorites = []
      let favoritesError = ''
      try {
        favorites = await fetchCustomFaces(cfg, count)
      } catch (error) {
        favoritesError = String((error && error.message) || error)
      }
      const matched = q
        ? favorites.filter((f) => (f.desc + ' ' + f.emoji_id).toLowerCase().includes(q))
        : favorites
      return {
        ok: true,
        query: q,
        favorites: matched.slice(0, count).map((f) => ({ emoji_id: f.emoji_id, desc: f.desc })),
        favorites_total: favorites.length,
        favorites_error: favoritesError,
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看表情失败：' + String((v && v.error) || '未知错误') }]
      const lines = []
      if (v.favorites.length) {
        lines.push(v.query ? '匹配的收藏表情：' : '你 QQ 收藏夹里的表情：')
        v.favorites.forEach((f, i) => {
          lines.push(`${i + 1}. ${f.desc || '（无备注）'}  emoji_id=${f.emoji_id}`)
        })
        if (v.favorites_total > v.favorites.length) {
          lines.push(`（拿到 ${v.favorites_total} 个，只列了前 ${v.favorites.length} 个）`)
        }
      } else if (v.favorites_error) {
        lines.push('收藏表情读不到（SnowLuma 自定义表情接口不可用）：' + String(v.favorites_error).slice(0, 200))
      } else if (v.query) {
        lines.push('没有匹配备注的收藏表情，换个词或直接列收藏夹。')
      } else {
        lines.push('QQ 收藏夹里还没有表情。用 qq_favorite_face 从图片或消息收藏。')
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }
}

export function makeFavoriteFaceTool() {
  return {
    name: 'qq_favorite_face',
    description:
      '管理你 QQ 账号的收藏表情（SnowLuma）：收藏一张图片、取消收藏、改备注、移到最前。' +
      '收藏来源可以是 http(s) 图片链接、base64://、本机文件路径，或某条消息里的图片（message_id + index）。' +
      '收藏时尽量传 desc：qq_list_faces 只返回备注，desc 直接简短描述画面内容（比如「锅铲敲地」），不写后面就不知道这张表情该什么时候用。' +
      'emoji_id 从 qq_list_faces 的收藏列表拿；发表情用 qq_send_face。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '要收藏的图片：http(s) 链接、base64:// 或本机文件路径；和 message_id 二选一' },
        message_id: { type: 'string', description: '从这条消息里取图片收藏；和 file 二选一' },
        index: { type: 'number', description: 'message_id 里第几张图片，从 0 开始，默认 0' },
        emoji_id: { type: 'string', description: '已收藏表情的 emoji_id；取消收藏、改备注、移到最前时用' },
        desc: { type: 'string', description: '收藏表情的备注：直接简短描述画面内容，比如「闭眼安详」「锅铲敲地」「穿冬装的肥鱼」；收藏时强烈建议传，配合 emoji_id 可修改' },
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
          const got = await imageSourceFromMessage(args.message_id, args.index, cfg)
          if (got.error) return { ok: false, error: got.error }
          source = got.source
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
      if (!v.desc) text += ' 这次没写备注；建议用 emoji_id + desc 补一条，直接简短描述画面内容，不然后面挑表情时只有编号可看。'
      return [{ type: 'text', text }]
    },
  }
}
