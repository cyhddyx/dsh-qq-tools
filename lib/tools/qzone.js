// QQ 空间工具：说说列表、详情评论、发表、管理。

import { loadCfg, allowedPrivate } from '../config.js'
import { onebot } from '../onebot.js'
import { clean, cleanMultiline, fmtTime } from '../utils.js'
import { listOf, renderTool } from '../render.js'
import { imageSourceOf, imageSourcesFromMessage } from '../images.js'

// ---------- QQ 空间（说说） ----------
// SnowLuma 的「空间」扩展：send_qzone_msg / get_qzone_msg_list / get_qzone_feeds /
// get_qzone_msg_detail / like_qzone / unlike_qzone / comment_qzone /
// delete_qzone_msg / set_qzone_msg_right / set_qzone_ban。
// 图片统一走 imageSourceOf：http(s)、base64://、file://（本机路径会转成 file://）。
const QZONE_VISIBILITY = { public: 1, friends: 4, partial: 16, private: 64, exclude: 128 }
const QZONE_VISIBILITY_NAMES = {
  1: '所有人可见',
  4: '好友可见',
  16: '部分好友可见',
  64: '仅自己可见',
  128: '部分好友不可见',
}

function qzoneRightOf(value) {
  const key = String(value == null ? '' : value).trim()
  if (QZONE_VISIBILITY[key] != null) return QZONE_VISIBILITY[key]
  const n = Number(key)
  if (Number.isInteger(n) && QZONE_VISIBILITY_NAMES[n]) return n
  return 0
}

function plainText(s) {
  return clean(String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"))
}

function qzoneImagesOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      const url = String(x || '').trim()
      return url.startsWith('//') ? 'https:' + url : url
    })
    .filter((x) => /^https?:/i.test(x))
}

async function admitQzoneImages(admitImages, cfg, items) {
  if (typeof admitImages !== 'function') return []
  const picked = []
  for (const item of Array.isArray(items) ? items : []) {
    if (picked.length >= 4) break
    if (!item || !/^https?:/i.test(String(item.url || ''))) continue
    picked.push(item)
  }
  if (!picked.length) return []
  return admitImages(picked.map((item) => ({
    data: { url: item.url },
    cfg,
    name: item.name || 'qq-qzone.jpg',
    caption: item.caption || 'QQ 空间图片',
  })))
}

function qzonePostOf(x, max = 500) {
  const time = Number((x && x.time) || 0)
  return {
    tid: String((x && x.tid) || ''),
    content: clean((x && x.content) || plainText(x && x.html)).slice(0, max),
    time,
    t: fmtTime(time),
    comment_num: Number((x && (x.comment_num != null ? x.comment_num : x.comment_count)) || 0),
    is_private: !!(x && x.is_private),
    images: qzoneImagesOf(x && x.images),
  }
}

// 部分 SnowLuma 版本只会把 feed 的 HTML 透传回来，tid/content 仍是 null。
// 说说（appid=311）的 tid 在 HTML 的 tid="..." / data-tid="..." 里，
// 取出来就能继续用详情、点赞和评论；补不回来的 feed 保持只读。
function qzoneTidOf(x) {
  const direct = x && x.tid != null ? String(x.tid).trim() : ''
  if (direct) return direct
  if (Number(x && x.appid) !== 311) return ''
  const html = String((x && x.html) || '')
  const hit = html.match(/(?:data-)?tid[="'\s:]+([0-9a-fA-F]{16,64})/)
  return hit ? hit[1] : ''
}

export function makeListQzoneTool(admitImages) {
  return {
    name: 'qq_list_qzone',
    description:
      '看 QQ 空间说说。默认看自己的说说；传 target_uin 看别人的；feeds=true 看好友动态（可用 cursor 翻页）。' +
      '好友动态里只保留说说（appid=311）；如果 SnowLuma 没从 HTML 里解析出 tid，会尽量自己补回来，补不回来的只能看不能互动。' +
      '返回 tid、正文、时间、评论数和图片；tid 可以传给 qq_get_qzone_post / qq_manage_qzone。只读。',
    parameters: {
      type: 'object',
      properties: {
        feeds: { type: 'boolean', description: 'true = 看好友动态（get_qzone_feeds），默认 false' },
        target_uin: { type: 'number', description: '看谁的说说；不传就是自己（feeds 模式忽略）' },
        pos: { type: 'number', description: '从第几条开始，默认 0（feeds 模式忽略）' },
        count: { type: 'number', description: '本页数量，默认 10，最多 50' },
        cursor: { type: 'string', description: '好友动态翻页游标，传上一页返回的 next_cursor' },
        include_images: { type: 'boolean', description: '要不要把最近的图片也给你看（最多 4 张，默认 true）' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const count = Math.max(1, Math.min(Math.floor(Number(args && args.count) || 10), 50))
      const withImages = !(args && args.include_images === false)
      try {
        if (args && args.feeds === true) {
          const body = { count }
          const cursor = String((args && args.cursor) || '').trim()
          if (cursor) body.cursor = cursor
          const data = await onebot('get_qzone_feeds', body, cfg)
          const rawFeeds = Array.isArray(data && data.feeds) ? data.feeds : []
          const feeds = rawFeeds.map((x) => {
            const post = qzonePostOf(x)
            const tid = qzoneTidOf(x)
            return {
              ...post,
              tid,
              actionable: !!tid,
              appid: Number((x && x.appid) || 0),
              uin: String((x && x.uin) || ''),
              name: clean(x && x.nickname),
              like_count: Number((x && x.like_count) || 0),
              content_complete: !!(x && x.content_complete),
            }
          }).filter((x) => x.appid === 311 || x.tid)
          const imageItems = []
          for (const f of feeds) {
            for (const url of f.images) {
              imageItems.push({
                url,
                name: `qq-qzone-${f.tid}.jpg`,
                caption: `好友动态 ${f.tid} 的图片（${f.name || f.uin || '好友'}）`,
              })
            }
          }
          const images = withImages ? await admitQzoneImages(admitImages, cfg, imageItems) : []
          return {
            ok: true,
            mode: 'feeds',
            count: feeds.length,
            feeds,
            skipped: rawFeeds.length - feeds.length,
            has_more: !!(data && data.has_more),
            next_cursor: String((data && data.next_cursor) || ''),
            images,
          }
        }
        const targetUin = args && args.target_uin != null ? Number(args.target_uin) : 0
        if (args && args.target_uin != null && !Number.isFinite(targetUin)) {
          return { ok: false, error: 'target_uin 不是有效 QQ 号' }
        }
        if (targetUin && !allowedPrivate(targetUin, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
        const body = {
          pos: Math.max(0, Math.floor(Number(args && args.pos) || 0)),
          num: count,
        }
        if (targetUin) body.target_uin = targetUin
        const data = await onebot('get_qzone_msg_list', body, cfg)
        const raw = listOf(data, 'msglist')
        const posts = raw.map((x) => qzonePostOf(x)).filter((x) => x.tid)
        const imageItems = []
        for (const p of posts) {
          for (const url of p.images) {
            imageItems.push({
              url,
              name: `qq-qzone-${p.tid}.jpg`,
              caption: `说说 ${p.tid} 的图片${p.content ? '（' + p.content.slice(0, 30) + '）' : ''}`,
            })
          }
        }
        const images = withImages ? await admitQzoneImages(admitImages, cfg, imageItems) : []
        return {
          ok: true,
          mode: 'list',
          target_uin: targetUin || null,
          total: Number((data && data.total) || posts.length),
          count: posts.length,
          posts,
          images,
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看 QQ 空间失败：' + String((v && v.error) || '未知错误') }]
      const blocks = []
      if (v.mode === 'feeds') {
        if (!v.feeds.length) {
          return [{ type: 'text', text: '好友动态里现在没有能识别的说说。' + (v.skipped ? `（跳过 ${v.skipped} 条非说说动态）` : '') }]
        }
        const lines = [`好友动态（${v.feeds.length} 条${v.has_more ? '，还有更多' : ''}）：`]
        for (const f of v.feeds) {
          const tag = f.tid ? `[tid=${f.tid}]` : '[没有 tid，只能看]'
          lines.push(`- ${f.name || f.uin || '好友'}(${f.uin || '?'}) ${tag} ${f.t} 赞 ${f.like_count} 评论 ${f.comment_num}`)
          if (f.content) lines.push('  ' + f.content.split('\n').join('\n  '))
        }
        if (v.next_cursor) lines.push(`翻下一页：feeds=true，cursor=${v.next_cursor}`)
        if (v.skipped) lines.push(`另有 ${v.skipped} 条非说说动态（相册、广告等）没有列出。`)
        if (v.feeds.some((f) => !f.tid)) lines.push('没有 tid 的动态不能直接点赞/评论，可以配合 qq_get_qzone_post 或去 QQ 客户端看。')
        blocks.push({ type: 'text', text: lines.join('\n') })
      } else {
        if (!v.posts.length) return [{ type: 'text', text: '没有看到说说。' }]
        const where = v.target_uin ? `QQ ${v.target_uin} 的空间` : '你的空间'
        const lines = [`${where}（共 ${v.total} 条，本页 ${v.count} 条）：`]
        for (const p of v.posts) {
          lines.push(`- [tid=${p.tid}] ${p.t} 评论 ${p.comment_num}${p.is_private ? '（仅自己可见）' : ''}`)
          if (p.content) lines.push('  ' + p.content.split('\n').join('\n  '))
        }
        lines.push('看评论详情用 qq_get_qzone_post；发新说说用 qq_send_qzone_post。')
        blocks.push({ type: 'text', text: lines.join('\n') })
      }
      for (const img of Array.isArray(v.images) ? v.images : []) {
        if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
        if (img && img.block) blocks.push(img.block)
      }
      return blocks
    },
  }
}

export function makeGetQzonePostTool(admitImages) {
  return {
    name: 'qq_get_qzone_post',
    description:
      '看一条说说的详情和评论（SnowLuma get_qzone_msg_detail）。tid 从 qq_list_qzone 拿。' +
      '返回评论的 comment_id 和 uin；回复时传给 qq_manage_qzone：' +
      '回复一级评论传 comment_id + comment_uin，回复楼中楼再传 reply_uin + reply_name。只读。',
    parameters: {
      type: 'object',
      properties: {
        tid: { type: 'string', description: '说说 tid' },
        target_uin: { type: 'number', description: '说说所属 QQ 号，默认自己' },
        pos: { type: 'number', description: '从第几条评论开始，默认 0' },
        count: { type: 'number', description: '看多少条一级评论，默认 20，最多 50' },
        include_images: { type: 'boolean', description: '详情里带图片时要不要看图，默认 true' },
      },
      required: ['tid'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const tid = args && args.tid != null ? String(args.tid).trim() : ''
      if (!tid) return { ok: false, error: 'tid 不能为空' }
      const targetUin = args && args.target_uin != null ? Number(args.target_uin) : 0
      if (args && args.target_uin != null && !Number.isFinite(targetUin)) {
        return { ok: false, error: 'target_uin 不是有效 QQ 号' }
      }
      if (targetUin && !allowedPrivate(targetUin, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      const count = Math.max(1, Math.min(Math.floor(Number(args && args.count) || 20), 50))
      try {
        const body = { tid, pos: Math.max(0, Math.floor(Number(args && args.pos) || 0)), num: count }
        if (targetUin) body.target_uin = targetUin
        const data = await onebot('get_qzone_msg_detail', body, cfg)
        const comments = (Array.isArray(data && data.comments) ? data.comments : []).map((c) => ({
          uin: String((c && (c.uin || c.user_id)) || ''),
          name: clean(c && (c.name || c.nickname)),
          time: Number((c && c.time) || 0),
          t: fmtTime(c && c.time),
          content: cleanMultiline(c && c.content, 1000),
          comment_id: c && c.comment_id != null ? String(c.comment_id) : '',
          replies: (Array.isArray(c && c.replies) ? c.replies : []).map((r) => ({
            uin: String((r && (r.uin || r.user_id)) || ''),
            name: clean(r && (r.name || r.nickname)),
            time: Number((r && r.time) || 0),
            t: fmtTime(r && r.time),
            content: cleanMultiline(r && r.content, 1000),
            comment_id: r && r.comment_id != null ? String(r.comment_id) : '',
            parent_comment_id: r && r.parent_comment_id != null ? String(r.parent_comment_id) : '',
            parent_comment_uin: r && r.parent_comment_uin != null ? String(r.parent_comment_uin) : '',
          })),
        }))
        const post = {
          tid: String((data && data.tid) || tid),
          content: cleanMultiline(data && data.content, 4000),
          comment_num: Number((data && data.comment_num) || 0),
          comments,
          images: qzoneImagesOf(data && data.images),
        }
        let images = []
        if (!(args && args.include_images === false) && post.images.length) {
          images = await admitQzoneImages(admitImages, cfg, post.images.map((url) => ({
            url,
            name: `qq-qzone-${post.tid}.jpg`,
            caption: `说说 ${post.tid} 的图片`,
          })))
        }
        return { ok: true, post, images }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '看说说详情失败：' + String((v && v.error) || '未知错误') }]
      const p = v.post || {}
      const lines = [`说说 ${p.tid}：`, p.content || '（没有正文）']
      lines.push(`评论 ${p.comment_num || 0} 条：`)
      if (!p.comments.length) lines.push('（还没有评论）')
      for (const c of p.comments) {
        lines.push(`- ${c.name || c.uin}(${c.uin}) [comment_id=${c.comment_id}] ${c.t}：${c.content || '（空）'}`)
        for (const r of c.replies) {
          lines.push(`  ↳ ${r.name || r.uin}(${r.uin}) [comment_id=${r.comment_id} parent=${r.parent_comment_id}] ${r.t}：${r.content || '（空）'}`)
        }
      }
      if (p.comments.length) {
        lines.push('回复一级评论：qq_manage_qzone action=comment，传 comment_id + comment_uin=该评论 uin；' +
          '回复楼中楼再加 reply_uin + reply_name，comment_id 仍用一级评论的 id（不要用二级回复自己的 id）。')
      }
      const blocks = [{ type: 'text', text: lines.join('\n') }]
      for (const img of Array.isArray(v.images) ? v.images : []) {
        if (img && img.caption) blocks.push({ type: 'text', text: img.caption })
        if (img && img.block) blocks.push(img.block)
      }
      return blocks
    },
  }
}

export function makeSendQzonePostTool() {
  return {
    name: 'qq_send_qzone_post',
    description:
      '发一条 QQ 空间说说（SnowLuma send_qzone_msg）。content 是正文；' +
      'images 是图片（http(s)、base64://、本机路径，最多 9 张），也可以用 message_id 从消息里取图。' +
      'visibility：public=所有人，friends=好友，partial=指定好友可见，private=仅自己，exclude=指定好友不可见；' +
      'partial/exclude 要传 target_uins。发说说对外可见，只有用户明确要求时才用。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文，不要 Markdown' },
        images: { type: 'array', items: { type: 'string' }, description: '图片列表，最多 9 张' },
        message_id: { type: 'string', description: '从这条消息里取图片一起发' },
        image_indexes: { type: 'array', items: { type: 'number' }, description: 'message_id 里要哪几张图片（从 0 开始）；不传就全取' },
        visibility: { type: 'string', enum: ['public', 'friends', 'partial', 'private', 'exclude'], description: '可见范围，默认 public' },
        target_uins: { type: 'array', items: { type: 'number' }, description: 'partial/exclude 时的 QQ 号列表' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const content = cleanMultiline(args && args.content, 2000)
      if (!content) return { ok: false, error: '说说正文是空的' }
      const visibilityKey = String((args && args.visibility) || 'public')
      const ugcRight = qzoneRightOf(visibilityKey)
      if (!ugcRight) return { ok: false, error: 'visibility 只能是 public/friends/partial/private/exclude' }
      const targetUins = (Array.isArray(args && args.target_uins) ? args.target_uins : [])
        .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
      if ((ugcRight === 16 || ugcRight === 128) && !targetUins.length) {
        return { ok: false, error: 'partial/exclude 需要 target_uins 指定名单' }
      }
      try {
        const images = (Array.isArray(args && args.images) ? args.images : [])
          .map(imageSourceOf).filter(Boolean)
        const messageId = args && args.message_id
        if (messageId != null && messageId !== '') {
          if (images.length >= 9) return { ok: false, error: '最多 9 张图片' }
          const got = await imageSourcesFromMessage(messageId, args.image_indexes, cfg, 9 - images.length)
          if (!got.sources.length) {
            return {
              ok: false,
              error: got.total
                ? `选中的图片序号没有匹配到（这条消息共 ${got.total} 张）`
                : '这条消息里没有图片',
            }
          }
          images.push(...got.sources)
        }
        if (images.length > 9) return { ok: false, error: '最多 9 张图片' }
        const body = { content, ugc_right: ugcRight }
        if (images.length) body.images = images
        if (ugcRight === 16 || ugcRight === 128) body.target_uins = targetUins
        const data = await onebot('send_qzone_msg', body, cfg)
        return {
          ok: true,
          tid: String((data && data.tid) || ''),
          time: Number((data && data.time) || 0),
          visibility: QZONE_VISIBILITY_NAMES[ugcRight],
          image_count: images.length,
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '发说说失败：' + String((v && v.error) || '未知错误') }]
      const extra = v.image_count ? `，${v.image_count} 张图` : ''
      return [{ type: 'text', text: `说说已发布（tid ${v.tid || '?'}${extra}，${v.visibility || '所有人可见'}）。` }]
    },
  }
}

export function makeManageQzoneTool() {
  return {
    name: 'qq_manage_qzone',
    description:
      '管理 QQ 空间说说。action：\n' +
      '- like / unlike：点赞或取消赞，需要 tid（abstime 传列表里的 time 更可靠）\n' +
      '- comment：评论或回复，需要 tid + content；回复一级评论再传 comment_id + comment_uin，' +
      '回复楼中楼再传 reply_uin + reply_name；只有普通评论能带图\n' +
      '- delete：删除自己空间的一条说说，需要 tid + confirm=true，不可撤销\n' +
      '- set_right：改自己空间一条说说的可见范围，需要 tid + visibility（partial/exclude 再传 target_uins）\n' +
      '- ban / unban：拉黑或解除拉黑某人的空间访问，需要 user_id',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['like', 'unlike', 'comment', 'delete', 'set_right', 'ban', 'unban'],
          description: '要做什么',
        },
        tid: { type: 'string', description: '说说 tid；like/unlike/comment/delete/set_right 需要' },
        target_uin: { type: 'number', description: '说说所属 QQ 号，默认自己' },
        abstime: { type: 'number', description: '说说发表时间（unix 秒），点赞时传更可靠' },
        content: { type: 'string', description: '评论内容（action=comment）' },
        images: { type: 'array', items: { type: 'string' }, description: '评论图片（普通评论可选，最多 9 张）' },
        comment_id: { type: 'string', description: '要回复的一级评论 ID（评论详情里的 comment_id）' },
        comment_uin: { type: 'number', description: '一级评论作者 QQ 号' },
        reply_uin: { type: 'number', description: '楼中楼里要回复的用户 QQ 号' },
        reply_name: { type: 'string', description: '楼中楼里要回复的用户昵称' },
        visibility: { type: 'string', enum: ['public', 'friends', 'partial', 'private', 'exclude'], description: 'set_right 的新可见范围' },
        target_uins: { type: 'array', items: { type: 'number' }, description: 'set_right 时 partial/exclude 的 QQ 号列表' },
        user_id: { type: 'number', description: 'ban/unban 的目标 QQ 号' },
        confirm: { type: 'boolean', description: 'delete 时必须显式传 true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: renderTool },
    async execute(args) {
      const cfg = loadCfg()
      const action = String((args && args.action) || '')
      const tid = args && args.tid != null ? String(args.tid).trim() : ''
      const targetUin = args && args.target_uin != null ? Number(args.target_uin) : 0
      if (args && args.target_uin != null && !Number.isFinite(targetUin)) {
        return { ok: false, error: 'target_uin 不是有效 QQ 号' }
      }
      if (targetUin && !allowedPrivate(targetUin, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
      const needTid = ['like', 'unlike', 'comment', 'delete', 'set_right']
      if (needTid.includes(action) && !tid) return { ok: false, error: action + ' 需要 tid' }
      try {
        if (action === 'like' || action === 'unlike') {
          const body = { tid }
          if (targetUin) body.target_uin = targetUin
          const abstime = Number(args && args.abstime)
          if (Number.isFinite(abstime) && abstime > 0) body.abstime = Math.floor(abstime)
          await onebot(action === 'like' ? 'like_qzone' : 'unlike_qzone', body, cfg)
          return { ok: true, action, tid, liked: action === 'like' }
        }
        if (action === 'comment') {
          const content = cleanMultiline(args && args.content, 1000)
          if (!content) return { ok: false, error: '评论内容是空的' }
          const images = (Array.isArray(args && args.images) ? args.images : [])
            .map(imageSourceOf).filter(Boolean)
          if (images.length > 9) return { ok: false, error: '评论最多 9 张图片' }
          const parentId = args && args.comment_id != null ? String(args.comment_id).trim() : ''
          const hasParentUin = args && args.comment_uin != null
          const parentUin = hasParentUin ? Number(args.comment_uin) : 0
          const hasReplyUin = args && args.reply_uin != null
          const replyUin = hasReplyUin ? Number(args.reply_uin) : 0
          const replyName = clean(args && args.reply_name)
          if (parentId && (!hasParentUin || !Number.isInteger(parentUin) || parentUin <= 0)) {
            return { ok: false, error: 'comment_id 和 comment_uin 要一起传，comment_uin 是正整数 QQ 号' }
          }
          if (hasParentUin && !parentId) {
            return { ok: false, error: 'comment_uin 要配合 comment_id 一起传' }
          }
          if (hasReplyUin && (!Number.isInteger(replyUin) || replyUin <= 0)) {
            return { ok: false, error: 'reply_uin 不是有效 QQ 号' }
          }
          if (hasReplyUin && (!parentId || !replyName)) {
            return { ok: false, error: '回复楼中楼需要 comment_id + comment_uin + reply_uin + reply_name' }
          }
          if (parentId && images.length) return { ok: false, error: '回复评论只能发文字，不能带图' }
          const body = { tid, content }
          if (targetUin) body.target_uin = targetUin
          if (images.length) body.images = images
          if (parentId) {
            body.comment_id = parentId
            body.comment_uin = parentUin
          }
          if (replyUin) {
            body.reply_uin = replyUin
            body.reply_name = replyName
          }
          const data = await onebot('comment_qzone', body, cfg)
          return {
            ok: true,
            action,
            tid,
            comment_id: data && data.comment_id != null ? String(data.comment_id) : '',
            parent_comment_id: data && data.parent_comment_id != null ? String(data.parent_comment_id) : '',
            parent_comment_uin: Number((data && data.parent_comment_uin) || 0),
          }
        }
        if (action === 'delete') {
          if (!args || args.confirm !== true) {
            return { ok: false, error: '删说说不可撤销，需要 confirm=true 才会执行' }
          }
          await onebot('delete_qzone_msg', { tid }, cfg)
          return { ok: true, action, tid, deleted: true }
        }
        if (action === 'set_right') {
          const ugcRight = qzoneRightOf(args && args.visibility)
          if (!ugcRight) return { ok: false, error: 'set_right 需要 visibility（public/friends/partial/private/exclude）' }
          const targetUins = (Array.isArray(args && args.target_uins) ? args.target_uins : [])
            .map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
          if ((ugcRight === 16 || ugcRight === 128) && !targetUins.length) {
            return { ok: false, error: 'partial/exclude 需要 target_uins 指定名单' }
          }
          const body = { tid, ugc_right: ugcRight }
          if (ugcRight === 16 || ugcRight === 128) body.target_uins = targetUins
          const data = await onebot('set_qzone_msg_right', body, cfg)
          return {
            ok: true,
            action,
            tid,
            ugc_right: Number((data && data.ugc_right) || ugcRight),
            visibility: QZONE_VISIBILITY_NAMES[Number((data && data.ugc_right) || ugcRight)],
          }
        }
        if (action === 'ban' || action === 'unban') {
          const userId = Number(args && args.user_id)
          if (!Number.isFinite(userId) || !userId) return { ok: false, error: 'ban/unban 需要 user_id' }
          if (!allowedPrivate(userId, cfg)) return { ok: false, error: '这个 QQ 不在允许列表里' }
          await onebot('set_qzone_ban', { user_id: userId, enable: action === 'ban' }, cfg)
          return { ok: true, action, user_id: userId, banned: action === 'ban' }
        }
        return { ok: false, error: '不认识的 action：' + action }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    render(_args, v) {
      if (!v || !v.ok) return [{ type: 'text', text: '操作 QQ 空间失败：' + String((v && v.error) || '未知错误') }]
      if (v.action === 'like' || v.action === 'unlike') {
        return [{ type: 'text', text: `${v.liked ? '已点赞' : '已取消赞'}（tid ${v.tid}）。` }]
      }
      if (v.action === 'comment') {
        return [{ type: 'text', text: `评论已发（tid ${v.tid}，comment_id ${v.comment_id || '?'}）。` }]
      }
      if (v.action === 'delete') {
        return [{ type: 'text', text: `已删除说说 ${v.tid}。` }]
      }
      if (v.action === 'set_right') {
        return [{ type: 'text', text: `说说 ${v.tid} 的可见范围已改为「${v.visibility || v.ugc_right}」。` }]
      }
      if (v.action === 'ban' || v.action === 'unban') {
        return [{ type: 'text', text: `已${v.banned ? '拉黑' : '解除拉黑'} QQ ${v.user_id} 的空间访问。` }]
      }
      return [{ type: 'text', text: 'QQ 空间操作完成。' }]
    },
  }
}
