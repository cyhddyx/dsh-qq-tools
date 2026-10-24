import { makeSendFaceTool, mountOneTool, startObservation } from '../../lib/shared.js'

export const name = 'qq-tools-send-face'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  return mountOneTool(ctx, makeSendFaceTool(startObservation))
}
