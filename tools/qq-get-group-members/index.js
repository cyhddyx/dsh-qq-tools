import { makeMembersTool } from '../../lib/tools/groups.js'
import { mountOneTool } from '../../lib/session.js'

export const name = 'qq-tools-group-members'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  return mountOneTool(ctx, makeMembersTool())
}
