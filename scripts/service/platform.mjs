/** Choose the platform adapter and add the effects every run shares: output, sleeping, the clock and the state fetch. */
import { fetchState } from './state.mjs'
import { createPosixPlatform } from './platform-posix.mjs'
import { createWindowsPlatform } from './platform-win32.mjs'

/**
 * Build the dependencies of the service for `platform`.
 *
 * The adapter supplies process discovery, startup and stop; the shared parts print to this process and use a
 * monotonic clock, so `--timeout` does not jump when the system clock changes.
 */
export function createPlatformDeps({ platform = process.platform, root, env = process.env } = {}) {
  const common = {
    platform,
    root,
    fetchState,
    stdout: text => { process.stdout.write(text + '\n') },
    stderr: text => { process.stderr.write(text + '\n') },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => performance.now(),
  }
  const adapter = platform === 'win32'
    ? createWindowsPlatform({ root, env })
    : createPosixPlatform({ root, env })
  return { ...common, ...adapter }
}
