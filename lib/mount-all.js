// 兼容：老的整体插件入口（一个插件挂全部工具）。

import { admitImagesFor } from './images.js'
import { mountOneTool } from './session.js'
import { startObservation } from './observation.js'
import { makeListTool, makeHistoryTool, makeMembersTool, makeSendTool } from './tools/groups.js'
import { makeListFriendsTool, makePrivateHistoryTool, makeSendPrivateTool } from './tools/private.js'
import { makeSendFaceTool, makeListFacesTool, makeFavoriteFaceTool } from './tools/faces.js'
import { makePokeTool } from './tools/poke.js'
import { makeSetAvatarTool } from './tools/avatar.js'
import {
  makeGetFriendInfoTool, makeListFriendCategoriesTool, makeUpdateFriendTool,
  makeDeleteFriendTool, makeSendLikeTool, makeListFriendRequestsTool,
  makeHandleFriendRequestTool, startFriendRequestWatcher,
} from './tools/friends.js'
import { makeListQzoneTool, makeGetQzonePostTool, makeSendQzonePostTool, makeManageQzoneTool } from './tools/qzone.js'
import { startMentionPolling } from './watchers/mentions.js'
import { startPokeWatcher } from './watchers/poke.js'
import { startPrivateWatcher } from './watchers/private.js'

export function mountAll(ctx) {
  const admitImages = admitImagesFor(ctx)
  const list = mountOneTool(ctx, makeListTool())
  const history = mountOneTool(ctx, makeHistoryTool(admitImages))
  const members = mountOneTool(ctx, makeMembersTool())
  const send = mountOneTool(ctx, makeSendTool(startObservation))
  const face = mountOneTool(ctx, makeSendFaceTool(startObservation, admitImages))
  const faceList = mountOneTool(ctx, makeListFacesTool())
  const faceFav = mountOneTool(ctx, makeFavoriteFaceTool())
  const poke = mountOneTool(ctx, makePokeTool(startObservation))
  const avatar = mountOneTool(ctx, makeSetAvatarTool())
  const friends = mountOneTool(ctx, makeListFriendsTool())
  const privateHistory = mountOneTool(ctx, makePrivateHistoryTool(admitImages))
  const privateSend = mountOneTool(ctx, makeSendPrivateTool())
  const friendInfo = mountOneTool(ctx, makeGetFriendInfoTool())
  const friendCategories = mountOneTool(ctx, makeListFriendCategoriesTool())
  const friendUpdate = mountOneTool(ctx, makeUpdateFriendTool())
  const friendDelete = mountOneTool(ctx, makeDeleteFriendTool())
  const friendLike = mountOneTool(ctx, makeSendLikeTool())
  const friendRequests = mountOneTool(ctx, makeListFriendRequestsTool())
  const friendHandle = mountOneTool(ctx, makeHandleFriendRequestTool())
  const qzoneList = mountOneTool(ctx, makeListQzoneTool(admitImages))
  const qzoneDetail = mountOneTool(ctx, makeGetQzonePostTool(admitImages))
  const qzoneSend = mountOneTool(ctx, makeSendQzonePostTool())
  const qzoneManage = mountOneTool(ctx, makeManageQzoneTool())
  startMentionPolling(ctx)
  startPokeWatcher(ctx)
  startPrivateWatcher(ctx, admitImages)
  startFriendRequestWatcher(ctx)
  return {
    tools: [
      list, history, members, send, face, faceList, faceFav, poke, avatar,
      friends, privateHistory, privateSend,
      friendInfo, friendCategories, friendUpdate, friendDelete, friendLike, friendRequests, friendHandle,
      qzoneList, qzoneDetail, qzoneSend, qzoneManage,
    ],
    startObservation,
  }
}
