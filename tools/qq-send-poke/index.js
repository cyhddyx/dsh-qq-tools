import { makePokeTool, mountOneTool, startObservation, startPokeWatcher } from '../../lib/shared.js'

export const name = 'qq-tools-send-poke'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  const mounted = mountOneTool(ctx, makePokeTool(startObservation))
  startPokeWatcher(ctx)
  return mounted
}
