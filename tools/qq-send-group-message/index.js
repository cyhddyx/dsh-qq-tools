import { makeSendTool } from '../../lib/tools/groups.js'
import { mountOneTool } from '../../lib/session.js'
import { startMentionPolling } from '../../lib/watchers/mentions.js'
import { startObservation } from '../../lib/observation.js'

export const name = 'qq-tools-send-group-message'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  const mounted = mountOneTool(ctx, makeSendTool(startObservation))
  startMentionPolling(ctx)
  return mounted
}
