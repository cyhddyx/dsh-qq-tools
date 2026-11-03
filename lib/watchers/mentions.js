// @ 提醒与群后续轮询。

import { randomUUID } from 'node:crypto'
import { loadCfg, diag } from '../config.js'
import { onebot } from '../onebot.js'
import { clean, segText } from '../utils.js'
import { listOf } from '../render.js'
import { formatIncomingLine, favoriteHint, FACE_STYLE, CHAT_STYLE, lookHint } from '../prompts.js'
import { hasActiveTool, targetSessionId, findAgent } from '../session.js'
import { windowUntil, pruneExpiredWindows } from '../observation.js'
import { getSelfId, refreshNames, groupName, resetQqState } from '../qq-state.js'

// ---------- @ 提醒轮询（由「发群消息」组件启动） ----------
let lastSeen = new Map()
let seen = new Set()
let busy = false
let noAgentAt = 0

async function pollMentions(ctx) {
  const cfg = loadCfg()
  if (!cfg.mentionEnabled) return
  if (busy) return
  busy = true
  try {
    const target = targetSessionId()
    const agent = findAgent(ctx.agents, target)
    if (!agent) {
      if (Date.now() - noAgentAt > 60000) {
        noAgentAt = Date.now()
        diag('@ 轮询：目标会话没有活着（' + (target || '未设置') + '）')
      }
      return
    }
    const selfId = await getSelfId(cfg)
    const now = Math.floor(Date.now() / 1000)
    if (!lastSeen.size) {
      for (const gid of cfg.groups) lastSeen.set(String(gid), now)
      diag('@ 轮询初始化，从现在开始（' + now + '）')
    }
    await refreshNames(cfg)
    const mentions = []
    const followups = new Map()
    for (const gid of cfg.groups) {
      let messages = []
      try {
        messages = listOf(await onebot('get_group_msg_history', { group_id: Number(gid), count: 10 }, cfg), 'messages')
      } catch (error) {
        continue
      }
      const prev = lastSeen.get(String(gid)) || 0
      let maxTime = prev
      for (const m of listOf(messages, 'messages').slice().sort((a, b) => (a.time || 0) - (b.time || 0))) {
        const t = Number(m.time || 0)
        if (t < prev) continue
        if (t > maxTime) maxTime = t
        const mid = m.message_id
        if (mid != null) {
          if (seen.has(mid)) continue
          seen.add(mid)
        }
        const uid = Number((m.sender && m.sender.user_id) || m.user_id || 0)
        if (selfId && uid === Number(selfId)) continue
        const segs = Array.isArray(m.message) ? m.message : []
        const atMe = segs.some(
          (s) => s && s.type === 'at' && (String(s.data && s.data.qq) === selfId || String(s.data && s.data.qq) === 'all'),
        )
        const text = segText(segs) || '（没有文字）'
        const name = clean((m.sender && (m.sender.card || m.sender.nickname)) || String(uid))
        const senderQQ = String(uid || (m.sender && m.sender.user_id) || '?')
        const winUntil = windowUntil(gid)
        if (Date.now() < winUntil) {
          const arr = followups.get(String(gid)) || []
          arr.push({
            gid: String(gid),
            group: groupName(gid),
            sender: name,
            user_id: senderQQ,
            message_id: mid,
            text,
            time: t,
          })
          followups.set(String(gid), arr)
        } else if (atMe) {
          mentions.push({
            gid: String(gid),
            group: groupName(gid),
            sender: name,
            user_id: senderQQ,
            message_id: mid,
            text,
            time: t,
          })
        }
      }
      lastSeen.set(String(gid), maxTime)
    }
    if (seen.size > 500) seen.clear()
    pruneExpiredWindows()
    if (!mentions.length && followups.size === 0) return
    const fmtLine = (x) => formatIncomingLine(x.sender, x.user_id, x.text, x.message_id)
    const lines = mentions.slice(-5).map((x) => `群「${x.group}」${fmtLine(x)}`)
    const sendTools = []
    if (hasActiveTool('qq_send_group_message')) sendTools.push('qq_send_group_message')
    if (hasActiveTool('qq_send_face')) sendTools.push('qq_send_face')
    const sendHint = sendTools.length ? '想说话可以用 ' + sendTools.join(' / ') + ' 回复；' : ''
    const quoteHint = hasActiveTool('qq_send_group_message')
      ? '确实要指代某条消息时才传 reply_to=消息编号；必须提醒某个人时才传 at_user_ids=[QQ号]；'
      : ''
    const favLine = [...mentions].reverse().find((x) => favoriteHint(x.text, x.message_id))
    const favHint = favLine && hasActiveTool('qq_favorite_face')
      ? favoriteHint(favLine.text, favLine.message_id)
      : ''
    const faceHint = hasActiveTool('qq_send_face') ? FACE_STYLE : ''
    const prompt =
      '【群聊 @ 提醒】有人 @ 了你：\n' +
      lines.join('\n') +
      '\n' + lookHint() + '再决定要不要回复、回哪个群。' + sendHint + quoteHint + favHint + faceHint + '不想说话就安静待着；' +
      '不要提工具和私聊内容。' + CHAT_STYLE
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'qq-mention' },
    }
    if (mentions.length) {
      await agent.followup(message)
      diag('@ 提醒已送进会话：' + lines.join(' | ').slice(0, 300))
    }
    for (const [gid, list] of followups) {
      const group = list[0] && list[0].group ? list[0].group : gid
      const lines2 = list.slice(-10).map(fmtLine)
      const favLine2 = [...list].reverse().find((x) => favoriteHint(x.text, x.message_id))
      const favHint2 = favLine2 && hasActiveTool('qq_favorite_face')
        ? favoriteHint(favLine2.text, favLine2.message_id)
        : ''
      const prompt2 =
        '【群聊后续】你刚才在群「' + group + '」里说过话，现在又有人说话：\n' +
        lines2.join('\n') +
        '\n想接就接；' +
        (hasActiveTool('qq_send_group_message') ? '想说话用 qq_send_group_message 发到这个群，确实要指代某条才传 reply_to=消息编号，必须提醒某人才传 at_user_ids=[QQ号]；' : '') +
        favHint2 +
        (hasActiveTool('qq_send_face') ? FACE_STYLE : '') +
        '不想接就安静待着。' + CHAT_STYLE
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt2 }],
        source: { kind: 'qq-followup' },
      })
      diag('群后续 → 会话：群 ' + gid + ' ' + lines2.join(' | ').slice(0, 240))
    }
  } catch (error) {
    diag('@ 轮询出错：' + String((error && error.message) || error))
  } finally {
    busy = false
  }
}

export function startMentionPolling(ctx) {
  // 组件重新加载时从头开始，避免把停用期间的旧 @ 一次性翻出来。
  resetQqState()
  lastSeen = new Map()
  seen = new Set()
  busy = false
  noAgentAt = 0
  ctx.effect(() => ctx.interval(() => pollMentions(ctx), loadCfg().pollMs))
}
