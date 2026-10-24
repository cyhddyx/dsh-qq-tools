// dsh-qq-tools 的浏览器半侧：左侧栏「挂载会话」入口 + 插件行配置页。
// 会话列表来自 slot 自带的 useSessions，归档集合来自 useWorkspaces；
// 读写走宿主半侧的 /api/dsh-qq-tools/target-session，最终仍然落在
// ~/.dsh/qq-tools-config.json 的 targetSession 字段上。
window.__ModuleLoader__.load({
  id: 'dsh-qq-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const NS = 'qq-tools'
    const API = '/api/dsh-qq-tools/target-session'
    const SLOT_KEY = 'dsh-qq-tools#qq-tools-root'
    const PANEL_ID = 'qq-tools-target-session'
    const PANEL_ORDER = 50
    const EMPTY_IDS = []

    const zh = {
      summary: 'QQ 消息挂载会话',
      sidebarLabel: '挂载会话',
      panelTitle: '挂载会话',
      description: '只有这里选中的 DSH 会话会收到 QQ 群 @、群后续、私聊和戳一戳；QQ 工具也只挂在这个会话上。保存后约 3 秒生效。',
      none: '不挂载（关闭 QQ 唤醒）',
      untitled: '未命名会话',
      running: '（运行中）',
      missing: '当前目标（会话未运行）',
      archived: '当前目标（已归档）',
      refresh: '刷新',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，约 3 秒内生效',
      loading: '读取中…',
      failed: '操作失败：',
      current: '当前挂载：',
      empty: '当前没有挂载任何会话。',
      unavailable: '接口不可用。请先在插件页启用「挂载会话」组件。',
    }

    const en = {
      summary: 'QQ target session',
      sidebarLabel: 'Target session',
      panelTitle: 'Target session',
      description: 'Only the selected DSH session receives QQ mentions, follow-ups, private messages and pokes; QQ tools are mounted there too. Changes apply within about 3 seconds.',
      none: 'Do not mount (disable QQ wake-ups)',
      untitled: 'Untitled session',
      running: ' (running)',
      missing: 'Current target (not running)',
      archived: 'Current target (archived)',
      refresh: 'Refresh',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; applies within about 3 seconds',
      loading: 'Loading…',
      failed: 'Request failed: ',
      current: 'Mounted to: ',
      empty: 'No session is mounted.',
      unavailable: 'Endpoint unavailable. Enable the "Target session" component on the plugin page first.',
    }

    const inject = ['slots', 'locale']

    function shortId(id) {
      const s = String(id || '')
      return s.length > 12 ? s.slice(0, 8) + '…' : s
    }

    // 宿主在插件行未启用时返回 404/HTML；先把文本读出来再解析，避免 r.json() 直接抛。
    function readJsonResponse(response) {
      return response.text().then((text) => {
        let body = {}
        try { body = text ? JSON.parse(text) : {} } catch (error) {}
        return { ok: response.ok, body }
      })
    }

    function TargetSessionCard(props) {
      const t = props.t
      const list = props.useSessions((state) => state)
      const useWorkspaces = props.useWorkspaces || (() => EMPTY_IDS)
      const archivedSessionIds = useWorkspaces((state) => (state && state.archivedSessionIds) || EMPTY_IDS) || EMPTY_IDS
      const archived = react.useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])
      const [current, setCurrent] = react.useState('')
      const [selected, setSelected] = react.useState('')
      const [liveIds, setLiveIds] = react.useState([])
      const [phase, setPhase] = react.useState('loading')
      const [detail, setDetail] = react.useState('')
      const [loaded, setLoaded] = react.useState(false)

      const load = react.useCallback(() => {
        setPhase('loading')
        setDetail('')
        fetch(API, { headers: { accept: 'application/json' } })
          .then(readJsonResponse)
          .then(({ ok, body }) => {
            if (!ok || !body || body.ok !== true) {
              throw new Error((body && body.error) || t('unavailable'))
            }
            const value = typeof body.targetSession === 'string' ? body.targetSession : ''
            setCurrent(value)
            setSelected(value)
            setLiveIds(Array.isArray(body.liveSessionIds) ? body.liveSessionIds : [])
            setLoaded(true)
            setPhase('ready')
          })
          .catch((error) => {
            setDetail(String((error && error.message) || error))
            setPhase('error')
          })
      }, [t])

      react.useEffect(() => {
        load()
      }, [load])

      const save = react.useCallback(() => {
        setPhase('saving')
        setDetail('')
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ targetSession: selected }),
        })
          .then(readJsonResponse)
          .then(({ ok, body }) => {
            if (!ok || !body || body.ok !== true) {
              throw new Error((body && body.error) || 'save failed')
            }
            const value = typeof body.targetSession === 'string' ? body.targetSession : ''
            setCurrent(value)
            setSelected(value)
            setPhase('saved')
          })
          .catch((error) => {
            setDetail(String((error && error.message) || error))
            setPhase('error')
          })
      }, [selected])

      const sessions = react.useMemo(() => {
        const ids = Array.isArray(list && list.ids) ? list.ids : []
        const byId = (list && list.byId) || {}
        return ids.map((id) => byId[id]).filter(Boolean)
      }, [list])

      const options = [h('option', { key: '__none', value: '' }, t('none'))]
      let selectedInList = false
      for (const session of sessions) {
        if (!session || !session.id) continue
        if (session.origin === 'subagent') continue
        if (archived.has(session.id)) continue
        if (session.id === selected) selectedInList = true
        const title = String(session.title || '').trim() || t('untitled')
        const running = session.running === true || liveIds.indexOf(session.id) >= 0
        options.push(h(
          'option',
          { key: session.id, value: session.id },
          title + ' · ' + shortId(session.id) + (running ? t('running') : ''),
        ))
      }
      if (selected && !selectedInList) {
        options.push(h(
          'option',
          { key: '__current', value: selected },
          (archived.has(selected) ? t('archived') : t('missing')) + ' · ' + shortId(selected),
        ))
      }

      if (props.view === 'summary') {
        return h('span', null, current ? t('current') + shortId(current) : t('empty'))
      }

      let statusText = ''
      let statusColor = 'var(--dsw-alias-label-tertiary)'
      if (phase === 'loading') statusText = t('loading')
      else if (phase === 'saving') statusText = t('saving')
      else if (phase === 'saved') {
        statusText = t('saved')
        statusColor = 'var(--dsw-alias-state-success-primary, #2f9e44)'
      } else if (phase === 'error') {
        statusText = t('failed') + (detail || t('unavailable'))
        statusColor = 'var(--dsw-alias-state-error-primary, #d64545)'
      } else {
        statusText = current ? t('current') + shortId(current) : t('empty')
      }

      const disabled = !loaded || phase === 'saving'
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('p', {
          key: 'desc',
          style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
        }, t('description')),
        h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('select', {
            key: 'select',
            value: selected,
            disabled,
            onChange: (event) => {
              setSelected(event.target.value)
              if (phase === 'saved' || phase === 'error') setPhase('ready')
            },
            style: {
              minWidth: 280,
              maxWidth: '100%',
              height: 36,
              padding: '0 10px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l4)',
              background: 'var(--dsw-alias-bg-layer-3)',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 13,
              outline: 'none',
            },
          }, options),
          h('button', {
            key: 'refresh',
            type: 'button',
            disabled: phase === 'loading' || phase === 'saving',
            onClick: load,
            style: {
              height: 36,
              padding: '0 14px',
              borderRadius: 8,
              border: '0.5px solid var(--dsw-alias-border-l4)',
              background: 'var(--dsw-alias-bg-layer-3)',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            },
          }, t('refresh')),
          h('button', {
            key: 'save',
            type: 'button',
            disabled,
            onClick: save,
            style: {
              height: 36,
              padding: '0 16px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
              color: '#fff',
              font: 'inherit',
              fontSize: 13,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            },
          }, phase === 'saving' ? t('saving') : t('save')),
        ]),
        h('p', {
          key: 'status',
          style: { margin: 0, fontSize: 12, lineHeight: '18px', color: statusColor },
        }, statusText),
      ])
    }

    function TargetSessionIcon(props) {
      const size = Number(props && props.size) || 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        'data-dsh-panel-entry': PANEL_ID,
      }, [
        h('path', {
          key: 'bubble',
          d: 'M2.5 2.75h9a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H6.75L4 12.25V9.25H2.5a1.5 1.5 0 0 1-1.5-1.5v-3.5a1.5 1.5 0 0 1 1.5-1.5Z',
        }),
        h('path', { key: 'line1', d: 'M4.25 5.5h5.5' }),
        h('path', { key: 'line2', d: 'M4.25 7.75h3.25' }),
      ])
    }

    function TargetSessionPage(props) {
      const t = props.t
      return h('div', {
        style: {
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'auto',
          padding: '28px 36px 48px',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, [
        h('h1', {
          key: 'title',
          style: { margin: '0 0 18px', fontSize: 20, fontWeight: 600, lineHeight: '28px' },
        }, t('panelTitle')),
        h(TargetSessionCard, { key: 'card', ...props, view: 'page' }),
      ])
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'qq-tools: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => t('sidebarLabel'),
      }, TargetSessionIcon)), 'qq-tools: sidebar entry')
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, (props) => h(TargetSessionPage, { ...props, t }))), 'qq-tools: main panel')
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: SLOT_KEY,
        locale: NS,
      }, TargetSessionCard)), 'qq-tools: target session page')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
