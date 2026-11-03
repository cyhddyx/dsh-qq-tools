// 工具结果的文本渲染，以及常见的列表取值。

export function renderTool(_args, v) {
  if (!v || !v.ok) return [{ type: 'text', text: 'QQ 工具失败：' + String((v && v.error) || '未知错误') }]
  if (Array.isArray(v.groups)) {
    if (!v.groups.length) return [{ type: 'text', text: '现在没有允许查看的群。' }]
    return [{ type: 'text', text: '可以去的群：\n' + v.groups.map((g) => `- ${g.name || g.id}（群号 ${g.id}，${g.member_count} 人）`).join('\n') }]
  }
  if (Array.isArray(v.friends)) {
    if (!v.friends.length) return [{ type: 'text', text: v.query ? '没有匹配的好友。' : '好友列表是空的。' }]
    const lines = v.friends.map((f) => `- ${f.remark || f.nickname || f.user_id}（${f.nickname || ''}，QQ ${f.user_id}）`)
    return [{ type: 'text', text: `你的好友（${v.total} 个）：\n` + lines.join('\n') }]
  }
  if (Array.isArray(v.messages)) {
    const where = v.group_id != null ? `群 ${v.group_id}` : `QQ ${v.user_id}`
    if (!v.messages.length) return [{ type: 'text', text: `${where} 最近没有消息。` }]
    const lines = v.messages.map((m) => `${m.t || ''} [#${m.message_id || '?'}] ${m.sender}(${m.user_id})：${m.text || '（空）'}`)
    const blocks = [{ type: 'text', text: `${where} 最近 ${v.count} 条：\n` + lines.join('\n') }]
    if (Array.isArray(v.images) && v.images.length) {
      blocks.push({ type: 'text', text: '下面是这些图片（按消息顺序）：' })
      for (const img of v.images) {
        if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
        if (img && img.block) blocks.push(img.block)
      }
    }
    return blocks
  }
  if (Array.isArray(v.members)) {
    const lines = v.members.map((m) => `- ${m.card || m.nickname || m.user_id}（QQ ${m.user_id}，${m.role || 'member'}）`)
    return [{ type: 'text', text: `群 ${v.group_id} 成员：\n` + (lines.join('\n') || '（空）') }]
  }
  if (v.poke) {
    return [{ type: 'text', text: `戳回去了：${v.group_id ? '群 ' + v.group_id : '私聊'} QQ ${v.user_id}。` }]
  }
  if (v.group_id != null && v.message_id != null) {
    return [{ type: 'text', text: `已发到群 ${v.group_id}（消息 ${v.message_id || '?'}）。` }]
  }
  if (v.user_id != null && v.message_id != null) {
    return [{ type: 'text', text: `已发给 QQ ${v.user_id}（消息 ${v.message_id || '?'}）。` }]
  }
  return [{ type: 'text', text: JSON.stringify(v).slice(0, 2000) }]
}


export function listOf(data, key) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[key])) return data[key]
  return []
}
