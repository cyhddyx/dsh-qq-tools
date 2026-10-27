import {
  makeDeleteFriendTool,
  makeGetFriendInfoTool,
  makeHandleFriendRequestTool,
  makeListFriendCategoriesTool,
  makeListFriendRequestsTool,
  makeSendLikeTool,
  makeUpdateFriendTool,
  mountOneTool,
  startFriendRequestWatcher,
} from '../../lib/shared.js'

export const name = 'qq-tools-friend-management'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  const tools = [
    mountOneTool(ctx, makeGetFriendInfoTool()),
    mountOneTool(ctx, makeListFriendCategoriesTool()),
    mountOneTool(ctx, makeUpdateFriendTool()),
    mountOneTool(ctx, makeDeleteFriendTool()),
    mountOneTool(ctx, makeSendLikeTool()),
    mountOneTool(ctx, makeListFriendRequestsTool()),
    mountOneTool(ctx, makeHandleFriendRequestTool()),
  ]
  startFriendRequestWatcher(ctx)
  return { tools }
}
