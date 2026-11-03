// 好友管理：资料/备注/分组/删好友/名片赞/好友申请收件箱。

import { loadCfg, allowedPrivate, diag } from '../config.js'
import { onebot } from '../onebot.js'
import { clean } from '../utils.js'
import { renderTool } from '../render.js'
import { startWsWatcher } from '../watchers/ws.js'

// ---------- 好友管理 ----------
// 读写好友资料、备注、分组、名片赞，以及好友申请。
// 普通好友申请只有 request 事件，SnowLuma 没有「列出历史好友申请」的 HTTP 接口，
// 所以这里一边接 WebSocket 事件进收件箱，一边用 get_doubt_friends_add_request
// 拿服务端保存的可疑申请；历史普通申请只能去 QQ 客户端看。
const FRIEND_REQUEST_LIMIT = 30
const friendRequestInbox = new Map()

function rememberFriendRequest(ev) {
  const flag = clean(ev && ev.flag)
  if (!flag) return
  const userId = String((ev && ev.user_id) || '')
  const time = Number(ev && ev.time) || Math.floor(Date.now() / 1000)
  friendRequestInbox.set(flag, {
    flag,
    user_id: userId,
    nickname: '',
    comment: String((ev && ev.comment) || '').slice(0, 500),
    time,
    at: Date.now(),
  })
  if (friendRequestInbox.size > FRIEND_REQUEST_LIMIT) {
    const oldest = [...friendRequestInbox.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0]
    if (oldest) friendRequestInbox.delete(oldest[0])
  }
  diag('好友申请 → 收件箱：' + userId + ' ' + clean(ev && ev.comment).slice(0, 120))
}

async function friendEntryOf(cfg, userId) {
  try {
    const groups = await onebot('get_friends_with_category', {}, cfg)
    if (Array.isArray(groups) && groups.length) {
      for (const g of groups) {
        const list = Array.isArray(g && g.buddyList) ? g.buddyList : []
        const hit = list.find((b) => String(b && b.user_id) === String(userId))
        if (hit) {
          const categoryId = Number(g.categoryId)
          return {
            entry: hit,
            category: { id: Number.isFinite(categoryId) ? categoryId : 0, name: clean(g.categoryName) },
          }
        }
      }
    }
  } catch (error) {}
  // 分组接口不可用（或好友不在分组结果里）时退回普通好友列表：
  // 至少能判断是不是好友、拿到备注。
  try {
    const data = await onebot('get_friend_list', {}, cfg)
    const hit = (Array.isArray(data) ? data : []).find((f) => String(f && f.user_id) === String(userId))
    if (hit) return { entry: hit, category: null }
  } catch (error) {}
  return null
}

// 接口不可用时返回 null（未知），不要谎报「不是单向好友」。
async function oneWayOf(cfg, userId) {
  try {
    const list = await onebot('get_unidirectional_friend_list', {}, cfg)
    return (Array.isArray(list) ? list : []).some((x) => {
      const id = x && typeof x === 'object'
        ? String(x.user_id || x.uin || x.qq || '')
        : String(x || '')
      return !!id && id === String(userId)
    })
  } catch (error) {
    return null
  }
}

function sexText(value) {
  const s = String(value == null ? '' : value).toLowerCase()
  if (s === 'male' || s === '1' || s === '男') return '男'
  if (s === 'female' || s === '2' || s === '女') return '女'
  if (!s || s === '0' || s === 'unknown' || s === '未知') return '未知'
  return clean(value)
}

export function makeGetFriendInfoTool() {
  return {
    name: 'qq_get_friend_info',
    description:
      '看某个 QQ 的资料和好友关系：昵称、备注、分组、性别年龄、等级、VIP、是否单向好友。' +
      'user_id 从 qq_list_friends、聊天记录或好友申请里拿。只读。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '对方 QQ 号' },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      let info = null
      let infoError = ''
      try {
        info = await onebot('get_stranger_info', { user_id: userId }, cfg)
      } catch (error) {
        infoError = String((error && error.message) || error)
      }
      const found = await friendEntryOf(cfg, userId)
      if (!info && !found) {
        return { ok: false, error: infoError || '查不到这个 QQ 的资料' }
      }
      const entry = (found && found.entry) || {}
      const oneWay = await oneWayOf(cfg, userId)
      const rawLevel = info
        ? (info.qq_level != null ? info.qq_level : info.qqLevel != null ? info.qqLevel : info.level)
        : 0
      const friend = {
        user_id: String(userId),
        nickname: clean((info && info.nickname) || entry.nickname),
        remark: clean(entry.remark || (info && info.remark)),
        category: found ? found.category : null,
        sex: sexText(info && info.sex),
        age: Number((info && info.age) || 0),
        qid: clean(info && info.qid),
        level: Number(rawLevel || 0),
        vip: !!(info && info.is_vip),
        vip_level: Number((info && info.vip_level) || 0),
        is_friend: !!found,
        one_way: oneWay,
      }
      return { ok: true, friend }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看好友资料失败：' + String((v && v.error) || '未知错误') }]
      const f = v.friend || {}
      const lines = [
        `QQ ${f.user_id}：`,
        '- 昵称：' + (f.nickname || '未知'),
        '- 备注：' + (f.remark || '（无）'),
        '- 分组：' + (f.category ? `${f.category.name || '未命名'}（id ${f.category.id}）` : (f.is_friend ? '未知（分组接口没返回）' : '不是好友')),
        '- 性别年龄：' + (f.sex || '未知') + (f.age ? '，' + f.age + ' 岁' : ''),
        '- 等级：' + (f.level || '未知'),
        '- VIP：' + (f.vip ? '是' + (f.vip_level ? '（' + f.vip_level + ' 级）' : '') : '否'),
        '- 单向好友：' + (f.one_way === true ? '是' : f.one_way === false ? '否' : '未知（接口不可用）'),
      ]
      if (f.qid) lines.splice(2, 0, '- QID：' + f.qid)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }
}

export function makeListFriendCategoriesTool() {
  return {
    name: 'qq_list_friend_categories',
    description:
      '看好友分组和每个分组里的好友（SnowLuma get_friends_with_category）。' +
      '移动好友分组时，category_id / category_name 从这里拿。' +
      '分组接口漏掉的好友会补进「未分组（接口未返回）」里。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute() {
      const cfg = loadCfg()
      try {
        let categories = []
        let usedFriendListFallback = false
        try {
          const data = await onebot('get_friends_with_category', {}, cfg)
          if (!Array.isArray(data)) throw new Error('好友分组接口返回的不是数组')
          categories = data.map((g) => ({
            id: Number.isFinite(Number(g && g.categoryId)) ? Number(g.categoryId) : 0,
            name: clean(g && g.categoryName),
            count: Number((g && g.categoryMbCount) || 0),
            friends: (Array.isArray(g && g.buddyList) ? g.buddyList : []).map((b) => ({
              user_id: String((b && b.user_id) || ''),
              nickname: clean(b && b.nickname),
              remark: clean(b && b.remark),
            })),
          }))
        } catch (error) {
          // 老版本 SnowLuma 没有分组接口时，退回普通好友列表，至少还能看到人。
          const data = await onebot('get_friend_list', {}, cfg)
          const friends = (Array.isArray(data) ? data : []).map((f) => ({
            user_id: String((f && f.user_id) || ''),
            nickname: clean(f && f.nickname),
            remark: clean(f && f.remark),
          }))
          categories = [{ id: 0, name: '我的好友', count: friends.length, friends }]
          usedFriendListFallback = true
        }
        // SnowLuma 的分组接口可能漏人（真机见过 86 个好友只返回 83 个），
        // 用普通好友列表补齐，免得模型以为这些人不存在。
        if (!usedFriendListFallback) {
          try {
            const data = await onebot('get_friend_list', {}, cfg)
            const known = new Set()
            for (const c of categories) for (const f of c.friends) known.add(f.user_id)
            const missing = (Array.isArray(data) ? data : []).map((f) => ({
              user_id: String((f && f.user_id) || ''),
              nickname: clean(f && f.nickname),
              remark: clean(f && f.remark),
            })).filter((f) => f.user_id && !known.has(f.user_id))
            if (missing.length) {
              categories.push({ id: -1, name: '未分组（接口未返回）', count: missing.length, friends: missing })
            }
          } catch (error) {}
        }
        for (const c of categories) {
          c.friends = c.friends.filter((f) => f.user_id && allowedPrivate(f.user_id, cfg))
          c.count = c.friends.length
        }
        const total = categories.reduce((n, c) => n + c.friends.length, 0)
        return { ok: true, total, categories }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看好友分组失败：' + String((v && v.error) || '未知错误') }]
      if (!v.categories.length) return [{ type: 'text', text: '没有好友分组。' }]
      const lines = [`好友分组（${v.categories.length} 个，共 ${v.total} 人）：`]
      for (const c of v.categories) {
        const names = c.friends.slice(0, 20).map((f) => f.remark || f.nickname || f.user_id)
        const idText = c.id >= 0 ? `id ${c.id}，` : ''
        lines.push(`- ${c.name || '未命名'}（${idText}${c.count} 人）${names.length ? '：' + names.join('、') : ''}${c.friends.length > names.length ? ' …' : ''}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }
}

export function makeUpdateFriendTool() {
  return {
    name: 'qq_update_friend',
    description:
      '改好友备注或把好友移到别的分组。' +
      'remark 传空字符串表示清空备注；分组用 category_id 或 category_name（名称必须唯一且完全匹配），' +
      '分组 id/名称从 qq_list_friend_categories 拿。两件事至少做一件。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '好友 QQ 号' },
        remark: { type: 'string', description: '新备注；传空字符串清空；不传就不改备注' },
        category_id: { type: 'number', description: '目标分组 ID' },
        category_name: { type: 'string', description: '目标分组名称（完全匹配）' },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      const hasRemark = args && args.remark != null
      const remark = clean(args && args.remark)
      const hasCategoryId = args && args.category_id != null && args.category_id !== ''
      const categoryId = hasCategoryId ? Number(args.category_id) : null
      const categoryName = clean(args && args.category_name)
      if (!hasRemark && !hasCategoryId && !categoryName) {
        return { ok: false, error: '要改什么？传 remark，或 category_id / category_name' }
      }
      if (hasCategoryId && !Number.isInteger(categoryId)) return { ok: false, error: 'category_id 不是有效整数' }
      try {
        const changes = []
        if (hasRemark) {
          await onebot('set_friend_remark', { user_id: userId, remark }, cfg)
          changes.push(remark ? '备注改成「' + remark + '」' : '备注已清空')
        }
        if (hasCategoryId || categoryName) {
          let targetId = categoryId
          let targetName = categoryName
          if (!hasCategoryId) {
            try {
              const data = await onebot('get_friends_with_category', {}, cfg)
              const hits = (Array.isArray(data) ? data : []).filter((g) => clean(g && g.categoryName) === categoryName)
              if (hits.length !== 1) {
                return {
                  ok: false,
                  error: (hits.length
                    ? `有 ${hits.length} 个分组都叫「${categoryName}」，请改用 category_id`
                    : `没找到叫「${categoryName}」的分组，先用 qq_list_friend_categories 看`)
                    + (changes.length ? '（已' + changes.join('；') + '）' : ''),
                  changed: changes,
                }
              }
              targetId = Number(hits[0].categoryId)
              if (!Number.isInteger(targetId)) targetId = null
              targetName = clean(hits[0].categoryName)
            } catch (error) {
              // 分组列表接口不可用时直接让 SnowLuma 按名称处理。
              targetId = null
            }
          }
          const body = { uin: userId }
          if (targetId != null) body.categoryId = targetId
          else if (targetName) body.categoryName = targetName
          await onebot('set_friends_category', body, cfg)
          changes.push('移到分组「' + (targetName || targetId) + '」')
        }
        return { ok: true, user_id: userId, remark: hasRemark ? remark : undefined, changes }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '改好友资料失败：' + String((v && v.error) || '未知错误') }]
      return [{ type: 'text', text: `QQ ${v.user_id} 已更新：${(v.changes || []).join('；')}。` }]
    },
  }
}

export function makeDeleteFriendTool() {
  return {
    name: 'qq_delete_friend',
    description:
      '删除一个好友。不可撤销：只有用户明确要求删好友时才用，并且必须传 confirm=true。' +
      'block=true 会在删除的同时屏蔽对方。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '好友 QQ 号' },
        block: { type: 'boolean', description: 'true = 删除并屏蔽，默认 false' },
        confirm: { type: 'boolean', description: '必须显式传 true，防止误删' },
      },
      required: ['user_id', 'confirm'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      if (!args || args.confirm !== true) return { ok: false, error: '删好友不可撤销，需要 confirm=true 才会执行' }
      try {
        const block = args.block === true
        await onebot('delete_friend', { user_id: userId, block }, cfg)
        return { ok: true, removed: true, user_id: userId, blocked: block }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '删好友失败：' + String((v && v.error) || '未知错误') }]
      return [{ type: 'text', text: `已删除好友 QQ ${v.user_id}${v.blocked ? '，并已屏蔽' : ''}。` }]
    },
  }
}

export function makeSendLikeTool() {
  return {
    name: 'qq_send_like',
    description:
      '给好友的名片点赞（QQ 资料卡赞）。times 是次数，默认 1，最多 20。别频繁调用。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'number', description: '好友 QQ 号' },
        times: { type: 'number', description: '点赞次数，默认 1，最多 20' },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const userId = Number(args && args.user_id)
      if (!Number.isFinite(userId)) return { ok: false, error: 'user_id 不是有效 QQ 号' }
      if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      const times = Math.max(1, Math.min(Math.floor(Number(args && args.times) || 1), 20))
      try {
        await onebot('send_like', { user_id: userId, times }, cfg)
        return { ok: true, user_id: userId, times }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '点赞失败：' + String((v && v.error) || '未知错误') }]
      return [{ type: 'text', text: `已给 QQ ${v.user_id} 点了 ${v.times} 个赞。` }]
    },
  }
}

export function makeListFriendRequestsTool() {
  return {
    name: 'qq_list_friend_requests',
    description:
      '看待处理的好友申请：插件运行期间通过 WebSocket 收到的普通申请 + QQ 账号里保存的可疑好友申请。' +
      '每项带 flag，用 qq_handle_friend_request 同意/拒绝。' +
      '普通申请只在插件启动后收到才在这里，历史申请要去 QQ 客户端看。只读。',
    parameters: {
      type: 'object',
      properties: {
        include_doubt: { type: 'boolean', description: '要不要一起查可疑好友申请，默认 true' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const includeDoubt = !(args && args.include_doubt === false)
      const requests = [...friendRequestInbox.values()]
        .sort((a, b) => (b.time || 0) - (a.time || 0) || (b.at || 0) - (a.at || 0))
        .slice(0, FRIEND_REQUEST_LIMIT)
      if (requests.length) {
        await Promise.all(requests.slice(0, 5).map(async (r) => {
          if (r.nickname || !r.user_id) return
          try {
            const info = await onebot('get_stranger_info', { user_id: Number(r.user_id) }, cfg)
            r.nickname = clean(info && info.nickname)
          } catch (error) {}
        }))
      }
      let doubt = []
      let doubtError = ''
      if (includeDoubt) {
        try {
          const data = await onebot('get_doubt_friends_add_request', { count: 50 }, cfg)
          doubt = (Array.isArray(data) ? data : []).map((x) => ({
            kind: 'doubt',
            flag: String((x && x.uid) || ''),
            user_id: String((x && x.user_id) || ''),
            nickname: clean(x && x.nick),
            source: clean(x && x.source),
            reason: clean(x && x.reason),
            comment: String((x && x.msg) || '').slice(0, 500),
            group_code: String((x && x.group_code) || ''),
            time: Number((x && x.reqTime) || 0),
          })).filter((x) => x.flag)
        } catch (error) {
          doubtError = String((error && error.message) || error)
        }
      }
      return {
        ok: true,
        requests: requests.map(({ at, ...r }) => ({ kind: 'friend', ...r })),
        doubt,
        doubt_error: doubtError,
        inbox_note: '普通申请从插件启动后开始收，历史申请不在收件箱里',
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看好友申请失败：' + String((v && v.error) || '未知错误') }]
      const lines = []
      if (v.requests.length) {
        lines.push(`普通好友申请（${v.requests.length} 个）：`)
        for (const r of v.requests) {
          const who = r.nickname ? `${r.nickname}(${r.user_id})` : `QQ ${r.user_id}`
          lines.push(`- ${who}${r.comment ? '：' + r.comment : ''}  flag=${r.flag}`)
        }
      }
      if (v.doubt.length) {
        lines.push(`可疑好友申请（${v.doubt.length} 个）：`)
        for (const d of v.doubt) {
          const who = d.nickname ? `${d.nickname}(${d.user_id})` : `QQ ${d.user_id}`
          const extra = [d.source && '来源 ' + d.source, d.reason && '原因 ' + d.reason].filter(Boolean).join('，')
          lines.push(`- ${who}${extra ? '（' + extra + '）' : ''}${d.comment ? '：' + d.comment : ''}  flag=${d.flag}`)
        }
      }
      if (!v.requests.length && !v.doubt.length) {
        lines.push(v.doubt_error
          ? '现在没有普通好友申请；可疑申请接口不可用：' + v.doubt_error.slice(0, 200)
          : '现在没有待处理的好友申请。')
      } else if (v.doubt_error) {
        lines.push('可疑申请接口不可用：' + v.doubt_error.slice(0, 200))
      }
      if (v.requests.length || v.doubt.length) {
        lines.push('用 qq_handle_friend_request 处理：传 flag、kind（friend/doubt）、approve=true/false。')
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }
}

export function makeHandleFriendRequestTool() {
  return {
    name: 'qq_handle_friend_request',
    description:
      '同意或拒绝好友申请。flag 从 qq_list_friend_requests 拿，也可以传 user_id 自动在待处理列表里找。' +
      'kind=friend 是普通申请，kind=doubt 是可疑申请。approve 必须明确传 true（同意）或 false（拒绝）。',
    parameters: {
      type: 'object',
      properties: {
        flag: { type: 'string', description: '申请的处理标识，来自 qq_list_friend_requests' },
        user_id: { type: 'number', description: '申请人 QQ 号；不传 flag 时用它查收件箱' },
        kind: { type: 'string', enum: ['friend', 'doubt'], description: '申请类型，默认 friend' },
        approve: { type: 'boolean', description: 'true = 同意，false = 拒绝' },
      },
      required: ['approve'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const kind = args && args.kind === 'doubt' ? 'doubt' : 'friend'
      const userId = args && args.user_id != null ? Number(args.user_id) : 0
      if (args && args.user_id != null && !Number.isFinite(userId)) {
        return { ok: false, error: 'user_id 不是有效 QQ 号' }
      }
      if (!args || typeof args.approve !== 'boolean') return { ok: false, error: 'approve 必须明确传 true 或 false' }
      const approve = args.approve
      let flag = clean(args && args.flag)
      let nickname = ''
      if (!flag && userId) {
        if (kind === 'friend') {
          const hit = [...friendRequestInbox.values()]
            .filter((r) => String(r.user_id) === String(userId))
            .sort((a, b) => (b.at || 0) - (a.at || 0))[0]
          if (hit) {
            flag = hit.flag
            nickname = hit.nickname
          }
        } else {
          try {
            const data = await onebot('get_doubt_friends_add_request', { count: 50 }, cfg)
            const hit = (Array.isArray(data) ? data : []).find((x) => String((x && x.user_id) || '') === String(userId))
            if (hit) {
              flag = String((hit && hit.uid) || '')
              nickname = clean(hit && hit.nick)
            }
          } catch (error) {}
        }
      }
      if (!flag) {
        return { ok: false, error: '没有找到要处理的申请；先用 qq_list_friend_requests 拿 flag' }
      }
      try {
        if (kind === 'doubt') {
          await onebot('set_doubt_friends_add_request', { flag, approve }, cfg)
        } else {
          await onebot('set_friend_add_request', { flag, approve }, cfg)
          friendRequestInbox.delete(flag)
        }
        return { ok: true, kind, approved: approve, flag, user_id: userId || null, nickname }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '处理好友申请失败：' + String((v && v.error) || '未知错误') }]
      const who = v.nickname ? `${v.nickname}(${v.user_id || ''})` : (v.user_id ? 'QQ ' + v.user_id : '这条申请')
      return [{ type: 'text', text: `已${v.approved ? '同意' : '拒绝'}${who}的好友申请。` }]
    },
  }
}

export function startFriendRequestWatcher(ctx) {
  startWsWatcher(ctx, '好友申请', () => true, (ev) => {
    if (ev && ev.post_type === 'request' && ev.request_type === 'friend') rememberFriendRequest(ev)
  })
}
