import { makeMembersTool, mountOneTool } from '../../lib/shared.js'

export const name = 'qq-tools-group-members'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  return mountOneTool(ctx, makeMembersTool())
}
