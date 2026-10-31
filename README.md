# dsh-qq-tools

给 DSH（DeepSeek Harness）里的大肥鱼会话用的 QQ 群/私聊工具，走 OneBot 11 HTTP + WebSocket。系统表情在 SnowLuma / NapCat 上都能发；收藏表情、更改头像、好友管理和 QQ 空间走 SnowLuma 的扩展接口，和 QQ 客户端里的数据是同一份。

11 个工具组各自是一个独立的 cordis 组件，外加一个负责选择挂载会话的设置组件，在 DSH 插件页的「包含的组件」里可以逐个开关：

| 组件 | 工具 | 说明 |
| --- | --- | --- |
| 列出 QQ 群 | `qq_list_groups` | 群号、群名、人数 |
| 看群聊天记录 | `qq_get_group_history` | 最近消息 + 图片，只读；消息带 `#message_id` |
| 看群成员 | `qq_get_group_members` | 昵称、群名片、QQ 号、身份 |
| 发群消息 | `qq_send_group_message` | 发群消息，可引用消息、@人、@全体；同时负责 @ 提醒和群后续轮询 |
| 发表情 | `qq_send_face` | 在群里或私聊里发系统表情或 QQ 收藏夹里的自定义表情，可带一句话 |
| 收藏表情 | `qq_list_faces` / `qq_favorite_face` | 看/管理 QQ 账号收藏夹（SnowLuma）：收藏图片、取消收藏、改备注、移到最前 |
| 私聊 | `qq_list_friends` / `qq_get_private_history` / `qq_send_private_message` | 好友列表、私聊记录、发私聊消息；同时负责私聊消息唤醒 |
| 戳一戳 | `qq_send_poke` | 戳人；同时负责接收戳一戳事件 |
| 更改头像 | `qq_set_avatar` | 换自己的 QQ 头像：链接、本机文件，或从聊天记录里取图 |
| 好友管理 | `qq_get_friend_info` / `qq_list_friend_categories` / `qq_update_friend` / `qq_delete_friend` / `qq_send_like` / `qq_list_friend_requests` / `qq_handle_friend_request` | 好友资料、备注、分组、删好友、名片赞，以及好友申请的查看和处理 |
| QQ空间 | `qq_list_qzone` / `qq_get_qzone_post` / `qq_send_qzone_post` / `qq_manage_qzone` | 说说和好友动态、详情评论、发说说、点赞/评论/删除/改权限/拉黑 |
| 挂载会话 | — | 插件页里的「配置」页面：下拉选择 QQ 消息唤醒哪个 DSH 会话 |

关掉「发群消息」会同时停掉 @ 提醒轮询，关掉「私聊」会同时停掉私聊消息唤醒，关掉「戳一戳」会同时停掉戳一戳通知，关掉「好友管理」会同时停掉好友申请收件箱（已经收到的不受影响，但插件重启后普通申请会丢）；其他只读工具互不影响。关掉「挂载会话」只会让配置页面不可用，已经写进配置的 `targetSession` 仍然生效。

## 目录结构

```
cordis.patch.yml                 12 个组件行
lib/shared.js                    共享核心：配置、OneBot、挂载、@ 轮询、私聊唤醒、戳一戳、表情、头像、好友管理、QQ 空间、观察窗
lib/client.js                    浏览器半侧：插件页里的挂载会话下拉框
lib/index.js                     包根 carrier（承载浏览器半侧和挂载会话接口），也是旧的全量入口
locale/                          包根行在插件页显示的标题和说明
tools/qq-list-groups/            组件入口 + locale
tools/qq-get-group-history/
tools/qq-get-group-members/
tools/qq-send-group-message/
tools/qq-send-face/
tools/qq-favorite-faces/
tools/qq-private-chat/
tools/qq-send-poke/
tools/qq-set-avatar/
tools/qq-friend-management/
tools/qq-qzone/
test/smoke.mjs                   离线冒烟测试：假 OneBot HTTP 服务 + 临时 DSH_HOME
```

「挂载会话」用的是包根行（模块名 `dsh-qq-tools`，所以插件卡片名仍是 `dsh-qq-tools`）：DSH 只从包根发现 `dsh.client`，子路径行不会扫描；`config.carrier: true` 让它只承载设置接口，不会重复挂一遍工具。

每个 `tools/<组件>/index.js` 只做一件事：把自己的工具挂到目标会话。`locale/{en,zh}.json` 提供插件页显示的标题和说明；左侧栏入口和插件行配置页在 `lib/client.js` 里注册。

## 选择挂载会话

左侧栏的「挂载会话」入口（也可以在「插件 → dsh-qq-tools → 挂载会话 → 配置」里打开）会列出当前 DSH 里的会话（标题 + 短 ID + 运行状态）。选中后保存，配置写回 `~/.dsh/qq-tools-config.json` 的 `targetSession`，各组件在 3 秒内重新挂到这个会话。

- 归档会话和子会话不会出现在列表里；如果当前目标后来被归档，列表会把它标成「当前目标（已归档）」。
- 工具只注册在选中的会话上，其他会话看不到 QQ 工具，也不会被 QQ 消息唤醒。
- 选「不挂载」或留空会卸下所有工具并停止唤醒。
- 保存时不校验会话是否存活：会话暂时关掉不会把配置清掉，等它重新打开后会自动挂上。
- 这个页面依赖「挂载会话」组件；关掉该组件后接口不可用，但已保存的 `targetSession` 仍然生效，也可以直接改配置文件。

## 配置

首次启动会自动创建 `~/.dsh/qq-tools-config.json`：

```json
{
  "napCat": "http://127.0.0.1:3000",
  "accessToken": "",
  "targetSession": "",
  "groups": [],
  "historyCount": 30,
  "maxHistoryCount": 50,
  "pollMs": 5000,
  "mentionEnabled": true,
  "wsUrl": "ws://127.0.0.1:3001",
  "pokeEnabled": true,
  "privateEnabled": true,
  "privateUsers": [],
  "observationMs": 60000,
  "timeoutMs": 6000
}
```

- `napCat` 是 OneBot 11 HTTP 地址（SnowLuma 默认 `http://127.0.0.1:3000`，NapCat 也一样）；`wsUrl` 是 WebSocket 事件地址（默认 `ws://127.0.0.1:3001`）。
- `targetSession` 是目标会话 ID；可以在插件页「挂载会话 → 配置」里下拉选择，也可以直接改这个文件；留空时工具不会挂到任何会话。
- `groups` 是允许看/发的群；空数组表示不限制。
- `mentionEnabled` / `pokeEnabled` / `privateEnabled` 分别是 @ 轮询、戳一戳事件、私聊唤醒的总闸，对应组件关掉时它们也不会运行。
- `privateUsers` 是允许唤醒和私聊工具的 QQ 白名单；空数组表示不限制。非空时，不在列表里的私聊消息不会唤醒，`qq_list_friends` 也不会列出他们；好友资料/备注/分组/删好友/名片赞和查看别人的 QQ 空间也只对名单里的 QQ 生效。好友申请的处理不受这条限制，否则新申请人永远进不来。

## 表情

发表情和收藏表情都走 SnowLuma 的扩展接口，收藏夹和 QQ 客户端里的是同一份数据。

- `qq_list_faces`：列 QQ 收藏夹（`emoji_id` + 备注），默认给 3 张不同位置的预览图；想看指定表情就传 `preview`（列表序号或 `emoji_id`，最多 6 张）。传 `query` 时用 SnowLuma 的 `search_sys_faces` 按名字/别名/编号搜系统表情，搜不到再退回内置的常用表情表。
- `qq_send_face`：`face_id` 发系统表情（OneBot 11 的 `face` 段，SnowLuma 会自动选 classic / small / super 编码）；`emoji_id` 发收藏表情（`send_custom_face`）。两者二选一；带 `text` 时系统表情和文字同一条发出，收藏表情则先发文字再发图。群聊传 `group_id`，私聊传 `user_id`（可选 `group_id` 表示临时会话来源群）。
- `qq_favorite_face`：
  - `file` 传 `http(s)` 链接、`base64://`、本机路径或 `data:image/...`，收藏一张新表情；
  - `message_id` + `index` 直接从聊天消息里的图片收藏（群记录里的 `[图片#0]` / `[表情包#0]` 就是索引）；
  - `emoji_id` + `remove` 取消收藏；
  - `emoji_id` + `desc` 改备注；
  - `emoji_id` + `move_to_front` 移到收藏夹最前。
- 聊天记录里的 `#编号` 是 `message_id`，可以用 `qq_send_face` 的 `reply_to` 回复，也可以配合 `qq_favorite_face` 收藏消息里的图片。

这些自定义表情接口是 SnowLuma 扩展，NapCat 没有。用 NapCat 时系统表情照常能发，收藏表情工具会提示接口不可用。

## 群消息：引用和 @

`qq_send_group_message` 除了 `group_id` 和 `message`，还支持：

- `reply_to`：消息前面的 `#编号`，引用那条消息；
- `at_user_ids`：QQ 号数组，@ 这些人；
- `at_all`：`true` 表示 @全体成员（这时 `at_user_ids` 会被忽略）。

`message` 可以只写文字，也可以留空只发 @；引用和 @ 可以同时用。群 @ 提醒和群后续里的每条消息是 `昵称(QQ号)：内容（消息 #编号）`，可以直接把 `#编号` 传给 `reply_to`，把里面括号中的 QQ 号传给 `at_user_ids`。戳一戳和私聊唤醒也是 `昵称(QQ号)` 的形式。

## 私聊

私聊和群聊在程序里是分开的两条路径：群聊靠轮询 @，私聊靠 WebSocket 的 `message_type=private` 事件。私聊没有观察窗，每收到一条私聊消息都会直接唤醒目标会话。

- 唤醒提示里的消息行是 `昵称(QQ号)：内容（消息 #编号）`；如果消息里有图片，也会把图片一起给模型看（有 sharp 时 GIF 会拆成首/中/尾最多 3 帧；没有 sharp 时交给 DSH 显示首帧，和群聊记录的处理一致）。
- 模型用 `qq_get_private_history` 看和对方的最近记录，用 `qq_send_private_message` 回文字（传 `reply_to=#编号` 可以引用），用 `qq_send_face` 回表情。
- `qq_list_friends` 列好友，可以按昵称、备注或 QQ 号搜；`privateUsers` 非空时只列白名单里的好友。
- `qq_get_private_history` 的消息带 `#message_id`，可以传给 `qq_send_private_message` / `qq_send_face` 的 `reply_to` 做引用回复。
- 私聊唤醒的 `source.kind` 是 `qq-private`，和群聊的 `qq-mention` / `qq-followup` / `qq-poke` 区分开。

## 更改头像

`qq_set_avatar` 换自己的 QQ 头像，走 SnowLuma 的 `set_qq_avatar`。

- `file` 传 `http(s)` 链接、`base64://`、`data:image/...` 或本机文件路径；
- 也可以用 `message_id` + `index` 直接从聊天记录里取一张图（和 `qq_favorite_face` 的取图方式一致）；
- 本机路径指的是 SnowLuma 服务端能读到的路径；SnowLuma 不在同一台机器时用链接或 `base64://`；
- 工具描述里明确要求只在用户提出换头像时调用，换完不会重复说明。

## 好友管理

好友管理组件提供 7 个工具，数据都来自 SnowLuma 的好友接口：

- `qq_get_friend_info`：昵称、备注、分组、性别年龄、等级、VIP、是否单向好友；不在好友列表里的人也会尽量给出陌生人资料。受 `privateUsers` 白名单限制。SnowLuma 的 `get_unidirectional_friend_list` 在部分版本会报 protobuf 错误，这时单向好友显示「未知」。
- `qq_list_friend_categories`：好友分组和每组里的成员，返回 `category_id` / `category_name`。接口不可用时退回普通好友列表；接口漏掉的人会用普通好友列表补齐，放进「未分组（接口未返回）」（真实环境遇到过 86 个好友只返回 83 个）。
- `qq_update_friend`：改备注（`remark` 传空字符串清空）或移动分组（`category_id` 或唯一匹配的 `category_name`）。
- `qq_delete_friend`：删好友，不可撤销；必须显式传 `confirm=true`，`block=true` 会在删除时同时屏蔽对方。
- `qq_send_like`：给好友名片点赞，`times` 默认 1，最多 20。
- `qq_list_friend_requests`：待处理的好友申请。普通申请来自插件运行期间的 WebSocket `request` 事件；可疑申请通过 `get_doubt_friends_add_request` 读取。每项都带 `flag`。
- `qq_handle_friend_request`：按 `flag`（或 `user_id` 在收件箱里查）同意/拒绝，`approve` 必须显式传 `true` 或 `false`；`kind=friend` 处理普通申请，`kind=doubt` 处理可疑申请。

SnowLuma 没有「列出历史好友申请」的 HTTP 接口，所以普通申请只在插件启动后收到才进收件箱；更早的申请要去 QQ 客户端看。关掉好友管理组件会停掉这个收件箱的 WebSocket 监听。

## QQ空间

QQ空间组件提供 4 个工具，走 SnowLuma 的「空间」扩展：

- `qq_list_qzone`：默认列自己的说说；传 `target_uin` 看别人的；`feeds=true` 看好友动态，翻页时把上一页的 `next_cursor` 放进 `cursor`。返回 `tid`、正文、时间、评论数和图片预览（最多 4 张）。好友动态只保留说说（`appid=311`）；部分 SnowLuma 版本不解析 feed 的 `tid/content`，工具会从 HTML 里补回 `tid`，补不回来的只能看不能互动；相册、广告等非说说会跳过并提示数量。
- `qq_get_qzone_post`：看一条说说的详情和评论，返回评论的 `comment_id`、作者 `uin`，以及楼中楼回复。
- `qq_send_qzone_post`：发说说。`content` 是正文，`images` 支持链接 / `base64://` / 本机路径（最多 9 张，本机路径同样由 SnowLuma 读取），也可以用 `message_id` + `image_indexes` 从消息里取图。`visibility` 取值：
  - `public` 所有人可见（默认）
  - `friends` 好友可见
  - `partial` 指定好友可见（要传 `target_uins`）
  - `private` 仅自己可见
  - `exclude` 指定好友不可见（要传 `target_uins`）
- `qq_manage_qzone`：`action` 选一个：
  - `like` / `unlike`：点赞或取消赞，`abstime` 传列表里的 `time` 更可靠；
  - `comment`：评论或回复；回复一级评论传 `comment_id` + `comment_uin`，回复楼中楼再传 `reply_uin` + `reply_name`；只有普通评论能带图；
  - `delete`：删除自己空间的一条说说，不可撤销，必须传 `confirm=true`；
  - `set_right`：改自己空间一条说说的可见范围，参数和发说说时的 `visibility` 一致；
  - `ban` / `unban`：拉黑或解除拉黑某人的空间访问（修改的是你自己空间的黑名单）。

这些接口是 SnowLuma 的扩展，NapCat 上不一定都有；接口不可用时工具会返回 OneBot 的错误原文，不会影响群聊/私聊工具。

## 安装

DSH 插件用 `dsh plugin` 安装。`<profile>` 换成你启动 DSH 用的 profile 名（桌面端通常是 `desktop`，Web 端常见 `web`，也可以是 `tui` 或你自己的 profile）。

### 从 GitHub 安装（现在就能用）

```sh
dsh plugin --profile <profile> add github:cyhddyx/dsh-qq-tools
```

本插件是纯 JavaScript，没有构建步骤，所以不需要 `prepare` 脚本，也不需要给 pnpm 加 `allowBuilds` 授权。安装完成后重启 DSH，插件页里应该能看到 11 个工具组（外加「挂载会话」），每个带开关。

### 从 npm 安装（推荐）

已发布到 npm，装最新版：

```sh
dsh plugin --profile <profile> add dsh-qq-tools
```

需要固定版本时：

```sh
dsh plugin --profile <profile> add dsh-qq-tools@0.9.1
```

### 本地开发 / 自己改代码

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-qq-tools
```

### 离线 tarball

```sh
pnpm pack
dsh plugin --profile <profile> add ./dsh-qq-tools-0.9.1.tgz
```

`dsh plugin` 会在安装后自动把这个包追加进 profile 的 `dsh.profile.bundles`，不用手改 `package.json`。卸载用：

```sh
dsh plugin --profile <profile> remove dsh-qq-tools
```

## 依赖

- DSH 0.2.x（cordis 插件体系）
- Node.js 22+（内置 `fetch` / `WebSocket`）
- SnowLuma 提供 OneBot 11 HTTP 接口和 WebSocket 事件。系统表情、群聊和私聊 NapCat 也能用；收藏表情、更改头像、好友分组/备注/申请和 QQ 空间依赖 SnowLuma 的扩展接口，NapCat 上不保证可用。
- 可选：`sharp`（GIF 拆帧、尺寸被拒时的兜底重编码）。会从 `SHARP_PATH`、插件自己的 `node_modules`、DSH 宿主 runtimeDir（桌面版通过 `process.argv[2]` 传入）等位置自动查找；找不到时 GIF 交给 DSH 显示首帧，大图仍由 DSH 自动归一化（默认单张源图上限 20MiB），图片不会因此丢失。

改完代码可以跑 `npm test`：它会起一个假 OneBot HTTP 服务、用临时 `DSH_HOME` 加载工具，检查头像、好友管理、好友申请和 QQ 空间的请求体与校验，不连真实 QQ，也不碰 `~/.dsh/qq-tools-config.json`。

---

版本：0.9.1
