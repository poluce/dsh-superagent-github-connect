/** Reading and judging the management API state that the CLI reports as its JSON output. */

/** Exit code for a service whose component, such as a Source, reports an error that a restart does not fix. */
export const PART_ERROR = 2
/** Exit code for a service that runs and waits for setup, which a restart does not fix either. */
export const SETUP_WAITS = 3

/**
 * Reduce an `/orchestrator/api/state` answer to the CLI's view of it.
 *
 * Keys another version omits read as empty, so a service is not mistaken for unreachable. A health entry that is
 * not an object counts as empty, and error details become strings because the JSON output prints them.
 */
export function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {}
  const health = source.health && typeof source.health === 'object' ? source.health : {}
  const setup = source.setup && typeof source.setup === 'object' ? source.setup : {}
  const entries = {}
  for (const [name, entry] of Object.entries(health)) {
    entries[name] = entry && typeof entry === 'object' ? entry : {}
  }
  const healthStates = {}
  const errors = {}
  for (const [name, entry] of Object.entries(entries)) {
    healthStates[name] = entry.state ?? null
    if (entry.state === 'error') errors[name] = String(entry.detail ?? '')
  }
  return {
    health: healthStates,
    errors,
    setup: setup.problem ?? null,
    feishu: setup.feishuProblem ?? null,
  }
}

/** Fetch the management API state, or return null when the service does not answer; a two-second wait is a hung service. */
export async function fetchState(url, { fetchImpl = globalThis.fetch } = {}) {
  const endpoint = String(url).replace(/\/+$/, '') + '/orchestrator/api/state'
  try {
    const response = await fetchImpl(endpoint, {
      headers: { 'x-orchestrator-request': '1' },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return null
    return normalizeState(await response.json())
  } catch {
    return null
  }
}

/** Whether the runtime is ready or paused awaiting operator action; a component still starting does not hold this up. */
export function runtimeUp(current) {
  const runtime = current?.health?.runtime
  return runtime === 'ready' || runtime === 'paused'
}

/** Non-runtime components in an error state, sorted by name. */
export function partErrors(current) {
  const errors = {}
  for (const name of Object.keys(current?.errors ?? {}).sort()) {
    if (name !== 'runtime') errors[name] = current.errors[name]
  }
  return errors
}

/**
 * Compute the CLI exit code from running PIDs and management API state.
 *
 * A service is healthy only when exactly one process serves the profile and its runtime answers; setup and a
 * component error keep their own codes because a restart fixes neither.
 */
export function outcome(pids, current) {
  if (pids.length !== 1 || !runtimeUp(current)) return 1
  if (current.setup) return SETUP_WAITS
  return Object.keys(partErrors(current)).length ? PART_ERROR : 0
}
