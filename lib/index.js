// dsh-qq-tools —— 整体插件入口（兼容用）
//
// 正常的 bundle 入口现在是 cordis.patch.yml 里的 8 个组件行，每个工具一个组件、
// 各自有开关。这个文件保留成「一个插件挂全部工具」的老入口，方便直接引用
// `dsh-qq-tools` 的旧配置；DSH 插件页不会用它。
import { mountAll } from './shared.js'

export * from './shared.js'

export const name = 'qq-tools'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  return mountAll(ctx)
}
