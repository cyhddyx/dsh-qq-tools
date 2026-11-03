// 改头像工具。

import { loadCfg } from '../config.js'
import { onebot } from '../onebot.js'
import { renderTool } from '../render.js'
import { imageSourceOf, imageSourceFromMessage, describeSource } from '../images.js'

// ---------- 头像 ----------
// set_qq_avatar 是 SnowLuma 扩展，file 和图片接口一样吃 http(s)/base64:///file://。
// 换头像会立刻对所有好友和群友可见，描述里明确要求只在用户提出时调用。
export function makeSetAvatarTool() {
  return {
    name: 'qq_set_avatar',
    description:
      '改自己的 QQ 头像（SnowLuma set_qq_avatar）。' +
      'file 传 http(s) 链接、base64://、data:image/... 或本机文件路径；' +
      '也可以用 message_id + index 从聊天记录里的某张图片取图。' +
      '只有用户明确要求换头像时才用；换完不用再重复说明。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '图片：http(s) 链接、base64://、data:image/... 或本机路径；和 message_id 二选一' },
        message_id: { type: 'string', description: '从这条消息里取图当头像；和 file 二选一' },
        index: { type: 'number', description: 'message_id 里第几张图片，从 0 开始，默认 0' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const fileRaw = String((args && args.file) || '').trim()
      const hasMessage = args && args.message_id != null && args.message_id !== ''
      if (fileRaw && hasMessage) return { ok: false, error: 'file 和 message_id 只能选一个' }
      if (!fileRaw && !hasMessage) return { ok: false, error: '要换头像就传 file 或 message_id' }
      try {
        let source = imageSourceOf(fileRaw)
        if (!source && hasMessage) {
          const got = await imageSourceFromMessage(args.message_id, args.index, cfg)
          if (got.error) return { ok: false, error: got.error }
          source = got.source
        }
        if (!source) return { ok: false, error: '拿不到头像图片' }
        await onebot('set_qq_avatar', { file: source }, cfg)
        return { ok: true, avatar: true, source: describeSource(source) }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '换头像失败：' + String((v && v.error) || '未知错误') }]
      return [{ type: 'text', text: 'QQ 头像已更新（' + (v.source || '图片') + '）。' }]
    },
  }
}
