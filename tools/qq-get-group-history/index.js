import { admitImagesFor, makeHistoryTool, mountOneTool } from '../../lib/shared.js'

export const name = 'qq-tools-group-history'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  return mountOneTool(ctx, makeHistoryTool(admitImagesFor(ctx)))
}
