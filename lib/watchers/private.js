// 私聊消息唤醒。

import { randomUUID } from 'node:crypto'
import { loadCfg, allowedPrivate, diag } from '../config.js'
import { onebot } from '../onebot.js'
import { clean, segText, animatedSeg } from '../utils.js'
import { hasActiveTool, targetSessionId, findAgent } from '../session.js'
import { formatIncomingLine, favoriteHint, FACE_STYLE, CHAT_STYLE } from '../prompts.js'
import { getSelfId } from '../qq-state.js'
import { startWsWatcher } from './ws.js'

const privateSeen = new Set()

async function handlePrivateMessage(ctx, ev, admitImages) {
  const cfg = loadCfg()
  if (!cfg.privateEnabled) return
  const self = String(ev.self_id || await getSelfId(cfg) || '')
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
  const name = clean((ev.sender && (ev.sender.card || ev.sender.nickname)) || userId)
  const segs = Array.isArray(ev.message) ? ev.message : []
  const text = segText(segs) || clean(ev.raw_message) || '（没有文字）'
  const groupId = ev.group_id ? String(ev.group_id) : ''
  const midHint = ev.message_id != null ? '，引用传 reply_to=' + ev.message_id : ''
  const actions = []
  if (hasActiveTool('qq_get_private_history')) {
    actions.push('想看上下文用 qq_get_private_history（user_id=' + userId + '）')
  }
  if (hasActiveTool('qq_send_private_message')) {
    actions.push('想回就用 qq_send_private_message（user_id=' + userId + (groupId ? ', group_id=' + groupId : '') + midHint + '）')
  }
  if (hasActiveTool('qq_send_face')) {
    actions.push('想回表情用 qq_send_face（user_id=' + userId + (groupId ? ', group_id=' + groupId : '') + midHint + '）')
  }
  const where = groupId ? '群 ' + groupId + ' 的临时会话' : '私聊'
  const favHint = hasActiveTool('qq_favorite_face') ? favoriteHint(text, ev.message_id) : ''
  const faceHint = hasActiveTool('qq_send_face') ? FACE_STYLE : ''
  const prompt =
    '【QQ ' + where + '】' + formatIncomingLine(name, userId, text, ev.message_id) +
    '\n' + (actions.length ? actions.join('；') + '。' : '') + favHint + faceHint +
    '不想回就安静待着；不要提工具。' + CHAT_STYLE
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

export function startPrivateWatcher(ctx, admitImages) {
  startWsWatcher(ctx, '私聊', (cfg) => cfg.privateEnabled, (ev) => {
    if (ev.post_type === 'message' && ev.message_type === 'private') {
      return handlePrivateMessage(ctx, ev, admitImages)
    }
  })
}
