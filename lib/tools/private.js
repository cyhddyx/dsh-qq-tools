// 私聊工具：好友列表、私聊记录、发私聊消息。

import { loadCfg, allowedPrivate } from '../config.js'
import { onebot } from '../onebot.js'
import { clean, segText, animatedSeg, fmtTime, senderName, senderId, pickChatImages, CHAT_IMAGE_LIMIT } from '../utils.js'
import { listOf, renderTool } from '../render.js'
import { CHAT_STYLE, chatText } from '../prompts.js'
import { getSelfId } from '../qq-state.js'

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
        include_images: { type: 'boolean', description: '要不要把最近的图片也给你看（最多 ' + CHAT_IMAGE_LIMIT + ' 张，默认 true）' },
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
        const selfId = await getSelfId(cfg)
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
          const last = pickChatImages(picked)
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
      '给某个 QQ 好友发一条私聊消息。user_id 从 qq_list_friends 或私聊唤醒提示里拿。想分几条说就多次调用本工具，一次一条。' +
      'reply_to 传消息前面的 #编号 可以引用那条消息。' +
      CHAT_STYLE +
      '不想说话就不要调用；调用后不要再重复说自己发了什么。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '对方的 QQ 号' },
        message: { type: 'string', description: '这一条的文字，一句短话' },
        reply_to: { type: 'string', description: '要引用的消息 ID（消息前面的 #编号），可选' },
        group_id: { type: 'number', description: '临时会话的来源群号，可选；普通好友私聊不用传' },
      },
      required: ['user_id', 'message'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      const text = chatText(args)
      const groupId = args && args.group_id != null ? Number(args.group_id) : 0
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!text) return { ok: false, error: '消息是空的' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      try {
        const replyTo = args && args.reply_to
        const message = []
        if (replyTo != null && replyTo !== '') message.push({ type: 'reply', data: { id: String(replyTo) } })
        message.push({ type: 'text', data: { text } })
        const body = { user_id: userId, message }
        if (groupId) body.group_id = groupId
        const data = await onebot('send_private_msg', body, cfg)
        return {
          ok: true,
          user_id: userId,
          message_id: data && data.message_id,
          reply_to: replyTo != null && replyTo !== '' ? String(replyTo) : '',
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '发私聊消息失败：' + String((v && v.error) || '未知错误') }]
      const quote = v.reply_to ? '，引用了 #' + v.reply_to : ''
      return [{ type: 'text', text: `已发给 QQ ${v.user_id}（消息 ${v.message_id || '?'}${quote}）。` }]
    },
  }
}
