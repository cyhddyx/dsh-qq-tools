import { admitImagesFor } from '../../lib/images.js'
import { makeSendFaceTool } from '../../lib/tools/faces.js'
import { mountOneTool } from '../../lib/session.js'
import { startObservation } from '../../lib/observation.js'

export const name = 'qq-tools-send-face'
export const inject = ['agents', 'timer', 'tools', 'attachments']

export function apply(ctx) {
  return mountOneTool(ctx, makeSendFaceTool(startObservation, admitImagesFor(ctx)))
}
