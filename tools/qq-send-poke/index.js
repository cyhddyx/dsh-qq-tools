import { makePokeTool } from '../../lib/tools/poke.js'
import { mountOneTool } from '../../lib/session.js'
import { startObservation } from '../../lib/observation.js'
import { startPokeWatcher } from '../../lib/watchers/poke.js'

export const name = 'qq-tools-send-poke'
export const inject = ['agents', 'timer', 'tools']

export function apply(ctx) {
  const mounted = mountOneTool(ctx, makePokeTool(startObservation))
  startPokeWatcher(ctx)
  return mounted
}
