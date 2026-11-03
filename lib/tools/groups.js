// 群相关工具：列群、看群记录、看群成员、发群消息。

import { loadCfg, allowedGroup } from '../config.js'
import { onebot } from '../onebot.js'
import { clean, segText, animatedSeg, fmtTime, senderName, senderId, pickChatImages, CHAT_IMAGE_LIMIT } from '../utils.js'
import { listOf, renderTool } from '../render.js'
import { CHAT_STYLE, chatText } from '../prompts.js'

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

export function makeHistoryTool(admitImages) {
  return {
    name: 'qq_get_group_history',
    description:
      '看某个群最近的聊天记录（只读）。默认最近 30 条，最多 50 条。' +
      '有人 @ 你时，可以用该工具看个@你的群，再进行回复。' +
      '群号从 qq_list_groups 或 @ 提醒里拿。消息前面的 #编号 是 message_id，' +
      '可以用 qq_send_face 回复，或用 qq_favorite_face 收藏消息里的图片。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号' },
        count: { type: 'number', description: '看最近多少条，默认 30，最多 50' },
        include_images: { type: 'boolean', description: '要不要把最近的图片也给你看（最多 ' + CHAT_IMAGE_LIMIT + ' 张，默认 true）' },
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
          const last = pickChatImages(picked)
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
      '在指定群里发一条消息。发之前先确认群号；只发到允许的群。想分几条说就多次调用本工具，一次一条。' +
      'reply_to 传消息前面的 #编号 可以引用那条消息；at_user_ids 传 QQ 号可以 @ 人，at_all=true 是 @全体成员。' +
      '如果有用的表情可以表达自己的想法的话，也可以发表情加句子会更加生动，表情可以调用qq_send_face发送'+
      CHAT_STYLE +
      '不想说话就不要调用这个工具；调用后不要再重复说自己发了什么。',
    parameters: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号' },
        message: { type: 'string', description: '这一条的文字，一句短话；只 @ 不说话时可以留空' },
        reply_to: { type: 'string', description: '要引用的消息 ID（消息前面的 #编号），可选', },
        at_user_ids: { type: 'array', items: { type: 'number' }, description: '要 @ 的 QQ 号列表，可选', },
        at_all: { type: 'boolean', description: 'true = @全体成员，可选' },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const groupId = Number(args && args.group_id)
      const text = chatText(args)
      const atIds = [...new Set(
        (Array.isArray(args && args.at_user_ids) ? args.at_user_ids : [])
          .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0),
      )].slice(0, 20)
      const atAll = args && args.at_all === true
      if (!Number.isFinite(groupId)) return { ok: false, error: 'group_id 不是有效群号' }
      if (!text && !atIds.length && !atAll) return { ok: false, error: '消息是空的' }
      if (!allowedGroup(groupId, cfg)) return { ok: false, error: '这个群不在允许列表里' }
      try {
        const replyTo = args && args.reply_to
        const message = []
        if (replyTo != null && replyTo !== '') message.push({ type: 'reply', data: { id: String(replyTo) } })
        if (atAll) message.push({ type: 'at', data: { qq: 'all' } })
        else for (const qq of atIds) message.push({ type: 'at', data: { qq: String(qq) } })
        if (text) message.push({ type: 'text', data: { text } })
        const data = await onebot('send_group_msg', { group_id: groupId, message }, cfg)
        try { if (typeof onSent === 'function') onSent(groupId, '发群消息') } catch (error) {}
        return {
          ok: true,
          group_id: groupId,
          message_id: data && data.message_id,
          reply_to: replyTo != null && replyTo !== '' ? String(replyTo) : '',
          at_user_ids: atAll ? [] : atIds,
          at_all: atAll,
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '发群消息失败：' + String((v && v.error) || '未知错误') }]
      const extra = []
      if (v.reply_to) extra.push('引用了 #' + v.reply_to)
      if (v.at_all) extra.push('@全体成员')
      else if (Array.isArray(v.at_user_ids) && v.at_user_ids.length) extra.push('@了 ' + v.at_user_ids.join('、'))
      return [{ type: 'text', text: `已发到群 ${v.group_id}（消息 ${v.message_id || '?'}${extra.length ? '，' + extra.join('，') : ''}）。` }]
    },
  }
}
