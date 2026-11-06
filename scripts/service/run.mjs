/** Run an external command without a shell and resolve with its exit code instead of throwing on a non-zero one. */
import { execFile } from 'node:child_process'

/**
 * Run `command` and resolve `{ code, stdout, stderr }`.
 *
 * A command that cannot start at all (for example a missing binary) resolves with code -1, so a caller that expects
 * a failure can treat a missing tool as a failed run instead of an unhandled exception.
 */
export function runCommand(command, args = [], options = {}) {
  return new Promise(resolve => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
  })
}
