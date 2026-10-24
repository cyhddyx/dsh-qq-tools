import { makeListTool, mountOneTool } from '../../lib/shared.js'

export const name = 'qq-tools-list-groups'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  return mountOneTool(ctx, makeListTool())
}
