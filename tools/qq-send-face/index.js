import { admitImagesFor, makeSendFaceTool, mountOneTool, startObservation } from '../../lib/shared.js'

export const name = 'qq-tools-send-face'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  return mountOneTool(ctx, makeSendFaceTool(startObservation, admitImagesFor(ctx)))
}
