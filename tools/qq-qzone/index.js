import {
  admitImagesFor,
  makeGetQzonePostTool,
  makeListQzoneTool,
  makeManageQzoneTool,
  makeSendQzonePostTool,
  mountOneTool,
} from '../../lib/shared.js'

export const name = 'qq-tools-qzone'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  const admitImages = admitImagesFor(ctx)
  const tools = [
    mountOneTool(ctx, makeListQzoneTool(admitImages)),
    mountOneTool(ctx, makeGetQzonePostTool(admitImages)),
    mountOneTool(ctx, makeSendQzonePostTool()),
    mountOneTool(ctx, makeManageQzoneTool()),
  ]
  return { tools }
}
