import { admitImagesFor } from '../../lib/images.js'
import { makeListFriendsTool, makePrivateHistoryTool, makeSendPrivateTool } from '../../lib/tools/private.js'
import { mountOneTool } from '../../lib/session.js'
import { startPrivateWatcher } from '../../lib/watchers/private.js'

export const name = 'qq-tools-private-chat'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  const admitImages = admitImagesFor(ctx)
  const friends = mountOneTool(ctx, makeListFriendsTool())
  const history = mountOneTool(ctx, makePrivateHistoryTool(admitImages))
  const send = mountOneTool(ctx, makeSendPrivateTool())
  startPrivateWatcher(ctx, admitImages)
  return { tools: [friends, history, send] }
}
