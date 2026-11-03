// 戳一戳工具。

import { loadCfg, allowedGroup, allowedPrivate } from '../config.js'
import { onebot } from '../onebot.js'
import { renderTool } from '../render.js'

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
