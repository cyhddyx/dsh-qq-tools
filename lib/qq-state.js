// QQ 运行时状态：登录号缓存 + 群名缓存。
import { onebot } from './onebot.js'
import { clean } from './utils.js'

// 这两份数据以前混在 @ 轮询里，被私聊/戳一戳/私聊记录共用；拆出来避免模块之间互相 import。
let selfId = ''
let names = new Map()
let namesAt = 0

// 当前登录的 QQ 号。第一次用到时向 SnowLuma 查一次，之后复用。
export async function getSelfId(cfg) {
  if (selfId) return selfId
  try {
    const info = await onebot('get_login_info', {}, cfg)
    selfId = String((info && info.user_id) || '')
  } catch (error) {}
  return selfId
}

// 只读缓存，不发请求；戳一戳事件本身带 self_id，缺省时保持原来的行为（不额外查登录号）。
export function cachedSelfId() {
  return selfId
}

// 群名缓存拿不到时退回群号，和原来的 `names.get(gid) || gid` 一致。
export function groupName(groupId) {
  const id = String(groupId)
  return names.get(id) || id
}

async function refreshNames(cfg) {
  if (names.size && Date.now() - namesAt < 300000) return
  try {
    const data = await onebot('get_group_list', {}, cfg)
    const next = new Map()
    for (const g of Array.isArray(data) ? data : []) next.set(String(g.group_id), clean(g.group_name || g.group_id))
    if (next.size) {
      names = next
      namesAt = Date.now()
    }
  } catch (error) {}
}

export { refreshNames }

// 组件重新加载时从头开始，避免把停用期间的旧状态带进新实例。
export function resetQqState() {
  selfId = ''
  names = new Map()
  namesAt = 0
}
