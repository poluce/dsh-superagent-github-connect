/**
 * Manage a local dsh-superagent service (one DSH profile, default `superagent`) without affecting other sessions.
 *
 * `status`, `start`, and `restart` exit 0 while the service runs normally; 1 when it is stopped, duplicated,
 * unreachable, or reporting a runtime error, which `restart` may fix; 2 when it runs while a component such as a
 * Source reports an error; and 3 when it runs and waits for setup. A restart fixes neither 2 nor 3: they need a person.
 *
 * The file system and the management API are the only things shared with the service itself. Process discovery,
 * startup and stop belong to the platform adapter (`platform-posix.mjs`, `platform-win32.mjs`), and every effect is
 * injected here so the same logic runs on Linux, macOS and Windows and can be tested with no external process.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLock } from './lock.mjs'
import { findServiceEntries, isServiceName, serves } from './processes.mjs'
import { outcome, partErrors, runtimeUp } from './state.mjs'

/** The newest log files kept per profile; older ones are removed when the service starts. */
const KEEP_LOGS = 20
const DEFAULT_PROFILE = 'superagent'
const DEFAULT_URL = 'http://127.0.0.1:3082'
const PROFILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const ACTIONS = ['start', 'stop', 'restart', 'status']

export const USAGE = 'usage: dsh-superagent [-h] [--profile PROFILE] [--url URL] [--timeout TIMEOUT]'
  + ' [--stop-timeout STOP_TIMEOUT] [--respect-stop] {start,stop,restart,status}'

export const HELP = [
  USAGE,
  '',
  'Manage a local dsh-superagent service (one DSH profile, default `superagent`).',
  '',
  'actions:',
  '  start                 Start the service and wait for its runtime to become ready',
  '  stop                  Stop the service and pause automatic recovery',
  '  restart               Stop and start the service without pausing recovery',
  '  status                Print one JSON report and exit according to its health',
  '',
  'options:',
  '  -h, --help            Show this help message and exit',
  `  --profile PROFILE     DSH profile that loads dsh-superagent (default: ${DEFAULT_PROFILE};`,
  '                        environment DSH_SUPERAGENT_PROFILE)',
  `  --url URL             Health-check URL (default: ${DEFAULT_URL};`,
  '                        environment DSH_SUPERAGENT_URL)',
  '  --timeout TIMEOUT     Startup timeout in seconds (default: 60)',
  '  --stop-timeout SECS   Graceful shutdown timeout in seconds (default: 300)',
  '  --respect-stop        For monitoring: never start/restart after an intentional stop',
].join('\n')

/** An expected failure of a control operation; the CLI prints its message and exits 1. */
export class ServiceError extends Error {}
/** A command-line mistake; the CLI prints the usage and exits 2. */
export class UsageError extends Error {}

const pad = value => String(Math.trunc(Math.abs(value))).padStart(2, '0')

/** The `YYYYMMDD-HHMMSS` stamp used in log names. */
function logStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** The `YYYY-MM-DDTHH:MM:SS±HHMM` stamp written to the intentionally-stopped marker. */
function markerStamp(date) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Split `--name=value` into its name and inline value; a bare word keeps no inline value. */
function splitOption(argument) {
  if (!argument.startsWith('--')) return [argument, undefined]
  const equals = argument.indexOf('=')
  return equals === -1 ? [argument, undefined] : [argument.slice(0, equals), argument.slice(equals + 1)]
}

function parseNumber(name, value) {
  const number = Number(value)
  if (value === '' || !Number.isFinite(number)) throw new UsageError(`argument ${name}: invalid value: '${value}'`)
  return number
}

/**
 * Parse the command line, falling back to `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL` like the original script.
 *
 * The options mirror the Python `argparse` interface, including `--name=value`, options before the action and the
 * `--help` action that exits 0.
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    help: false,
    action: undefined,
    profile: env.DSH_SUPERAGENT_PROFILE || DEFAULT_PROFILE,
    url: env.DSH_SUPERAGENT_URL || DEFAULT_URL,
    timeout: 60,
    stopTimeout: 300,
    respectStop: false,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-h' || argument === '--help') {
      options.help = true
      continue
    }
    if (argument === '--respect-stop') {
      options.respectStop = true
      continue
    }
    const [name, inline] = splitOption(argument)
    if (name === '--profile' || name === '--url' || name === '--timeout' || name === '--stop-timeout') {
      let value = inline
      if (value === undefined) {
        if (index + 1 >= argv.length) throw new UsageError(`argument ${name}: expected one argument`)
        index += 1
        value = argv[index]
      }
      if (name === '--profile') options.profile = value
      else if (name === '--url') options.url = value
      else if (name === '--timeout') options.timeout = parseNumber(name, value)
      else options.stopTimeout = parseNumber(name, value)
      continue
    }
    if (argument.startsWith('-') && argument !== '-') throw new UsageError(`unrecognized arguments: ${argument}`)
    positional.push(argument)
  }
  if (options.help) return options
  if (positional.length === 0) throw new UsageError('the following arguments are required: action')
  if (positional.length > 1) throw new UsageError(`unrecognized arguments: ${positional.slice(1).join(' ')}`)
  const [action] = positional
  if (!ACTIONS.includes(action)) {
    throw new UsageError(`argument action: invalid choice: '${action}' (choose from 'start', 'stop', 'restart', 'status')`)
  }
  if (!PROFILE_PATTERN.test(options.profile)) throw new UsageError('--profile must be a DSH profile name')
  if (!(options.timeout > 0) || !(options.stopTimeout > 0)) {
    throw new UsageError('--timeout and --stop-timeout must be positive')
  }
  return { ...options, action }
}

/**
 * Build the service logic around injected effects.
 *
 * `deps` provides `root`, `platform`, and the effects `listProcesses`, `processExists`, `fetchState`, `launchService`,
 * `stopProcess`, `which`, `sessionExists` (POSIX only), `stdout`, `stderr`, `sleep` and `now`.
 */
export function createService(deps) {
  const root = deps.root
  const artifacts = join(root, '.artifacts')

  /** The control directory for `profile`, created when missing. */
  function controlDir(profile) {
    const directory = join(artifacts, 'control', 'profiles', profile)
    mkdirSync(directory, { recursive: true })
    return directory
  }

  /** Whether `profile` was intentionally stopped. */
  function stopped(profile) {
    return existsSync(join(controlDir(profile), 'manually-stopped'))
  }

  /** Whether `pid` still runs the service for `profile`; a reused PID running something else does not count. */
  async function running(pid, profile) {
    const entry = await deps.processExists(pid)
    return Boolean(entry && isServiceName(entry.name) && serves(entry.argv, profile))
  }

  /**
   * PIDs of all running DSH service processes for `profile`, including instances started outside this script and the
   * recorded `service.pid` while still running.
   */
  async function processes(profile) {
    const found = findServiceEntries(await deps.listProcesses(), profile).map(entry => entry.pid)
    let recorded
    try {
      const text = readFileSync(join(controlDir(profile), 'service.pid'), 'utf8').trim()
      if (!/^-?\d+$/.test(text)) return found
      recorded = Number(text)
    } catch {
      return found
    }
    if (found.includes(recorded)) return found
    return await running(recorded, profile) ? [...found, recorded] : found
  }

  /** Print one JSON report and compute the exit code from it. */
  async function status(args) {
    const pids = await processes(args.profile)
    const current = pids.length ? await deps.fetchState(args.url) : null
    deps.stdout(JSON.stringify({
      pids,
      cwd: root,
      url: args.url,
      manually_stopped: stopped(args.profile),
      health: current ? current.health : null,
      errors: current ? current.errors : null,
      setup: current ? current.setup : null,
      feishu: current ? current.feishu : null,
    }, null, 2))
    return outcome(pids, current)
  }

  function pruneLogs(profile) {
    const pattern = new RegExp(`^dsh-superagent-${escapeRegExp(profile)}-\\d{8}-\\d{6}-\\d+\\.log$`)
    const logs = readdirSync(artifacts)
      .filter(name => pattern.test(name))
      .map(name => ({ path: join(artifacts, name), mtime: statSync(join(artifacts, name)).mtimeMs }))
      .sort((left, right) => left.mtime - right.mtime)
    for (const log of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(log.path, { force: true })
  }

  /** Stop the service gracefully, recording a manual stop marker when `intentional` is true. */
  async function stop(args, intentional) {
    const pids = await processes(args.profile)
    if (pids.length > 1) throw new ServiceError('Multiple dsh-superagent processes found; refusing to choose one.')
    // Write the stop marker before waiting so monitors respect the intentional stop even if shutdown times out.
    if (intentional) writeFileSync(join(controlDir(args.profile), 'manually-stopped'), markerStamp(new Date()) + '\n')
    for (const pid of pids) await deps.stopProcess(pid)
    const deadline = deps.now() + args.stopTimeout * 1000
    while ((await Promise.all(pids.map(pid => running(pid, args.profile)))).some(Boolean)) {
      if (deps.now() >= deadline) throw new ServiceError('Graceful stop timed out; no forced kill was sent. Check status.')
      await deps.sleep(500)
    }
    rmSync(join(controlDir(args.profile), 'service.pid'), { force: true })
    deps.stdout(intentional
      ? 'dsh-superagent stopped. Automatic recovery is paused until start/restart.'
      : 'dsh-superagent stopped.')
    // The forced termination of the Windows adapter is a semantic change from the POSIX SIGINT that operators must see.
    if (pids.length && deps.stopNote) deps.stdout(deps.stopNote)
  }

  /** Start the service and wait for its runtime, returning the same exit code `status` would. */
  async function start(args) {
    const sessionName = 'dsh-' + args.profile
    const pids = await processes(args.profile)
    if (pids.length > 1) throw new ServiceError('Multiple dsh-superagent processes found; refusing to start another.')
    if (!pids.length) {
      const windows = deps.platform === 'win32'
      const dshPath = await deps.which('dsh')
      // tmux hosts the service on POSIX; Windows runs it in a hidden window instead.
      const tmuxPath = windows ? null : await deps.which('tmux')
      if (!dshPath || (!windows && !tmuxPath)) {
        throw new ServiceError(windows ? 'dsh must be on PATH.' : 'Both dsh and tmux must be on PATH.')
      }
      const exists = windows ? false : await deps.sessionExists(sessionName)
      if (await deps.fetchState(args.url) !== null) {
        throw new ServiceError('An existing orchestrator answers at this URL; refusing duplicate startup.')
      }
      const logPath = join(artifacts, `dsh-superagent-${args.profile}-${logStamp(new Date())}-${process.pid}.log`)
      // Create the log without truncating one a previous start wrote in the same second, as `touch` did.
      writeFileSync(logPath, '', { flag: 'a' })
      pruneLogs(args.profile)
      const launched = await deps.launchService({
        profile: args.profile,
        root,
        controlDir: controlDir(args.profile),
        logPath,
        dshPath,
        tmuxPath,
        sessionName,
        sessionExists: exists,
      })
      if (launched && Number.isInteger(launched.pid)) {
        writeFileSync(join(controlDir(args.profile), 'service.pid'), launched.pid + '\n')
      }
      deps.stdout('Log: ' + logPath)
    } else {
      writeFileSync(join(controlDir(args.profile), 'service.pid'), pids[0] + '\n')
      deps.stdout(`dsh-superagent already running (PID ${pids[0]}); no duplicate started.`)
    }
    rmSync(join(controlDir(args.profile), 'manually-stopped'), { force: true })
    const deadline = deps.now() + args.timeout * 1000
    while (deps.now() < deadline) {
      const current = await deps.fetchState(args.url)
      if ((await processes(args.profile)).length && runtimeUp(current)) {
        const code = await status(args)
        if (current.setup) {
          deps.stdout('dsh-superagent is waiting for setup: ' + String(current.setup?.detail ?? ''))
          deps.stdout('Open the URL DSH printed in the log, then the dsh-superagent overview.')
        }
        if (current.feishu) {
          deps.stdout('dsh-superagent runs without Feishu: ' + String(current.feishu?.detail ?? ''))
          deps.stdout('Fix it on the Feishu card of the Source settings.')
        }
        for (const [name, detail] of Object.entries(partErrors(current))) {
          deps.stdout(`${name} reports an error, which a restart does not fix: ${detail}`)
        }
        return code
      }
      await deps.sleep(1000)
    }
    await status(args)
    throw new ServiceError('Startup health check timed out; inspect the log. Any running process was left intact.')
  }

  /** Hold the profile's control lock and run one action. */
  async function run(args) {
    const release = acquireLock(join(controlDir(args.profile), 'operation.lock'))
    try {
      if (args.respectStop && (args.action === 'start' || args.action === 'restart') && stopped(args.profile)) {
        deps.stdout('Intentional stop is active; automatic recovery skipped.')
        return 0
      }
      if (args.action === 'status') return await status(args)
      // Only a stop keeps automatic recovery off; a restart whose stop timed out leaves it on.
      if (args.action === 'stop' || args.action === 'restart') await stop(args, args.action === 'stop')
      if (args.action === 'start' || args.action === 'restart') return await start(args)
      return 0
    } finally {
      release()
    }
  }

  return { controlDir, stopped, processes, status, stop, start, run }
}

/**
 * Run the CLI and return its exit code.
 *
 * A usage mistake exits 2 like `argparse`; an expected control failure prints its message on stderr and exits 1, which
 * tells a monitor that a restart may fix the service.
 */
export async function runCli(argv, env, deps) {
  let args
  try {
    args = parseArgs(argv, env)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    deps.stderr(USAGE)
    deps.stderr('dsh-superagent: error: ' + error.message)
    return 2
  }
  if (args.help) {
    deps.stdout(HELP)
    return 0
  }
  try {
    return await createService(deps).run(args)
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}
