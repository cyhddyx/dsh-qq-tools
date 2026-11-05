// @ 提醒与群后续轮询。

import { randomUUID } from 'node:crypto'
import { loadCfg, diag } from '../config.js'
import { onebot } from '../onebot.js'
import { clean, segText, animatedSeg, pickChatImages } from '../utils.js'
import { listOf } from '../render.js'
import { formatIncomingLine, favoriteHint, FACE_STYLE, CHAT_STYLE, lookHint } from '../prompts.js'
import { hasActiveTool, targetSessionId, findAgent } from '../session.js'
import { windowUntil, pruneExpiredWindows } from '../observation.js'
import { getSelfId, refreshNames, groupName, resetQqState } from '../qq-state.js'

// ---------- 唤醒提示里带图 ----------
// 以前 @ 提醒和群后续只发文字，群里的图在提示里只剩 [图片#N] 占位，
// 模型得自己再调一次 qq_get_group_history 才看得到，不调就等于没收到。
// 现在和私聊唤醒对齐：唤醒消息里的图片、表情包（mface，商城表情在 QQ
// 这边也是一张图）一起送进会话；一次唤醒最多 10 张，和看聊天记录走同一个
// 上限和同一个挑图函数（pickChatImages），动图优先。
const PUSH_IMAGE_LIMIT = 10

// 一条唤醒可能带好几条消息：名额分配和看聊天记录一致，动图最多 3 张，
// 剩下的名额按时间给静图。
export function pickPushImages(items, max = PUSH_IMAGE_LIMIT) {
  const picked = []
  for (const item of Array.isArray(items) ? items : []) {
    for (const seg of Array.isArray(item && item.segs) ? item.segs : []) {
      if (!seg || (seg.type !== 'image' && seg.type !== 'mface') || !seg.data) continue
      picked.push({ seg, item, animated: animatedSeg(seg) })
    }
  }
  return pickChatImages(picked, max)
}

function imageCaption(item, seg) {
  const group = (item && (item.group || item.gid)) || ''
  const who = String((item && item.sender) || '?') + (item && item.user_id ? '(' + item.user_id + ')' : '')
  const kind = seg && seg.type === 'mface' ? '表情包' : '图片'
  const mid = item && item.message_id != null ? '（消息 #' + item.message_id + '）' : ''
  return '群「' + group + '」' + who + ' 发的' + kind + mid
}

function imageNote(content) {
  const n = Array.isArray(content) ? content.filter((x) => x && x.type === 'image').length : 0
  return n ? '（带了 ' + n + ' 张图）' : ''
}

// 文字提示 + 最多 10 张图。取图失败就静默退回纯文字，唤醒本身不受影响。
export async function buildGroupPush(admitImages, cfg, items, text) {
  const content = [{ type: 'text', text }]
  if (typeof admitImages !== 'function') return content
  const picked = pickPushImages(items)
  if (!picked.length) return content
  try {
    const images = await admitImages(picked.map(({ seg, item, animated }, i) => ({
      data: seg.data,
      cfg,
      animated,
      name: String((seg.data && seg.data.file) || 'qq-group-' + (item && item.message_id) + '-' + i + '.jpg'),
      caption: imageCaption(item, seg),
    })))
    for (const img of images) {
      if (img && img.caption) content.push({ type: 'text', text: img.caption })
      if (img && img.block) content.push(img.block)
    }
  } catch (error) {
    diag('群聊唤醒带图失败：' + String((error && error.message) || error))
  }
  return content
}

// ---------- @ 提醒轮询（由「发群消息」组件启动） ----------
let lastSeen = new Map()
let seen = new Set()
let busy = false
let noAgentAt = 0

async function pollMentions(ctx, admitImages) {
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
            segs,
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
            segs,
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
    if (mentions.length) {
      const content = await buildGroupPush(admitImages, cfg, mentions, prompt)
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'qq-mention' },
      })
      diag('@ 提醒已送进会话：' + lines.join(' | ').slice(0, 300) + imageNote(content))
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
      const content2 = await buildGroupPush(admitImages, cfg, list, prompt2)
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: content2,
        source: { kind: 'qq-followup' },
      })
      diag('群后续 → 会话：群 ' + gid + ' ' + lines2.join(' | ').slice(0, 240) + imageNote(content2))
    }
  } catch (error) {
    diag('@ 轮询出错：' + String((error && error.message) || error))
  } finally {
    busy = false
  }
}

export function startMentionPolling(ctx, admitImages) {
  // 组件重新加载时从头开始，避免把停用期间的旧 @ 一次性翻出来。
  resetQqState()
  lastSeen = new Map()
  seen = new Set()
  busy = false
  noAgentAt = 0
  ctx.effect(() => ctx.interval(() => pollMentions(ctx, admitImages), loadCfg().pollMs))
}
