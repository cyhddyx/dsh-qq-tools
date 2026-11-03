// 通用 OneBot WebSocket 连接与重连。

import { loadCfg, diag } from '../config.js'

export function startWsWatcher(ctx, tag, enabled, onEvent) {
  let ws = null
  let stopped = false
  let timer = null

  function connectWs() {
    if (stopped) return
    const cfg = loadCfg()
    if (!enabled(cfg)) return
    const url = String(cfg.wsUrl || '')
    if (!url) return
    if (typeof WebSocket === 'undefined') {
      diag(tag + '：WS 不可用，当前 Node 没有 WebSocket')
      return
    }
    try {
      let targetUrl = url
      if (cfg.accessToken) {
        const u = new URL(url)
        u.searchParams.set('access_token', cfg.accessToken)
        targetUrl = u.toString()
      }
      const socket = new WebSocket(targetUrl)
      ws = socket
      socket.onopen = () => diag(tag + '：WS 已连接')
      socket.onmessage = (event) => {
        try {
          const ev = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
          if (ev) {
            void Promise.resolve(onEvent(ev, cfg)).catch((error) =>
              diag(tag + '：处理事件失败 ' + String((error && error.message) || error)),
            )
          }
        } catch (error) {}
      }
      socket.onclose = () => {
        if (ws === socket) ws = null
        if (!stopped) timer = setTimeout(connectWs, 5000)
      }
      socket.onerror = () => {
        try { socket.close() } catch (error) {}
      }
    } catch (error) {
      diag(tag + '：WS 连接失败 ' + String((error && error.message) || error))
      if (!stopped) timer = setTimeout(connectWs, 5000)
    }
  }

  ctx.effect(() => {
    connectWs()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      try { if (ws) ws.close() } catch (error) {}
    }
  })
}
