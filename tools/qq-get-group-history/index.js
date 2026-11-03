import { admitImagesFor } from '../../lib/images.js'
import { makeHistoryTool } from '../../lib/tools/groups.js'
import { mountOneTool } from '../../lib/session.js'

export const name = 'qq-tools-group-history'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  return mountOneTool(ctx, makeHistoryTool(admitImagesFor(ctx)))
}
