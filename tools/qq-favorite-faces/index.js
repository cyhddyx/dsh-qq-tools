import { makeListFacesTool, makeFavoriteFaceTool } from '../../lib/tools/faces.js'
import { mountOneTool } from '../../lib/session.js'

export const name = 'qq-tools-favorite-faces'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  const list = mountOneTool(ctx, makeListFacesTool())
  const fav = mountOneTool(ctx, makeFavoriteFaceTool())
  return { tools: [list, fav] }
}
