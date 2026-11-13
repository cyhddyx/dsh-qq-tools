// 唤醒提示词与回复风格。只放文案和拼接，不碰网络和状态。

import { clean } from './utils.js'
import { hasActiveTool } from './session.js'

// 唤醒提示里的消息行：和戳一戳一致，固定带上昵称和 QQ 号。
// 有 message_id 时附在末尾，模型可以把它传给 reply_to 做引用。
export function formatIncomingLine(name, userId, text, messageId) {
  const who = clean(name) || 'QQ'
  const qq = String(userId || '?')
  return `${who}(${qq})：${text || '（空）'}` + (messageId != null ? `（消息 #${messageId}）` : '')
}

// 回复风格：群聊要像随手打字，短、分条、不刷屏地 @ 和引用。
export const CHAT_STYLE = '回复像群友随手打字：想连发几条文字就多次调用发消息工具（一次调用只发一条），每条一句短话（十几二十个字）；'
  + '每轮实际发送的文字和表情合计最多三条，qq_send_face 附带 text 时算两条；查列表、看记录和 preview=true 预览不占发送条数；'
  + '不要句号收尾，不要写长段落，不要 Markdown，不要把昵称或 QQ 号写进正文，不要每句都 @ 或引用——'
  + '只有确实要指代某条消息时才传 reply_to，只有必须提醒某个人时才传 at_user_ids。'

// 主动发表情：平时列表只给备注，真要发的时候才 preview 一张图，省 token。
export const FACE_STYLE = '表情包也是日常回复方式，不用等别人要求你发。每次决定回复时，先判断用文字、收藏表情还是短文字配一个表情更自然；'
  + '遇到好笑、惊讶、无语、赞同、被调侃、打招呼或对方用表情接话时，主动用贴切的收藏表情表达反应，可以只发表情；'
  + '不要每次都默认只回文字，也不要为了凑次数硬发，严肃话题或没有合适表情时用文字即可；'
  + '需要挑表情时先用 qq_list_faces 按备注选择，再用 qq_send_face 传 preview=true 看一眼这张图，确认贴合当前语境后，再调用 qq_send_face 去掉 preview 正式发送到当前群或私聊；'
  + '预览不会发送，决定用这张时要完成正式发送；同一会话中已经看过、确认内容且知道 emoji_id 的表情可以复用，不必每次重新查列表和预览；'

// 收到带图消息时给一个低概率的收藏引导；index 和 qq_favorite_face 的取图索引一致。
// desc 直接描述画面内容，否则 qq_list_faces 只有备注，后面根本不知道用哪张。
export function favoriteHint(text, messageId) {
  const m = String(text || '').match(/\[(?:图片|表情包)#(\d+)\]/)
  if (!m || messageId == null || messageId === '') return ''
  return '这条消息里有图片，约有 25% 的概率可以顺手收藏一个你觉得好玩的'
    + '（qq_favorite_face(message_id=' + String(messageId) + ', index=' + m[1] + ', desc=表情内容)）；'
    + 'desc 直接简短描述画面内容，比如「闭眼安详」「锅铲敲地」「穿冬装的肥鱼」。'
}

const CHAT_BUBBLE_CHARS = 80

// 一条消息的清理：压掉复制来的对齐空格和多行，去掉正文开头重复的 @昵称。
function cleanBubble(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[\u3000\t ]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .replace(/^@[^\s@]{1,40}\s+/, '')
    .slice(0, CHAT_BUBBLE_CHARS)
}

// 一次工具调用只发一条：想分几条说就让模型多次调用工具。
export function chatText(args) {
  return cleanBubble(args && args.message)
}

export function lookHint() {
  const parts = []
  if (hasActiveTool('qq_list_groups')) parts.push('先用 qq_list_groups 看看群')
  if (hasActiveTool('qq_get_group_history')) parts.push('再用 qq_get_group_history 看 2~3 个群最近 30 条')
  return parts.length ? '你可以' + parts.join('，') + '，' : ''
}
