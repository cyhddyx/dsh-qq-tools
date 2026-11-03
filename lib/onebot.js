// SnowLuma（OneBot 11 风格）HTTP 接口封装。

export async function onebot(action, body, cfg) {
  const base = String(cfg.napCat || '').replace(/\/+$/, '')
  if (!base) throw new Error('没有配置 SnowLuma 地址')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('SnowLuma 请求超时')), cfg.timeoutMs || 6000)
  try {
    const headers = { 'content-type': 'application/json' }
    if (cfg.accessToken) headers.authorization = 'Bearer ' + cfg.accessToken
    const r = await fetch(base + '/' + action, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    })
    const text = await r.text()
    let data
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new Error('SnowLuma 返回不是 JSON：' + text.slice(0, 200))
    }
    if (!r.ok) throw new Error('SnowLuma HTTP ' + r.status + '：' + text.slice(0, 200))
    if (data && data.status && data.status !== 'ok') {
      throw new Error('SnowLuma 错误：' + String(data.message || data.wording || ('retcode ' + data.retcode)))
    }
    return data && data.data !== undefined ? data.data : data
  } finally {
    clearTimeout(timer)
  }
}
