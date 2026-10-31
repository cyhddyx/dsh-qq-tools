// 离线冒烟测试：假 OneBot HTTP 服务 + 临时 DSH_HOME，不碰真实配置和 QQ。
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const root = mkdtempSync(join(tmpdir(), 'dsh-qq-smoke-'))
process.env.DSH_HOME = root
mkdirSync(root, { recursive: true })

const calls = []
const failures = new Set()
const replies = {
  set_qq_avatar: null,
  send_group_msg: { message_id: 'gm-1' },
  send_private_msg: { message_id: 'pm-1' },
  get_stranger_info: {
    user_id: 10001, nickname: '张三', remark: '', sex: 'male', age: 20,
    qid: 'zhangsan', qq_level: 45, is_vip: true, vip_level: 7,
  },
  get_friends_with_category: [
    {
      categoryId: 2, categoryName: '同学', categoryMbCount: 1,
      buddyList: [{ user_id: 10001, nickname: '张三', remark: '小张' }],
    },
    { categoryId: 3, categoryName: '同事', categoryMbCount: 0, buddyList: [] },
  ],
  get_friend_list: [
    { user_id: 10001, nickname: '张三', remark: '小张' },
    { user_id: 10002, nickname: '李四', remark: '' },
  ],
  get_unidirectional_friend_list: [],
  set_friend_remark: null,
  set_friends_category: null,
  delete_friend: null,
  send_like: null,
  get_doubt_friends_add_request: [
    {
      uid: 'doubt-flag-1', user_id: 10002, nick: '李四', source: '群聊',
      reason: '来源异常', msg: '你好', group_code: '123', reqTime: 1700000000,
    },
  ],
  set_friend_add_request: null,
  set_doubt_friends_add_request: null,
  get_msg: {
    message: [
      { type: 'text', data: { text: 'hi' } },
      { type: 'image', data: { url: 'https://example.com/a.jpg', file: 'a.jpg' } },
      { type: 'mface', data: { url: 'https://example.com/b.gif', file: 'b.gif' } },
    ],
  },
  add_custom_face: { emoji_id: 'emoji-new' },
  modify_custom_face: null,
  get_qzone_msg_list: {
    total: 2,
    msglist: [
      {
        tid: 't1', content: '第一条说说', time: 1700000000, comment_num: 2,
        is_private: false, images: ['https://example.com/p1.jpg'],
      },
      { tid: 't2', content: '第二条\n换行', time: 1699990000, comment_num: 0, is_private: true, images: [] },
    ],
  },
  get_qzone_feeds: {
    feeds: [
      {
        uin: 10001, nickname: '张三', time: 1700000001, tid: 'f1', appid: 311,
        content: '好友动态', images: [], like_count: 5, comment_count: 1,
      },
      {
        uin: 10002, nickname: '李四', time: 1700000000, tid: null, appid: 311,
        html: '<div>HTML 说说 tid="abcdef0123456789"</div>', images: null,
        like_count: null, comment_count: null,
      },
      { uin: 999, nickname: '广告', time: 1699999999, appid: 6600, html: '<div>广告</div>' },
    ],
    has_more: true,
    next_cursor: 'cursor-2',
  },
  get_qzone_msg_detail: {
    tid: 't1', content: '第一条说说', comment_num: 2,
    comments: [
      {
        uin: 10001, name: '张三', time: 1700000002, content: '一级评论', comment_id: 'c1',
        replies: [
          {
            uin: 10002, name: '李四', time: 1700000003, content: '楼中楼',
            comment_id: 'c2', parent_comment_id: 'c1', parent_comment_uin: 10001,
          },
        ],
      },
    ],
  },
  send_qzone_msg: { tid: 't9', time: 1700000009 },
  like_qzone: null,
  unlike_qzone: null,
  comment_qzone: { comment_id: 'c9', parent_comment_id: '', parent_comment_uin: 0 },
  delete_qzone_msg: null,
  set_qzone_msg_right: { ugc_right: 64 },
  set_qzone_ban: null,
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  const action = decodeURIComponent(String(req.url || '').replace(/^\//, ''))
  calls.push({ action, body })
  if (failures.has(action)) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'failed', retcode: 100, message: 'mock failure' }))
    return
  }
  const data = Object.prototype.hasOwnProperty.call(replies, action) ? replies[action] : null
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
writeFileSync(join(root, 'qq-tools-config.json'), JSON.stringify({
  napCat: 'http://127.0.0.1:' + port,
  accessToken: '',
  targetSession: '',
  groups: [],
  privateUsers: [],
  wsUrl: 'ws://127.0.0.1:1',
  timeoutMs: 3000,
}), 'utf8')

const mod = await import(new URL('../lib/shared.js', import.meta.url).href)

// 0. 唤醒提示的消息格式：昵称(QQ号)：内容
assert.equal(
  mod.formatIncomingLine('张三', 10001, '你好', 456),
  '张三(10001)：你好（消息 #456）',
)
assert.equal(mod.formatIncomingLine('', 10001, '', null), 'QQ(10001)：（空）')

function last(action) {
  const hit = [...calls].reverse().find((c) => c.action === action)
  assert.ok(hit, '没有调用 ' + action)
  return hit.body
}

function render(tool, args, value) {
  const blocks = tool.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length, tool.name + ' render 返回空')
  for (const b of blocks) assert.equal(b.type, 'text', tool.name + ' render 只应有文本')
}

// 1. 头像：data URL → base64://
const avatar = mod.makeSetAvatarTool()
{
  const v = await avatar.execute({ file: 'data:image/png;base64,iVBORw0KGgo=' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.match(last('set_qq_avatar').file, /^base64:\/\//)
  render(avatar, {}, v)
}
// 2. 头像：从消息取第 1 张图
{
  const v = await avatar.execute({ message_id: 'm1', index: 1 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(last('set_qq_avatar').file, 'https://example.com/b.gif')
  render(avatar, {}, v)
}
// 2.5 收藏表情：从消息取图（复用同一个取图 helper）
{
  const fav = mod.makeFavoriteFaceTool()
  const v = await fav.execute({ message_id: 'm1', index: 0, desc: '新表情' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(last('add_custom_face').file, 'https://example.com/a.jpg')
  assert.deepEqual(last('modify_custom_face'), { emoji_id: 'emoji-new', desc: '新表情' })
  render(fav, {}, v)
}
// 3. 好友资料
const friendInfo = mod.makeGetFriendInfoTool()
{
  const v = await friendInfo.execute({ user_id: 10001 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.friend.remark, '小张')
  assert.equal(v.friend.category.name, '同学')
  assert.equal(v.friend.one_way, false)
  render(friendInfo, {}, v)
}
// 4. 好友分组
const categories = mod.makeListFriendCategoriesTool()
{
  const v = await categories.execute({})
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.total, 2)
  assert.equal(v.categories.length, 3)
  assert.equal(v.categories[0].id, 2)
  assert.equal(v.categories[1].id, 3)
  assert.equal(v.categories[2].id, -1)
  assert.equal(v.categories[2].name, '未分组（接口未返回）')
  render(categories, {}, v)
}
// 4.5 分组接口不可用时：分组退回好友列表，资料仍能判断是不是好友
{
  failures.add('get_friends_with_category')
  try {
    const v = await categories.execute({})
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.equal(v.categories[0].name, '我的好友')
    assert.equal(v.total, 2)
    render(categories, {}, v)
    const info = await friendInfo.execute({ user_id: 10001 })
    assert.equal(info.ok, true, JSON.stringify(info))
    assert.equal(info.friend.is_friend, true)
    assert.equal(info.friend.category, null)
    render(friendInfo, {}, info)
  } finally {
    failures.delete('get_friends_with_category')
  }
}
// 5. 备注 + 按名称移动分组
const updateFriend = mod.makeUpdateFriendTool()
{
  const v = await updateFriend.execute({ user_id: 10001, remark: '老张', category_name: '同事' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('set_friend_remark'), { user_id: 10001, remark: '老张' })
  assert.deepEqual(last('set_friends_category'), { uin: 10001, categoryId: 3 })
  render(updateFriend, {}, v)
}
// 5.5 分组接口不可用时，category_name 直接交给 SnowLuma
{
  failures.add('get_friends_with_category')
  try {
    const v = await updateFriend.execute({ user_id: 10001, category_name: '同事' })
    assert.equal(v.ok, true, JSON.stringify(v))
    assert.deepEqual(last('set_friends_category'), { uin: 10001, categoryName: '同事' })
    render(updateFriend, {}, v)
  } finally {
    failures.delete('get_friends_with_category')
  }
}
// 6. 删好友必须 confirm
const deleteFriend = mod.makeDeleteFriendTool()
{
  const bad = await deleteFriend.execute({ user_id: 10001 })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /confirm=true/)
  const v = await deleteFriend.execute({ user_id: 10001, confirm: true, block: true })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('delete_friend'), { user_id: 10001, block: true })
  render(deleteFriend, {}, v)
}
// 7. 名片赞次数封顶 20
const like = mod.makeSendLikeTool()
{
  const v = await like.execute({ user_id: 10001, times: 100 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(last('send_like').times, 20)
  render(like, {}, v)
}
// 8. 好友申请列表（普通收件箱为空 + 可疑申请）
const requests = mod.makeListFriendRequestsTool()
{
  const v = await requests.execute({})
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.doubt.length, 1)
  assert.equal(v.doubt[0].flag, 'doubt-flag-1')
  render(requests, {}, v)
}
// 9. 处理可疑申请（按 user_id 查 flag）
const handle = mod.makeHandleFriendRequestTool()
{
  const v = await handle.execute({ user_id: 10002, kind: 'doubt', approve: false })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('set_doubt_friends_add_request'), { flag: 'doubt-flag-1', approve: false })
  render(handle, {}, v)
}
// 9.5 普通好友申请：假 WebSocket 推一个 request 事件进收件箱，再按 flag 同意
{
  globalThis.WebSocket = class {
    constructor() {
      setTimeout(() => {
        if (this.onopen) this.onopen()
        if (this.onmessage) {
          this.onmessage({
            data: JSON.stringify({
              post_type: 'request', request_type: 'friend',
              user_id: 10003, comment: '我是王五', flag: 'friend-flag-1', time: 1700000010,
            }),
          })
        }
      }, 0)
    }
    close() {}
  }
  mod.startFriendRequestWatcher({ effect: (fn) => { fn() } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const list = await requests.execute({ include_doubt: false })
  assert.equal(list.ok, true, JSON.stringify(list))
  assert.equal(list.requests.length, 1, JSON.stringify(list))
  assert.equal(list.requests[0].flag, 'friend-flag-1')
  render(requests, {}, list)
  const v = await handle.execute({ flag: 'friend-flag-1', approve: true })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('set_friend_add_request'), { flag: 'friend-flag-1', approve: true })
  render(handle, {}, v)
  const after = await requests.execute({ include_doubt: false })
  assert.equal(after.requests.length, 0)
}
// 9.6 群消息：引用 + @ 多个（去重）
const groupSend = mod.makeSendTool()
{
  const v = await groupSend.execute({
    group_id: 123456, message: '收到', reply_to: '99', at_user_ids: [10001, 10002, 10001],
  })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('send_group_msg'), {
    group_id: 123456,
    message: [
      { type: 'reply', data: { id: '99' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'at', data: { qq: '10002' } },
      { type: 'text', data: { text: '收到' } },
    ],
  })
  assert.deepEqual(v.at_user_ids, [10001, 10002])
  render(groupSend, {}, v)
}
// 9.7 @全体，且只 @ 不说话
{
  const v = await groupSend.execute({ group_id: 123456, message: '', at_all: true })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('send_group_msg').message, [{ type: 'at', data: { qq: 'all' } }])
  render(groupSend, {}, v)
  const bad = await groupSend.execute({ group_id: 123456, message: '' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /消息是空的/)
}
// 9.8 私聊引用
const privateSend = mod.makeSendPrivateTool()
{
  const v = await privateSend.execute({ user_id: 10001, message: '收到', reply_to: '88' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('send_private_msg'), {
    user_id: 10001,
    message: [
      { type: 'reply', data: { id: '88' } },
      { type: 'text', data: { text: '收到' } },
    ],
  })
  assert.equal(v.reply_to, '88')
  render(privateSend, {}, v)
}
// 10. 说说列表
const listQzone = mod.makeListQzoneTool(undefined)
{
  const v = await listQzone.execute({ count: 5 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.posts.length, 2)
  assert.equal(v.posts[0].content, '第一条说说')
  assert.match(v.posts[1].content, /^第二条/)
  assert.equal(v.posts[1].is_private, true)
  render(listQzone, {}, v)
}
// 11. 好友动态 + cursor：HTML-only 的说说补 tid，广告跳过
{
  const v = await listQzone.execute({ feeds: true, cursor: 'cursor-1', count: 5 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(last('get_qzone_feeds').cursor, 'cursor-1')
  assert.equal(v.next_cursor, 'cursor-2')
  assert.equal(v.count, 2)
  assert.equal(v.skipped, 1)
  assert.equal(v.feeds[0].tid, 'f1')
  assert.equal(v.feeds[1].tid, 'abcdef0123456789')
  assert.equal(v.feeds[1].actionable, true)
  render(listQzone, {}, v)
}
// 12. 说说详情
const qzoneDetail = mod.makeGetQzonePostTool(undefined)
{
  const v = await qzoneDetail.execute({ tid: 't1' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.equal(v.post.comments[0].comment_id, 'c1')
  assert.equal(v.post.comments[0].replies[0].parent_comment_id, 'c1')
  render(qzoneDetail, {}, v)
}
// 13. 发说说：正文 + 消息图片 + 仅自己可见
const sendQzone = mod.makeSendQzonePostTool()
{
  const v = await sendQzone.execute({
    content: '今天天气不错',
    message_id: 'm1',
    image_indexes: [1],
    visibility: 'private',
  })
  assert.equal(v.ok, true, JSON.stringify(v))
  const body = last('send_qzone_msg')
  assert.equal(body.ugc_right, 64)
  assert.deepEqual(body.images, ['https://example.com/b.gif'])
  render(sendQzone, {}, v)
}
// 14. partial 必须有名单
{
  const v = await sendQzone.execute({ content: 'x', visibility: 'partial' })
  assert.equal(v.ok, false)
  assert.match(v.error, /target_uins/)
}
// 15. 管理：点赞
const manage = mod.makeManageQzoneTool()
{
  const v = await manage.execute({ action: 'like', tid: 't1', abstime: 1700000000 })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('like_qzone'), { tid: 't1', abstime: 1700000000 })
  render(manage, {}, v)
}
// 16. 评论回复楼中楼
{
  const v = await manage.execute({
    action: 'comment', tid: 't1', content: '回复你',
    comment_id: 'c1', comment_uin: 10001, reply_uin: 10002, reply_name: '李四',
  })
  assert.equal(v.ok, true, JSON.stringify(v))
  const body = last('comment_qzone')
  assert.equal(body.comment_id, 'c1')
  assert.equal(body.comment_uin, 10001)
  assert.equal(body.reply_uin, 10002)
  assert.equal(body.reply_name, '李四')
  render(manage, {}, v)
}
// 16.5 comment_id 为 0 也有效（模型可能传 number）
{
  const v = await manage.execute({
    action: 'comment', tid: 't1', content: '回复零号评论',
    comment_id: 0, comment_uin: 10001,
  })
  assert.equal(v.ok, true, JSON.stringify(v))
  const body = last('comment_qzone')
  assert.equal(body.comment_id, '0')
  assert.equal(body.comment_uin, 10001)
  render(manage, {}, v)
}
// 17. 楼中楼不能带图
{
  const v = await manage.execute({
    action: 'comment', tid: 't1', content: 'x', comment_id: 'c1', comment_uin: 10001,
    reply_uin: 10002, reply_name: '李四', images: ['https://example.com/x.jpg'],
  })
  assert.equal(v.ok, false)
  assert.match(v.error, /不能带图/)
}
// 18. 删除说说必须 confirm
{
  const bad = await manage.execute({ action: 'delete', tid: 't1' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /confirm=true/)
  const v = await manage.execute({ action: 'delete', tid: 't1', confirm: true })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('delete_qzone_msg'), { tid: 't1' })
  render(manage, {}, v)
}
// 19. 改权限 + 拉黑
{
  const v = await manage.execute({ action: 'set_right', tid: 't1', visibility: 'private' })
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.deepEqual(last('set_qzone_msg_right'), { tid: 't1', ugc_right: 64 })
  render(manage, {}, v)
  const b = await manage.execute({ action: 'ban', user_id: 10002 })
  assert.equal(b.ok, true, JSON.stringify(b))
  assert.deepEqual(last('set_qzone_ban'), { user_id: 10002, enable: true })
  render(manage, {}, b)
}

server.close()
console.log('ALL SMOKE TESTS PASSED (' + calls.length + ' OneBot calls)')
