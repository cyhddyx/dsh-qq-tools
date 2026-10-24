import { admitImagesFor, makeListFacesTool, makeFavoriteFaceTool, mountOneTool } from '../../lib/shared.js'

export const name = 'qq-tools-favorite-faces'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  const list = mountOneTool(ctx, makeListFacesTool(admitImagesFor(ctx)))
  const fav = mountOneTool(ctx, makeFavoriteFaceTool())
  return { tools: [list, fav] }
}
