/**
 * Windows platform adapter: discovery through CIM (`Win32_Process`), startup through a hidden `cmd.exe` launcher, and
 * stop through `taskkill`.
 *
 * Windows has no tmux and no `ps`, so the service runs as a detached, windowless process started from a generated
 * `launch.cmd`. Two semantics degrade and are stated here so operators are not surprised:
 *
 * 1. Stop is a forced `taskkill /PID <pid> /T /F`: Windows cannot deliver Ctrl-C to a process that has no console
 *    attached, and it has no reliable cross-process SIGINT. An in-flight Executor step is therefore interrupted instead
 *    of finishing; `--stop-timeout` bounds the wait for the process to disappear after the kill rather than a graceful
 *    drain.
 * 2. The `umask 077` used on POSIX does not exist; `launch.cmd`, the log and the control files inherit the ACL of the
 *    checkout, so keep the clone in a directory whose permissions already keep other users out.
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findServiceEntries, parseCimOutput } from './processes.mjs'
import { runCommand } from './run.mjs'

/** CIM query for the processes that can host DSH; the command line is matched against the profile in JavaScript. */
const CIM_QUERY = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='dsh.exe'\""
  + ' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3'

/** How often startup looks for the PID of the node process behind the launcher. */
const DISCOVER_ATTEMPTS = 6
const DISCOVER_INTERVAL_MS = 250

/** The note printed after a successful Windows stop, which is a forced termination rather than a graceful drain. */
export const STOP_NOTE = 'Windows: forced termination (taskkill /T /F); an in-flight Executor step is interrupted.'

/** Find the Windows PowerShell that CIM works with, preferring the one every Windows install has. */
export function findPowerShell(env = process.env, exists = existsSync) {
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  const classic = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return exists(classic) ? classic : 'powershell.exe'
}

/** Escape a literal for `launch.cmd`: cmd.exe expands `%NAME%` even inside quotes. */
export function batchLiteral(value) {
  return String(value).replaceAll('%', '%%')
}

/**
 * Build the Windows dependencies of the service.
 *
 * `run`, `spawnProcess`, `pipeProcess` and `sleep` are injectable so the launcher contents, CIM parsing and the
 * `taskkill` call can be tested on any platform without starting a real service.
 */
export function createWindowsPlatform({
  root,
  env = process.env,
  run = runCommand,
  spawnProcess = spawn,
  powershell = findPowerShell(env),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const comspec = env.ComSpec ?? join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const taskkill = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

  const listProcesses = async () => {
    const result = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CIM_QUERY])
    if (result.code !== 0) throw new Error(`PowerShell failed to list processes with code ${result.code}: ${result.stderr.trim()}`)
    return parseCimOutput(result.stdout)
  }
  const processExists = async pid => {
    try {
      process.kill(pid, 0)
    } catch (error) {
      // A process that ended reports ESRCH; one owned by another user reports EPERM and still needs the CIM lookup.
      if (error?.code === 'ESRCH') return null
    }
    const entries = await listProcesses()
    return entries.find(entry => entry.pid === pid) ?? null
  }
  return {
    stopNote: STOP_NOTE,
    which: async command => {
      const result = await run('where.exe', [command])
      if (result.code !== 0) return null
      const [first] = result.stdout.split(/\r?\n/).filter(Boolean)
      return first?.trim() || null
    },
    listProcesses,
    processExists,
    launchService: async ({ profile, root: checkout, controlDir, logPath }) => {
      const launcher = join(controlDir, 'launch.cmd')
      writeFileSync(launcher, [
        '@echo off',
        `cd /d "${batchLiteral(checkout)}"`,
        `call dsh --profile ${profile} --no-open >> "${batchLiteral(logPath)}" 2>&1`,
        '',
      ].join('\r\n'))
      // `cmd /d /c call launcher.cmd` resolves `dsh` through PATH and its .cmd shim, and runs without a console window.
      const child = spawnProcess(comspec, ['/d', '/c', 'call', launcher],
        { cwd: checkout, detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      // The launcher is cmd.exe, so record the node process DSH becomes instead of the launcher itself.
      for (let attempt = 0; attempt < DISCOVER_ATTEMPTS; attempt += 1) {
        await sleep(DISCOVER_INTERVAL_MS)
        const [entry] = findServiceEntries(await listProcesses(), profile)
        if (entry) return { pid: entry.pid }
      }
      return { pid: child.pid ?? null }
    },
    stopProcess: async pid => {
      const result = await run(taskkill, ['/PID', String(pid), '/T', '/F'])
      // 128 means the process ended before the kill; a stop that races with an exit counts as stopped.
      if (result.code !== 0 && result.code !== 128) {
        throw new Error(`taskkill failed with code ${result.code}: ${result.stderr.trim()}`)
      }
    },
  }
}
