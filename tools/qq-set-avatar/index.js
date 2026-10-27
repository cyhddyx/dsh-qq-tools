import { makeSetAvatarTool, mountOneTool } from '../../lib/shared.js'

export const name = 'qq-tools-set-avatar'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  return mountOneTool(ctx, makeSetAvatarTool())
}
