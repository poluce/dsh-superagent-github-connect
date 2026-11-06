/**
 * POSIX platform adapter: discovery through `ps`, startup through tmux, and stop through SIGINT.
 *
 * This keeps the Linux behaviour of the original script: a tmux session named `dsh-<profile>` hosts the service so
 * attaching to it stays possible, `exec` makes the pane PID the service PID, and the shell sets `umask 077` before DSH
 * starts so the log and the state it writes stay private.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { parsePsOutput } from './processes.mjs'
import { runCommand } from './run.mjs'

/** `ps` fields: PID, command name, full command line. */
const PS_FORMAT = 'pid=,ucomm=,args='

/** Quote one word for a POSIX shell the way `shlex.quote` does. */
export function shellQuote(word) {
  const text = String(word)
  if (text === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text
  return "'" + text.replaceAll("'", "'\"'\"'") + "'"
}

/** Join words into one shell command line, quoting only what needs it. */
export function shellJoin(words) {
  return words.map(shellQuote).join(' ')
}

/** Resolve a command on PATH the way `shutil.which` does; POSIX requires the file to be executable. */
export function whichOnPath(command, env = process.env) {
  for (const directory of String(env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory || '.', command)
    try {
      if (!statSync(candidate).isFile()) continue
      if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking through PATH.
    }
  }
  return null
}

/**
 * Build the POSIX dependencies of the service.
 *
 * `run` and `kill` are injectable so the command construction can be tested on any platform without launching tmux.
 */
export function createPosixPlatform({ root, env = process.env, run = runCommand, kill = process.kill } = {}) {
  const listProcesses = async () => {
    const result = await run('ps', ['-ww', '-ax', '-o', PS_FORMAT])
    if (result.code !== 0) throw new Error(`ps failed with code ${result.code}: ${result.stderr.trim()}`)
    return parsePsOutput(result.stdout)
  }
  const processExists = async pid => {
    // `ps -p` prints nothing once the process exits, so a failure means it is gone rather than an error.
    const result = await run('ps', ['-ww', '-p', String(pid), '-o', PS_FORMAT])
    if (result.code !== 0) return null
    return parsePsOutput(result.stdout).find(entry => entry.pid === pid) ?? null
  }
  const sessionExists = async session => (await run('tmux', ['has-session', '-t', '=' + session])).code === 0
  return {
    which: async command => whichOnPath(command, env),
    listProcesses,
    processExists,
    sessionExists,
    launchService: async ({ profile, root: checkout, logPath, dshPath, sessionName, sessionExists: exists }) => {
      // `exec` replaces the shell so the pane PID tmux prints is the DSH service process itself.
      const command = 'umask 077; exec ' + shellJoin([dshPath, '--profile', profile, '--no-open'])
        + ' >> ' + shellQuote(logPath) + ' 2>&1'
      // Reuse an existing tmux session without disturbing other windows.
      const target = exists ? ['new-window', '-t', '=' + sessionName + ':'] : ['new-session', '-s', sessionName]
      const result = await run('tmux',
        [...target, '-d', '-P', '-F', '#{pane_pid}', '-n', 'server', '-c', checkout, command])
      if (result.code !== 0) throw new Error(`tmux failed with code ${result.code}: ${result.stderr.trim()}`)
      const pane = result.stdout.trim()
      return { pid: /^\d+$/.test(pane) ? Number(pane) : null }
    },
    stopProcess: async pid => { kill(pid, 'SIGINT') },
  }
}
