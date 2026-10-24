# dsh-qq-tools

给 DSH（DeepSeek Harness）里的大肥鱼会话用的 QQ 群/私聊工具，走 OneBot 11 HTTP + WebSocket。系统表情在 SnowLuma / NapCat 上都能发；收藏表情用 SnowLuma 的自定义表情扩展接口，和 QQ 客户端里的收藏夹是同一份数据。

8 个工具各自是一个独立的 cordis 组件，在 DSH 插件页的「包含的组件」里可以逐个开关：

| 组件 | 工具 | 说明 |
| --- | --- | --- |
| 列出 QQ 群 | `qq_list_groups` | 群号、群名、人数 |
| 看群聊天记录 | `qq_get_group_history` | 最近消息 + 图片，只读；消息带 `#message_id` |
| 看群成员 | `qq_get_group_members` | 昵称、群名片、QQ 号、身份 |
| 发群消息 | `qq_send_group_message` | 发群消息；同时负责 @ 提醒和群后续轮询 |
| 发表情 | `qq_send_face` | 在群里或私聊里发系统表情或 QQ 收藏夹里的自定义表情，可带一句话 |
| 收藏表情 | `qq_list_faces` / `qq_favorite_face` | 看/管理 QQ 账号收藏夹（SnowLuma）：收藏图片、取消收藏、改备注、移到最前 |
| 私聊 | `qq_list_friends` / `qq_get_private_history` / `qq_send_private_message` | 好友列表、私聊记录、发私聊消息；同时负责私聊消息唤醒 |
| 戳一戳 | `qq_send_poke` | 戳人；同时负责接收戳一戳事件 |

关掉「发群消息」会同时停掉 @ 提醒轮询，关掉「私聊」会同时停掉私聊消息唤醒，关掉「戳一戳」会同时停掉戳一戳通知；三个只读工具互不影响。

## 目录结构

```
cordis.patch.yml                 8 个组件行
lib/shared.js                    共享核心：配置、OneBot、挂载、@ 轮询、私聊唤醒、戳一戳、表情、观察窗
lib/index.js                     兼容入口：一个插件挂全部工具（bundle 不使用）
tools/qq-list-groups/            组件入口 + locale
tools/qq-get-group-history/
tools/qq-get-group-members/
tools/qq-send-group-message/
tools/qq-send-face/
tools/qq-favorite-faces/
tools/qq-private-chat/
tools/qq-send-poke/
```

每个 `tools/<组件>/index.js` 只做一件事：把自己的工具挂到目标会话。`locale/{en,zh}.json` 提供插件页显示的标题和说明。

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
- `targetSession` 是目标会话 ID；留空时工具不会挂到任何会话。
- `groups` 是允许看/发的群；空数组表示不限制。
- `mentionEnabled` / `pokeEnabled` / `privateEnabled` 分别是 @ 轮询、戳一戳事件、私聊唤醒的总闸，对应组件关掉时它们也不会运行。
- `privateUsers` 是允许唤醒和私聊工具的 QQ 白名单；空数组表示不限制。非空时，不在列表里的私聊消息不会唤醒，`qq_list_friends` 也不会列出他们。

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

## 私聊

私聊和群聊在程序里是分开的两条路径：群聊靠轮询 @，私聊靠 WebSocket 的 `message_type=private` 事件。私聊没有观察窗，每收到一条私聊消息都会直接唤醒目标会话。

- 唤醒提示里会带发送者昵称、QQ 号、`message_id` 和文字；如果消息里有图片，也会把图片一起给模型看。
- 模型用 `qq_get_private_history` 看和对方的最近记录，用 `qq_send_private_message` 回文字，用 `qq_send_face` 回表情。
- `qq_list_friends` 列好友，可以按昵称、备注或 QQ 号搜；`privateUsers` 非空时只列白名单里的好友。
- `qq_get_private_history` 的消息带 `#message_id`，可以传给 `qq_send_private_message` / `qq_send_face` 的 `reply_to` 做引用回复。
- 私聊唤醒的 `source.kind` 是 `qq-private`，和群聊的 `qq-mention` / `qq-followup` / `qq-poke` 区分开。

## 安装

DSH 插件用 `dsh plugin` 安装。`<profile>` 换成你启动 DSH 用的 profile 名（桌面端通常是 `desktop`，Web 端常见 `web`，也可以是 `tui` 或你自己的 profile）。

### 从 GitHub 安装（现在就能用）

```sh
dsh plugin --profile <profile> add github:cyhddyx/dsh-qq-tools
```

本插件是纯 JavaScript，没有构建步骤，所以不需要 `prepare` 脚本，也不需要给 pnpm 加 `allowBuilds` 授权。安装完成后重启 DSH，插件页里应该能看到 8 个组件，每个带开关。

### 从 npm 安装（发布后可用）

```sh
dsh plugin --profile <profile> add dsh-qq-tools
```

### 本地开发 / 自己改代码

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-qq-tools
```

### 离线 tarball

```sh
pnpm pack
dsh plugin --profile <profile> add ./dsh-qq-tools-0.7.0.tgz
```

`dsh plugin` 会在安装后自动把这个包追加进 profile 的 `dsh.profile.bundles`，不用手改 `package.json`。卸载用：

```sh
dsh plugin --profile <profile> remove dsh-qq-tools
```

## 依赖

- DSH 0.2.x（cordis 插件体系）
- Node.js 22+（内置 `fetch` / `WebSocket`）
- SnowLuma 提供 OneBot 11 HTTP 接口和 WebSocket 事件（收藏表情需要 SnowLuma；系统表情 NapCat 也能发）
- 可选：`sharp`（GIF 帧拆分；没有也能用，GIF 会按静图处理）

---

版本：0.7.0
