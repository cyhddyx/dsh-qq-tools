import { makeSendTool, mountOneTool, startMentionPolling, startObservation } from '../../lib/shared.js'

export const name = 'qq-tools-send-group-message'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  const mounted = mountOneTool(ctx, makeSendTool(startObservation))
  startMentionPolling(ctx)
  return mounted
}
