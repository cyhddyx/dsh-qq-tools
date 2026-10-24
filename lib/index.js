// dsh-qq-tools —— 包根入口。
//
// 两用：
//   · cordis.patch.yml 里的包根行用 config.carrier = true 启动它，只承载
//     「挂载会话」的 HTTP 接口；浏览器半侧（lib/client.js）也只能从包根行
//     被发现，子路径行不会被 dsh-client-modules 扫描到。
//   · 旧配置直接引用 `dsh-qq-tools` 时没有 carrier 标记，仍然挂全部工具。
import { mountAll, mountTargetSessionRoute } from './shared.js'

export * from './shared.js'

export const name = 'qq-tools'
export const inject = ['agents', 'timer', 'tools', 'attachments', 'webServer']

export function apply(ctx, config) {
  if (config && config.carrier === true) {
    mountTargetSessionRoute(ctx)
    return {}
  }
  return mountAll(ctx)
}
