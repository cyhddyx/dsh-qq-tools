// 戳一戳事件接收。

import { randomUUID } from 'node:crypto'
import { loadCfg, allowedPrivate, diag } from '../config.js'
import { onebot } from '../onebot.js'
import { clean } from '../utils.js'
import { hasActiveTool, targetSessionId, findAgent } from '../session.js'
import { FACE_STYLE, CHAT_STYLE } from '../prompts.js'
import { cachedSelfId, groupName as groupNameOf } from '../qq-state.js'
import { startWsWatcher } from './ws.js'

// ---------- 戳一戳（由「戳一戳」组件启动） ----------
const pokeSeen = new Set()
const memberNames = new Map()

async function memberName(groupId, userId) {
  const key = String(groupId) + ':' + String(userId)
  const hit = memberNames.get(key)
  if (hit && Date.now() - hit.at < 300000) return hit.name
  try {
    const d = await onebot('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) }, loadCfg())
    const name = clean((d && (d.card || d.nickname)) || userId)
    memberNames.set(key, { name, at: Date.now() })
    return name
  } catch (error) {
    return String(userId)
  }
}

async function handlePoke(ctx, ev) {
  const cfg = loadCfg()
  if (!cfg.pokeEnabled) return
  const self = String(ev.self_id || cachedSelfId() || '')
  const sender = String(ev.user_id || ev.sender_id || '')
  const target = String(ev.target_id || '')
  if (!self || !sender || sender === self) return
  if (target && target !== self) return
  const groupId = ev.group_id ? String(ev.group_id) : ''
  if (!groupId && !allowedPrivate(sender, cfg)) return
  const key = [ev.time, groupId, sender, target].join('|')
  if (pokeSeen.has(key)) return
  pokeSeen.add(key)
  if (pokeSeen.size > 300) pokeSeen.clear()
  const agent = findAgent(ctx.agents, targetSessionId())
  if (!agent) {
    diag('戳一戳：目标会话没有活着')
    return
  }
  const name = groupId ? await memberName(groupId, sender) : sender
  const groupName = groupId ? groupNameOf(groupId) : ''
  let prompt
  if (groupId) {
    const actions = []
    if (hasActiveTool('qq_send_group_message')) actions.push('想回就用 qq_send_group_message 发到这个群')
    if (hasActiveTool('qq_send_face')) actions.push('想回个表情用 qq_send_face（group_id=' + groupId + '）')
    if (hasActiveTool('qq_send_poke')) actions.push(`想戳回去用 qq_send_poke（group_id=${groupId}, user_id=${sender}）`)
    prompt = `【戳一戳】群「${groupName}」里 ${name}(${sender}) 戳了你一下。`
      + (actions.length ? actions.join('；') + '。不想回就安静待着。' : '不用回复。')
      + (hasActiveTool('qq_send_face') ? FACE_STYLE : '')
      + CHAT_STYLE
  } else {
    const actions = []
    if (hasActiveTool('qq_send_private_message')) actions.push(`想回就用 qq_send_private_message（user_id=${sender}）`)
    if (hasActiveTool('qq_send_face')) actions.push(`想回表情用 qq_send_face（user_id=${sender}）`)
    if (hasActiveTool('qq_send_poke')) actions.push(`想戳回去用 qq_send_poke（user_id=${sender}）`)
    prompt = `【戳一戳】${sender} 在私聊里戳了你一下。`
      + (actions.length ? actions.join('；') + '。不想回就安静待着。' : '不用回复。')
      + (hasActiveTool('qq_send_face') ? FACE_STYLE : '')
      + CHAT_STYLE
  }
  const sourceKind = groupId ? 'qq-poke' : 'qq-private'
  await agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: sourceKind },
  })
  diag('戳一戳 → 会话：' + (groupId ? '群 ' + groupId : '私聊') + ' ' + sender)
}

export function startPokeWatcher(ctx) {
  startWsWatcher(ctx, '戳一戳', (cfg) => cfg.pokeEnabled, (ev) => {
    if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
      return handlePoke(ctx, ev)
    }
  })
}
