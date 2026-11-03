import { makeSetAvatarTool } from '../../lib/tools/avatar.js'
import { mountOneTool } from '../../lib/session.js'

export const name = 'qq-tools-set-avatar'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  return mountOneTool(ctx, makeSetAvatarTool())
}
