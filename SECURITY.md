# 权限、依赖与失败边界

本插件是 OneBot 11 / SnowLuma QQ 账号桥接，按 `build-dsh-plugin` 的分级属于 R2（网络、凭据、外部账号）。插件以 DSH 宿主进程的权限运行，没有独立的文件或网络沙箱。DSH STORE 的保守权限等级应为 `high`；源码具备文件、网络和凭据能力，不能声明为无权限的 `source-verified`。是否采用 `user-reviewed` 或继续 `blocked` 由商城针对固定 Commit 的审阅决定。

## 权限矩阵

| 能力 | 使用位置、数据和范围 | 限制与失败行为 |
| --- | --- | --- |
| 文件读写 | `$DSH_HOME/qq-tools-config.json`（未设置时为 `~/.dsh`），其中含 OneBot `accessToken`；保存时写同目录 `.tmp` 再重命名 | 仅设置页面的 `targetSession` 可通过浏览器接口修改；配置文件无效/不可读时退回默认值，保存失败返回错误。该文件是明文配置，应使用操作系统文件权限保护 |
| 诊断日志 | 同目录 `qq-tools-diag.log` | 追加运行信息、QQ 号、会话 ID，部分唤醒日志包含截断至 200–300 字符的消息内容。没有自动轮转；不应公开原始日志 |
| 本地图片读取 | `lib/shared.js` 的 `imageBytes` 可读取 OneBot 图片数据或 `get_image` 返回的本机路径 | 路径没有目录白名单；需要信任 OneBot 服务。头像、收藏表情和空间图片的路径还可转交 SnowLuma，由服务端读取 |
| 可选模块加载 | `SHARP_PATH`、插件/宿主 `node_modules`、运行参数目录、Electron resources 和已加载模块缓存中的 `sharp` | `SHARP_PATH` 是可执行模块位置，应仅由可信本机用户设置；不会自动安装。缺失时跳过 GIF 拆帧/重编码兜底 |
| 网络 | 配置的 `napCat`（默认 `http://127.0.0.1:3000`）、`wsUrl`（默认 `ws://127.0.0.1:3001`），以及消息中的图片 URL / OneBot 返回的图片 URL | 地址可配置、图片地址不限定域名。OneBot 请求默认 6 秒超时，配置限制为 1–15 秒；首选图片 URL 请求为 8 秒，其他图片回退请求目前没有单独超时或下载字节上限。不应将服务连接到不可信来源 |
| 凭据 | 从插件配置读取 `accessToken`；HTTP 使用 `Authorization: Bearer`，WebSocket 使用 URL 查询参数 `access_token` | 不向浏览器返回 token，也不由插件申请 QQ 密码/cookie。明文 HTTP/WS 不提供传输加密；远程部署应由用户使用可信 HTTPS/WSS，并注意服务端/代理可能记录 WS URL |
| DSH 会话 | 列出运行中会话 ID，在选定会话注册工具并通过 `agent.followup` 注入 QQ 消息、图片 | `targetSession` 为空时不挂工具、不唤醒；消息和图片会进入该会话及其模型提供方。QQ 输入是外部不可信内容，不应被当作管理者授权 |
| QQ 读写操作 | 查询群/好友/聊天记录、发送消息、收藏表情、改头像、好友申请/备注/分组/删除、QQ 空间发布/评论/删除/权限/黑名单 | 群与私聊受各自白名单限制；空名单表示工具不限制。处理新好友申请不受私聊名单限制。删好友和删说说要求 `confirm=true`，但这是工具参数校验，不是独立的人类确认界面 |
| 设置 HTTP 接口 | `/api/dsh-qq-tools/target-session`：GET 读取目标及存活会话 ID，POST 修改目标 | 依赖宿主 Web 服务的登录与访问控制，插件另检查 Origin host；请求体最多 64 KiB，目标 ID 清洗并截断至 200 字符。不要未经保护向公网暴露宿主 |

## 依赖和供应链

- 必需运行时：Node.js >=22（内置 `fetch` / `WebSocket`），DSH 0.2.x 标准 Bundle 宿主；版本声明及验收记录见 `package.json` 和 `docs/verification/README.md`。
- npm manifest 没有必需运行依赖、安装生命周期脚本或构建步骤，执行文件已包含在源码及 tarball 中。
- 外部服务需用户自行运行并登录 QQ：OneBot 11 HTTP + WebSocket（SnowLuma / NapCat）。收藏表情、头像、好友管理、空间等扩展依赖 SnowLuma；不支持的接口返回错误，不自动安装替代服务。
- 可选本机模块：`sharp`。宿主或用户提供的原生模块不在本插件的无依赖声明范围内，需要单独信任。
- 不启动子进程，不修改 DSH 核心、`@deepseek-ai/*` 或官方插件清单，不执行 Profile 安装/升级/卸载。

## 生命周期与恢复

- 关闭对应组件会注销工具并停止其轮询/WS watcher；WS 断线约 5 秒后重连。已经发出的请求或已交给宿主的 followup 不提供事务撤销。
- OneBot 超时、HTTP/JSON/API 错误会返回工具错误；一次操作可能已在 QQ 端完成，例如先发文字再发表情时后一步失败。重试前应先查看 QQ 实际状态，不保证跨服务原子性或恰好一次投递。
- 卸载通过官方 `dsh plugin --profile <profile> remove dsh-qq-tools` 完成。插件配置与诊断日志保留，不自动删除账号数据；需要清除时，先停用插件，再由用户自行备份/删除这两个插件专用文件。
- QQ 发消息、删好友、删除说说等外部动作无法通过回滚插件包撤销。Profile 安装/卸载证据只证明包及 Bundle 的生命周期，不代表 QQ 账号功能或安全审计已通过。

## 报告问题

公开 Issue 请仅提供脱敏错误、版本、复现步骤。不要上传 token、Cookie、完整配置、聊天记录或未经脱敏的诊断日志。发现敏感数据时先撤销/更换相关服务的凭据，再移除公开内容。
