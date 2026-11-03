// 观察窗：群聊发消息 / 戳回去之后的后续消息，只对群生效。
import { loadCfg, diag } from './config.js'

// ---------- 观察窗（群聊发消息 / 戳回去之后的后续消息） ----------
// 私聊不走观察窗：每条私聊消息都会直接唤醒目标会话。
const windows = new Map()

export function startObservation(groupId, reason) {
  const cfg = loadCfg()
  const id = String(groupId || '')
  if (!id) return
  const ms = Math.max(30000, Math.min(Number(cfg.observationMs) || 60000, 600000))
  windows.set(id, Date.now() + ms)
  diag('观察窗：群 ' + id + ' 保持 ' + Math.round(ms / 1000) + ' 秒（' + String(reason || '') + '）')
}

export function windowUntil(groupId) {
  return windows.get(String(groupId)) || 0
}

export function pruneExpiredWindows() {
  const now = Date.now()
  for (const [gid, until] of windows) if (now >= until) windows.delete(gid)
}
