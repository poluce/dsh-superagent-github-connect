/**
 * Tests for `scripts/dsh-superagent`.
 *
 * The service logic runs in-process against injected effects: a fake process list, a fake management API, a fake
 * launcher and a fake stop. That covers process discovery, startup, stop, restart, logging and the control lock on
 * every platform without `ps`, `tmux` or `sleep` binaries. The platform adapters are tested by injecting their command
 * runner, so the POSIX `ps`/`tmux` command lines and the Windows CIM/taskkill calls are checked on any OS.
 *
 * A few tests spawn the real CLI for argument parsing, JSON output, exit codes and lock contention, and one Windows-only
 * test starts a fake `dsh` so the real CIM discovery, hidden launcher and forced stop run end to end.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = import.meta.dirname
const repository = join(here, '..')
const scripts = join(repository, 'scripts')
const entry = join(scripts, 'dsh-superagent')
const isWindows = process.platform === 'win32'

interface Entry { pid: number; name: string; argv: string[] }
interface ApiState { health: Record<string, string | null>; errors: Record<string, string>; setup: unknown; feishu: unknown }
interface Deps {
  platform: string
  root: string
  listProcesses(): Promise<Entry[]>
  processExists(pid: number): Promise<Entry | null>
  fetchState(url: string): Promise<ApiState | null>
  launchService(options: Record<string, any>): Promise<{ pid: number | null } | null>
  stopProcess(pid: number): Promise<void>
  which(command: string): Promise<string | null>
  sessionExists?(session: string): Promise<boolean>
  stdout(text: string): void
  stderr(text: string): void
  sleep(ms: number): Promise<void>
  now(): number
  stopNote?: string
}
interface Harness { deps: Deps; stdout(): string; stderr(): string }

const READY: ApiState = { health: { runtime: 'ready' }, errors: {}, setup: null, feishu: null }
let root: string
let sleepers: ChildProcess[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
})
afterEach(() => {
  for (const child of sleepers) {
    try {
      child.kill()
    } catch {
      // A helper that already exited needs no kill.
    }
  }
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})

const modules = new Map<string, Promise<any>>()
/** Load one implementation module once; `scripts/` is plain ESM outside the TypeScript build, so it has no declaration. */
function load(name: string): Promise<any> {
  let module = modules.get(name)
  if (!module) {
    module = import(pathToFileURL(join(scripts, 'service', name + '.mjs')).href)
    modules.set(name, module)
  }
  return module
}

const profileDir = (profile = 'superagent') => join(root, '.artifacts', 'control', 'profiles', profile)
const read = (file: string) => readFileSync(file, 'utf8')
const serviceEntry = (pid: number, profile = 'superagent', name = 'node'): Entry =>
  ({ pid, name, argv: ['node', '/opt/my tools/dsh', '--profile', profile, '--no-open'] })

/** A dependency set whose effects are fakes; `stdout` and `stderr` collect printed lines. */
function createHarness(overrides: Partial<Deps> = {}): Harness {
  const output: string[] = []
  const messages: string[] = []
  const deps: Deps = {
    platform: 'linux',
    root,
    listProcesses: async () => [],
    processExists: async () => null,
    fetchState: async () => null,
    launchService: async () => ({ pid: null }),
    stopProcess: async () => {},
    which: async () => '/usr/bin/dsh',
    sessionExists: async () => false,
    stdout: text => { output.push(text) },
    stderr: text => { messages.push(text) },
    sleep: async () => {},
    now: () => Date.now(),
    ...overrides,
  }
  return { deps, stdout: () => output.join('\n'), stderr: () => messages.join('\n') }
}

/** Run one CLI action against a harness and return its exit code. */
async function runService(harness: Harness, ...argv: string[]): Promise<number> {
  const { runCli } = await load('service')
  return await runCli(argv, {}, harness.deps)
}

/** Fake processes whose liveness the fake scan and the fake `ps -p` agree on. */
function liveProcesses(initial: Entry[]) {
  const entries = new Map(initial.map(item => [item.pid, item]))
  return {
    listProcesses: async () => [...entries.values()],
    processExists: async (pid: number) => entries.get(pid) ?? null,
    has: (pid: number) => entries.has(pid),
    add: (item: Entry) => { entries.set(item.pid, item) },
    remove: (pid: number) => { entries.delete(pid) },
  }
}

/** A fake management API that answers each call from `states` in order, repeating the last answer. */
function answering(...states: (ApiState | null)[]) {
  let index = 0
  return async () => {
    const state = states[Math.min(index, Math.max(0, states.length - 1))] ?? null
    index += 1
    return state
  }
}

/** Write the checkout's script and modules plus a package that marks them as ESM, and return the copied entry. */
function tempCheckout(): string {
  const target = join(root, 'checkout')
  mkdirSync(join(target, 'scripts', 'service'), { recursive: true })
  copyFileSync(entry, join(target, 'scripts', 'dsh-superagent'))
  for (const name of readdirSync(join(scripts, 'service'))) {
    copyFileSync(join(scripts, 'service', name), join(target, 'scripts', 'service', name))
  }
  writeFileSync(join(target, 'package.json'), '{"type":"module"}')
  return join(target, 'scripts', 'dsh-superagent')
}

/** Run the copied CLI as a child process, with the profile and URL environment cleared unless a test sets them. */
function execute(program: string, args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [program, ...args], {
      env: { ...process.env, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '', ...env },
      timeout: 120_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
    })
  })
}

describe('command line', () => {
  it('parses actions and options, falling back to the environment and its defaults', async () => {
    const { parseArgs, UsageError } = await load('service')
    expect(parseArgs(['start', '--profile', 'one', '--url', 'http://127.0.0.1:9', '--timeout', '5',
      '--stop-timeout=7', '--respect-stop'], {})).toMatchObject({
      action: 'start', profile: 'one', url: 'http://127.0.0.1:9', timeout: 5, stopTimeout: 7, respectStop: true,
    })
    expect(parseArgs(['status'], { DSH_SUPERAGENT_PROFILE: 'two', DSH_SUPERAGENT_URL: 'http://127.0.0.1:8' }))
      .toMatchObject({ action: 'status', profile: 'two', url: 'http://127.0.0.1:8', timeout: 60, stopTimeout: 300 })
    // An empty environment variable falls back to the default, as `or` did in the Python script.
    expect(parseArgs(['status'], { DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' }))
      .toMatchObject({ profile: 'superagent', url: 'http://127.0.0.1:3082' })
    expect(parseArgs(['--help'], {}).help).toBe(true)
    expect(() => parseArgs([], {})).toThrow(UsageError)
    expect(() => parseArgs(['start', '--timeout', 'soon'], {})).toThrow(UsageError)
  })

  it('rejects a usage mistake with exit code 2 and the usage text', async () => {
    const harness = createHarness()
    expect(await runService(harness, 'bogus')).toBe(2)
    expect(harness.stderr()).toContain('usage: dsh-superagent')
    expect(harness.stderr()).toContain('invalid choice')
    const missing = createHarness()
    expect(await runService(missing)).toBe(2)
    expect(missing.stderr()).toContain('the following arguments are required: action')
    const profile = createHarness()
    expect(await runService(profile, 'status', '--profile', 'bad/name')).toBe(2)
    expect(profile.stderr()).toContain('--profile must be a DSH profile name')
    const timeout = createHarness()
    expect(await runService(timeout, 'status', '--timeout', '0')).toBe(2)
    expect(timeout.stderr()).toContain('must be positive')
    const help = createHarness()
    expect(await runService(help, '--help')).toBe(0)
    expect(help.stdout()).toContain('actions:')
    expect(help.stderr()).toBe('')
  })
})

describe('process discovery', () => {
  it('matches only the main service command line of the profile', async () => {
    const { serves } = await load('processes')
    expect(serves(['node', '/opt/dsh', '--profile', 'superagent', '--no-open'], 'superagent')).toBe(true)
    expect(serves(['node', '/opt/dsh', '--profile=superagent'], 'superagent')).toBe(true)
    expect(serves(['node', '/opt/dsh', '--profile', 'other'], 'superagent')).toBe(false)
    expect(serves(['node', '/opt/dsh', '--profile'], 'superagent')).toBe(false)
    // A plugin command of the same profile is a separate process, not the service.
    expect(serves(['node', '/opt/dsh', 'plugin', '--profile', 'superagent', 'add', 'link:/x'], 'superagent')).toBe(false)
  })

  it('parses ps lines and Windows command lines with quoted paths', async () => {
    const { parsePsOutput, parseCimOutput, splitCommandLine } = await load('processes')
    expect(parsePsOutput('  100 node /opt/my tools/dsh --profile superagent --no-open\n'
      + '101 python3 /usr/bin/thing\nnot a line\n')).toEqual([
      { pid: 100, name: 'node', argv: ['/opt/my', 'tools/dsh', '--profile', 'superagent', '--no-open'] },
      { pid: 101, name: 'python3', argv: ['/usr/bin/thing'] },
    ])
    const line = '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\node_modules\\dsh\\bin\\dsh.js"'
      + ' --profile superagent --no-open'
    expect(splitCommandLine(line)).toEqual([
      'C:\\Program Files\\nodejs\\node.exe', 'C:\\repo\\node_modules\\dsh\\bin\\dsh.js',
      '--profile', 'superagent', '--no-open',
    ])
    expect(parseCimOutput(JSON.stringify({ ProcessId: 42, Name: 'node.exe', CommandLine: line })))
      .toEqual([{ pid: 42, name: 'node.exe', argv: splitCommandLine(line) }])
    // A command line hidden from this user cannot be identified and is skipped.
    expect(parseCimOutput(JSON.stringify([{ ProcessId: 1, Name: 'node.exe', CommandLine: null }]))).toEqual([])
    expect(parseCimOutput('  \n')).toEqual([])
  })

  it('keeps the controller process out of the service scan', async () => {
    const { findServiceEntries } = await load('processes')
    const controller = { pid: 999, name: 'node', argv: ['node', 'C:\\repo\\scripts\\dsh-superagent', 'status', '--profile', 'p'] }
    const service = { pid: 500, name: 'node', argv: ['node', 'C:\\repo\\node_modules\\dsh\\bin\\dsh.js', '--profile', 'p'] }
    expect(findServiceEntries([controller, service], 'p', { selfPid: 1, selfNames: new Set(['dsh-superagent']) }))
      .toEqual([service])
    expect(findServiceEntries([{ ...service, pid: 7 }], 'p', { selfPid: 7, selfNames: new Set() })).toEqual([])
  })
})

describe('management API state', () => {
  it('normalizes an answer whose keys are missing or not objects', async () => {
    const { normalizeState } = await load('state')
    expect(normalizeState({
      health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' }, odd: 'plain text' },
      setup: { problem: { detail: 'unset' }, feishuProblem: null },
    })).toEqual({
      health: { runtime: 'ready', github: 'error', odd: null },
      errors: { github: 'bad token' },
      setup: { detail: 'unset' },
      feishu: null,
    })
    expect(normalizeState({})).toEqual({ health: {}, errors: {}, setup: null, feishu: null })
    expect(normalizeState({ health: { runtime: { state: 'ready' } } }))
      .toEqual({ health: { runtime: 'ready' }, errors: {}, setup: null, feishu: null })
  })

  it('fetches the management endpoint and treats a non-answer as null', async () => {
    const { fetchState } = await load('state')
    let responseStatus = 200
    let requestUrl = ''
    let requestHeader: string | undefined
    const server = createServer((request, response) => {
      requestUrl = request.url ?? ''
      requestHeader = request.headers['x-orchestrator-request'] as string | undefined
      response.writeHead(responseStatus, { 'content-type': 'application/json' })
        .end(JSON.stringify({ health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect(await fetchState(url + '/')).toEqual({ health: { runtime: 'ready' }, errors: {}, setup: null, feishu: null })
      expect(requestUrl).toBe('/orchestrator/api/state')
      expect(requestHeader).toBe('1')
      responseStatus = 503
      expect(await fetchState(url)).toBeNull()
    } finally {
      server.close()
    }
    expect(await fetchState('http://127.0.0.1:9')).toBeNull()
  })

  it('computes the exit code from PIDs and state', async () => {
    const { outcome } = await load('state')
    expect(outcome([], null)).toBe(1)
    expect(outcome([1, 2], READY)).toBe(1)
    expect(outcome([1], null)).toBe(1)
    expect(outcome([1], { health: { runtime: 'starting' }, errors: {}, setup: null, feishu: null })).toBe(1)
    expect(outcome([1], READY)).toBe(0)
    // The runtime's own transient error does not count as a component error.
    expect(outcome([1], { health: { runtime: 'ready' }, errors: { runtime: 'restarting' }, setup: null, feishu: null })).toBe(0)
    expect(outcome([1], { health: { runtime: 'ready' }, errors: { github: 'bad' }, setup: null, feishu: null })).toBe(2)
    expect(outcome([1], { health: { runtime: 'paused' }, errors: {}, setup: { detail: 'unset' }, feishu: null })).toBe(3)
  })
})

describe('status', () => {
  it('prints the JSON report in the original shape and exits 0 for a healthy service', async () => {
    const live = liveProcesses([serviceEntry(100)])
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: async () => READY,
    })
    expect(await runService(harness, 'status', '--url', 'http://127.0.0.1:9')).toBe(0)
    expect(harness.stdout()).toBe(JSON.stringify({
      pids: [100],
      cwd: root,
      url: 'http://127.0.0.1:9',
      manually_stopped: false,
      health: { runtime: 'ready' },
      errors: {},
      setup: null,
      feishu: null,
    }, null, 2))
    expect(harness.stderr()).toBe('')
  })

  it('reports errors, setup and an unreachable service with the matching exit code', async () => {
    const live = liveProcesses([serviceEntry(100)])
    async function statusOf(state: ApiState | null) {
      const harness = createHarness({
        listProcesses: live.listProcesses,
        processExists: live.processExists,
        fetchState: async () => state,
      })
      const code = await runService(harness, 'status')
      return { code, report: JSON.parse(harness.stdout()) as Record<string, any> }
    }
    const part = await statusOf({
      health: { runtime: 'ready', github: 'error' }, errors: { github: 'bad token' }, setup: null, feishu: null,
    })
    expect(part.code).toBe(2)
    expect(part.report.errors).toEqual({ github: 'bad token' })
    const setup = await statusOf({
      health: { runtime: 'paused' }, errors: {}, setup: { code: 'repositoryUnset', detail: 'unset' }, feishu: null,
    })
    expect(setup.code).toBe(3)
    expect(setup.report.setup).toEqual({ code: 'repositoryUnset', detail: 'unset' })
    const unreachable = await statusOf(null)
    expect(unreachable.code).toBe(1)
    expect(unreachable.report).toMatchObject({ health: null, errors: null, setup: null, feishu: null })
    // A stopped service reports null state without asking the API at all.
    live.remove(100)
    let asked = 0
    const stopped = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: async () => { asked += 1; return READY },
    })
    expect(await runService(stopped, 'status')).toBe(1)
    expect(asked).toBe(0)
    expect(JSON.parse(stopped.stdout())).toMatchObject({ pids: [], health: null })
  })
})

describe('start', () => {
  it('refuses a duplicate instance before launching another', async () => {
    const live = liveProcesses([serviceEntry(100), serviceEntry(101)])
    let launches = 0
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      launchService: async () => { launches += 1; return { pid: null } },
    })
    expect(await runService(harness, 'start')).toBe(1)
    expect(harness.stderr()).toContain('Multiple dsh-superagent processes found; refusing to start another.')
    expect(launches).toBe(0)
  })

  it('refuses to start when an orchestrator answers at the URL already', async () => {
    const live = liveProcesses([])
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: async () => READY,
      launchService: async () => { live.add(serviceEntry(200)); return { pid: 200 } },
    })
    expect(await runService(harness, 'start')).toBe(1)
    expect(harness.stderr()).toContain('An existing orchestrator answers at this URL; refusing duplicate startup.')
    expect(live.has(200)).toBe(false)
    expect(harness.stdout()).toBe('')
  })

  it('requires dsh and tmux on POSIX, and dsh alone on Windows', async () => {
    const posix = createHarness({ which: async command => command === 'dsh' ? '/usr/bin/dsh' : null })
    expect(await runService(posix, 'start')).toBe(1)
    expect(posix.stderr()).toContain('Both dsh and tmux must be on PATH.')
    const windows = createHarness({ platform: 'win32', which: async () => null })
    expect(await runService(windows, 'start')).toBe(1)
    expect(windows.stderr()).toContain('dsh must be on PATH.')
  })

  it('starts the service, records its PID, writes the log and clears the stop marker', async () => {
    const live = liveProcesses([])
    let launched: Record<string, any> | undefined
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: answering(null, READY),
      launchService: async options => { launched = options; live.add(serviceEntry(500)); return { pid: 500 } },
    })
    mkdirSync(profileDir(), { recursive: true })
    writeFileSync(join(profileDir(), 'manually-stopped'), 'old\n')
    expect(await runService(harness, 'start', '--timeout', '5')).toBe(0)
    expect(launched?.profile).toBe('superagent')
    expect(launched?.sessionName).toBe('dsh-superagent')
    expect(launched?.dshPath).toBe('/usr/bin/dsh')
    expect(read(join(profileDir(), 'service.pid'))).toBe('500\n')
    expect(existsSync(join(profileDir(), 'manually-stopped'))).toBe(false)
    const log = readdirSync(join(root, '.artifacts')).find(name => name.endsWith('.log'))
    expect(log).toBeDefined()
    expect(harness.stdout()).toContain('Log: ' + join(root, '.artifacts', log as string))
    expect(harness.stdout()).toContain('"pids": [\n    500\n  ]')
  })

  it('starts the already running service without launching a duplicate', async () => {
    const live = liveProcesses([serviceEntry(300)])
    let launches = 0
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: async () => READY,
      launchService: async () => { launches += 1; return { pid: null } },
    })
    expect(await runService(harness, 'start', '--timeout', '5')).toBe(0)
    expect(launches).toBe(0)
    expect(harness.stdout()).toContain('already running (PID 300); no duplicate started.')
    expect(read(join(profileDir(), 'service.pid'))).toBe('300\n')
  })

  it('reports setup, a missing Feishu check and a component error after startup', async () => {
    async function startWith(state: ApiState) {
      const live = liveProcesses([])
      const harness = createHarness({
        listProcesses: live.listProcesses,
        processExists: live.processExists,
        fetchState: answering(null, state),
        launchService: async () => { live.add(serviceEntry(700)); return { pid: 700 } },
      })
      return { code: await runService(harness, 'start', '--timeout', '5'), stdout: harness.stdout() }
    }
    const setup = await startWith({
      health: { runtime: 'paused' }, errors: {},
      setup: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishu: null,
    })
    expect(setup.code).toBe(3)
    expect(setup.stdout).toContain('waiting for setup: The GitHub Source names no repository.')
    expect(setup.stdout).toContain('Open the URL DSH printed in the log, then the dsh-superagent overview.')
    const feishu = await startWith({
      health: { runtime: 'ready', feishu: 'paused' }, errors: {}, setup: null,
      feishu: { code: 'feishuNoBot', detail: 'No bot' },
    })
    expect(feishu.code).toBe(0)
    expect(feishu.stdout).toContain('runs without Feishu: No bot')
    expect(feishu.stdout).toContain('Fix it on the Feishu card of the Source settings.')
    const part = await startWith({
      health: { runtime: 'ready', github: 'error' }, errors: { github: 'bad token' }, setup: null, feishu: null,
    })
    expect(part.code).toBe(2)
    expect(part.stdout).toContain('github reports an error, which a restart does not fix: bad token')
  })

  it('exits 1 and leaves the process running when the service never answers', async () => {
    const live = liveProcesses([])
    const holder = { time: 0 }
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: async () => null,
      launchService: async () => { live.add(serviceEntry(600)); return { pid: 600 } },
      now: () => holder.time,
      sleep: async (ms: number) => { holder.time += ms },
    })
    expect(await runService(harness, 'start', '--url', 'http://127.0.0.1:9', '--timeout', '3')).toBe(1)
    expect(harness.stderr()).toContain('Startup health check timed out')
    expect(live.has(600)).toBe(true)
    // The last status still prints one JSON report before the error.
    expect(harness.stdout()).toContain('"pids": [')
  })

  it('keeps only the newest logs it wrote for the profile', async () => {
    mkdirSync(join(root, '.artifacts'), { recursive: true })
    for (const profile of ['superagent', 'other']) {
      for (let index = 0; index < 25; index += 1) {
        const log = join(root, '.artifacts',
          `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
        writeFileSync(log, '')
        utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
      }
    }
    writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
    const live = liveProcesses([])
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: answering(null, READY),
      launchService: async () => { live.add(serviceEntry(500)); return { pid: 500 } },
    })
    expect(await runService(harness, 'start', '--timeout', '5')).toBe(0)
    const logs = readdirSync(join(root, '.artifacts'))
    const own = logs.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
    expect(own).toHaveLength(20)
    // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
    expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
    expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
    expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
    expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
  })

  it('starts through tmux on POSIX and records the pane PID', async () => {
    const { createPosixPlatform } = await load('platform-posix')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of ['dsh', 'tmux']) {
      const file = join(bin, name)
      writeFileSync(file, '')
      chmodSync(file, 0o755)
    }
    const calls: { command: string; args: string[] }[] = []
    let alive = false
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (command === 'ps') {
        return { code: 0, stdout: alive ? '  4321 node node /opt/dsh --profile superagent --no-open\n' : '', stderr: '' }
      }
      if (command === 'tmux') {
        if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
        alive = true
        return { code: 0, stdout: '4321\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const adapter = createPosixPlatform({ root, env: { PATH: bin }, run, kill: () => {} })
    const harness = createHarness({
      platform: 'linux',
      ...adapter,
      fetchState: answering(null, READY),
    })
    expect(await runService(harness, 'start', '--timeout', '5')).toBe(0)
    expect(read(join(profileDir(), 'service.pid'))).toBe('4321\n')
    const tmux = calls.filter(call => call.command === 'tmux' && call.args[0] !== 'has-session')
    expect(tmux).toHaveLength(1)
    const args = tmux[0]!.args
    expect(args).toEqual(expect.arrayContaining(['new-session', '-s', 'dsh-superagent', '-d', '-P', '-F',
      '#{pane_pid}', '-n', 'server', '-c', root]))
    const command = args[args.length - 1]!
    expect(command.startsWith('umask 077; exec ')).toBe(true)
    expect(command).toContain('--profile superagent --no-open >> \'')
    expect(command.endsWith('.log\' 2>&1')).toBe(true)
    const lines = harness.stdout().split('\n')
    const report = JSON.parse(lines.slice(lines.findIndex(line => line.startsWith('{'))).join('\n'))
    expect(report.pids).toEqual([4321])
    expect(readdirSync(join(root, '.artifacts')).some(name => name.endsWith('.log'))).toBe(true)
  })
})

describe('stop and restart', () => {
  it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
    const live = liveProcesses([serviceEntry(100), serviceEntry(101)])
    const harness = createHarness({ listProcesses: live.listProcesses, processExists: live.processExists })
    expect(await runService(harness, 'stop')).toBe(1)
    expect(harness.stderr()).toContain('Multiple dsh-superagent processes found; refusing to choose one.')
    expect(existsSync(join(profileDir(), 'manually-stopped'))).toBe(false)
  })

  it('writes the stop marker before signalling and waits only for the processes it stopped', async () => {
    const live = liveProcesses([serviceEntry(200)])
    const signalled: number[] = []
    let markerBeforeSignal = false
    const harness = createHarness({
      listProcesses: async () => {
        const entries = await live.listProcesses()
        // Another instance shows up once the stopped one ended; the stop must not wait for it.
        if (signalled.length) entries.push(serviceEntry(201))
        return entries
      },
      processExists: live.processExists,
      stopProcess: async pid => {
        signalled.push(pid)
        markerBeforeSignal = existsSync(join(profileDir(), 'manually-stopped'))
        live.remove(pid)
      },
    })
    mkdirSync(profileDir(), { recursive: true })
    writeFileSync(join(profileDir(), 'service.pid'), '200\n')
    expect(await runService(harness, 'stop')).toBe(0)
    expect(signalled).toEqual([200])
    expect(markerBeforeSignal).toBe(true)
    expect(existsSync(join(profileDir(), 'manually-stopped'))).toBe(true)
    expect(existsSync(join(profileDir(), 'service.pid'))).toBe(false)
    expect(harness.stdout()).toContain('dsh-superagent stopped. Automatic recovery is paused until start/restart.')
  })

  it('keeps a stop that timed out and exits 1', async () => {
    const live = liveProcesses([serviceEntry(300)])
    const holder = { time: 0 }
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      now: () => holder.time,
      sleep: async (ms: number) => { holder.time += ms },
    })
    expect(await runService(harness, 'stop', '--stop-timeout', '1')).toBe(1)
    expect(harness.stderr()).toContain('Graceful stop timed out; no forced kill was sent. Check status.')
    expect(existsSync(join(profileDir(), 'manually-stopped'))).toBe(true)
  })

  it('does not signal a process that took the recorded service PID', async () => {
    const live = liveProcesses([{ pid: 400, name: 'sleep', argv: ['sleep', '60'] }])
    const signalled: number[] = []
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      stopProcess: async pid => { signalled.push(pid) },
    })
    mkdirSync(profileDir(), { recursive: true })
    writeFileSync(join(profileDir(), 'service.pid'), '400\n')
    expect(await runService(harness, 'stop')).toBe(0)
    expect(signalled).toEqual([])
    expect(live.has(400)).toBe(true)
    expect(existsSync(join(profileDir(), 'service.pid'))).toBe(false)
  })

  it('restarts the stopped service without pausing recovery', async () => {
    const live = liveProcesses([serviceEntry(500)])
    let launches = 0
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      fetchState: answering(null, READY),
      stopProcess: async pid => { live.remove(pid) },
      launchService: async () => { launches += 1; live.add(serviceEntry(501)); return { pid: 501 } },
    })
    expect(await runService(harness, 'restart', '--timeout', '5')).toBe(0)
    expect(launches).toBe(1)
    expect(harness.stdout()).toContain('dsh-superagent stopped.')
    expect(harness.stdout()).not.toContain('Automatic recovery is paused')
    expect(existsSync(join(profileDir(), 'manually-stopped'))).toBe(false)
    expect(read(join(profileDir(), 'service.pid'))).toBe('501\n')
  })

  it('a restart whose graceful stop timed out does not keep recovery off', async () => {
    const live = liveProcesses([serviceEntry(600)])
    const holder = { time: 0 }
    const harness = createHarness({
      listProcesses: live.listProcesses,
      processExists: live.processExists,
      now: () => holder.time,
      sleep: async (ms: number) => { holder.time += ms },
    })
    expect(await runService(harness, 'restart', '--stop-timeout', '1')).toBe(1)
    expect(harness.stderr()).toContain('Graceful stop timed out')
    expect(existsSync(join(profileDir(), 'manually-stopped'))).toBe(false)
  })

  it('skips automatic recovery after an intentional stop', async () => {
    mkdirSync(profileDir(), { recursive: true })
    writeFileSync(join(profileDir(), 'manually-stopped'), '2026-01-01T00:00:00+0000\n')
    const harness = createHarness()
    expect(await runService(harness, '--respect-stop', 'start')).toBe(0)
    expect(harness.stdout()).toContain('Intentional stop is active; automatic recovery skipped.')
    expect(await runService(harness, '--respect-stop', 'restart')).toBe(0)
  })
})

describe('control lock', () => {
  it('refuses a control operation while another process holds the lock', async () => {
    mkdirSync(profileDir(), { recursive: true })
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    sleepers.push(holder)
    expect(holder.pid).toBeGreaterThan(0)
    writeFileSync(join(profileDir(), 'operation.lock'),
      JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() }))
    const harness = createHarness({ listProcesses: async () => [] })
    expect(await runService(harness, 'status')).toBe(1)
    expect(harness.stderr()).toContain('Another dsh-superagent control operation is in progress.')
  })

  it('takes over a lock whose owner no longer runs, and one left ownerless long ago', async () => {
    mkdirSync(profileDir(), { recursive: true })
    const lock = join(profileDir(), 'operation.lock')
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }))
    const stale = createHarness({ listProcesses: async () => [], fetchState: async () => null })
    expect(await runService(stale, 'status')).toBe(1)
    expect(stale.stderr()).toBe('')
    expect(existsSync(lock)).toBe(false)
    // An ownerless file, such as one left by the earlier Python implementation, blocks only while it looks fresh.
    writeFileSync(lock, '')
    const fresh = createHarness({ listProcesses: async () => [] })
    expect(await runService(fresh, 'status')).toBe(1)
    expect(fresh.stderr()).toContain('Another dsh-superagent control operation is in progress.')
    rmSync(lock, { force: true })
    writeFileSync(lock, '')
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
    const old = createHarness({ listProcesses: async () => [], fetchState: async () => null })
    expect(await runService(old, 'status')).toBe(1)
    expect(old.stderr()).toBe('')
  })
})

describe('POSIX adapter', () => {
  it('builds ps and tmux commands and records the pane PID', async () => {
    const { createPosixPlatform } = await load('platform-posix')
    const calls: { command: string; args: string[] }[] = []
    const responses: { code: number; stdout: string; stderr: string }[] = []
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args })
      return responses.shift() ?? { code: 0, stdout: '', stderr: '' }
    }
    const adapter = createPosixPlatform({
      root,
      env: { PATH: '' },
      run,
      kill: (pid: number, signal: string) => { calls.push({ command: 'kill', args: [signal, String(pid)] }) },
    })
    responses.push({ code: 0, stdout: '  100 node /opt/dsh --profile superagent --no-open\n', stderr: '' })
    expect(await adapter.listProcesses())
      .toEqual([{ pid: 100, name: 'node', argv: ['/opt/dsh', '--profile', 'superagent', '--no-open'] }])
    expect(calls.pop()).toEqual({ command: 'ps', args: ['-ww', '-ax', '-o', 'pid=,ucomm=,args='] })
    responses.push({ code: 1, stdout: '', stderr: '' })
    expect(await adapter.processExists(100)).toBeNull()
    expect(calls.pop()).toEqual({ command: 'ps', args: ['-ww', '-p', '100', '-o', 'pid=,ucomm=,args='] })
    responses.push({ code: 0, stdout: '  100 node /opt/dsh --profile superagent --no-open\n', stderr: '' })
    expect((await adapter.processExists(100))?.pid).toBe(100)
    responses.push({ code: 1, stdout: '', stderr: '' })
    expect(await adapter.sessionExists('dsh-superagent')).toBe(false)
    expect(calls.pop()).toEqual({ command: 'tmux', args: ['has-session', '-t', '=dsh-superagent'] })
    responses.push({ code: 0, stdout: ' 4321\n', stderr: '' })
    const logPath = join(root, '.artifacts', 'my log.log')
    expect(await adapter.launchService({
      profile: 'superagent', root, logPath, dshPath: '/usr/local/bin/dsh',
      sessionName: 'dsh-superagent', sessionExists: false,
    })).toEqual({ pid: 4321 })
    const launch = calls.pop()!
    expect(launch.command).toBe('tmux')
    expect(launch.args).toEqual(['new-session', '-s', 'dsh-superagent', '-d', '-P', '-F', '#{pane_pid}',
      '-n', 'server', '-c', root,
      `umask 077; exec /usr/local/bin/dsh --profile superagent --no-open >> '${logPath}' 2>&1`])
    responses.push({ code: 0, stdout: ' 4321\n', stderr: '' })
    await adapter.launchService({
      profile: 'superagent', root, logPath, dshPath: '/usr/local/bin/dsh',
      sessionName: 'dsh-superagent', sessionExists: true,
    })
    expect(calls.pop()!.args.slice(0, 3)).toEqual(['new-window', '-t', '=dsh-superagent:'])
    await adapter.stopProcess(100)
    expect(calls.pop()).toEqual({ command: 'kill', args: ['SIGINT', '100'] })
  })

  it('resolves commands on PATH and quotes a shell command line', async () => {
    const { createPosixPlatform, shellJoin } = await load('platform-posix')
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const dsh = join(bin, 'dsh')
    writeFileSync(dsh, '#!/bin/sh\n')
    chmodSync(dsh, 0o755)
    const adapter = createPosixPlatform({ root, env: { PATH: bin }, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    expect(await adapter.which('dsh')).toBe(dsh)
    expect(await adapter.which('tmux')).toBeNull()
    expect(shellJoin(['/usr/bin/dsh', '--profile', 'p', '--no-open']))
      .toBe('/usr/bin/dsh --profile p --no-open')
    expect(shellJoin(['/tmp/my tools/dsh', '--profile', "it's", '--no-open']))
      .toBe(`'/tmp/my tools/dsh' --profile 'it'"'"'s' --no-open`)
  })
})

describe('Windows adapter', () => {
  it('parses CIM output for one process and for many', async () => {
    const { parseCimOutput } = await load('processes')
    const line = '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\node_modules\\dsh\\bin\\dsh.js"'
      + ' --profile superagent --no-open'
    expect(parseCimOutput(JSON.stringify({ ProcessId: 42, Name: 'node.exe', CommandLine: line })))
      .toEqual([{ pid: 42, name: 'node.exe', argv: ['C:\\Program Files\\nodejs\\node.exe',
        'C:\\repo\\node_modules\\dsh\\bin\\dsh.js', '--profile', 'superagent', '--no-open'] }])
    expect(parseCimOutput(JSON.stringify([{ ProcessId: 1, Name: 'node.exe', CommandLine: line },
      { ProcessId: 2, Name: 'node.exe', CommandLine: null }]))).toHaveLength(1)
    expect(parseCimOutput('')).toEqual([])
  })

  it('resolves dsh through where and stops through taskkill, tolerating an ended process', async () => {
    const { createWindowsPlatform } = await load('platform-win32')
    const calls: { command: string; args: string[] }[] = []
    const responses: { code: number; stdout: string; stderr: string }[] = []
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args })
      return responses.shift() ?? { code: 0, stdout: '', stderr: '' }
    }
    const adapter = createWindowsPlatform({
      root, env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      run, powershell: 'powershell.exe',
    })
    responses.push({ code: 0, stdout: 'C:\\bin\\dsh.cmd\r\nC:\\bin\\dsh\r\n', stderr: '' })
    expect(await adapter.which('dsh')).toBe('C:\\bin\\dsh.cmd')
    expect(calls.pop()).toEqual({ command: 'where.exe', args: ['dsh'] })
    responses.push({ code: 0, stdout: '', stderr: '' })
    await adapter.stopProcess(321)
    const stop = calls.pop()!
    expect(stop.command.endsWith('taskkill.exe')).toBe(true)
    expect(stop.args).toEqual(['/PID', '321', '/T', '/F'])
    expect(adapter.stopNote).toContain('forced termination')
    // A stop that races with an exit reports 128, which counts as stopped rather than as a failure.
    responses.push({ code: 128, stdout: '', stderr: '' })
    await expect(adapter.stopProcess(322)).resolves.toBeUndefined()
    responses.push({ code: 5, stdout: '', stderr: 'denied' })
    await expect(adapter.stopProcess(323)).rejects.toThrow('taskkill failed with code 5')
  })

  it('launches through a hidden cmd launcher and records the node process it starts', async () => {
    const { createWindowsPlatform } = await load('platform-win32')
    const calls: { command: string; args: string[] }[] = []
    const spawns: { command: string; args: string[]; options: Record<string, any> }[] = []
    const cim = JSON.stringify([{
      ProcessId: 777,
      Name: 'node.exe',
      CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\node_modules\\dsh\\bin\\dsh.js"'
        + ' --profile superagent --no-open',
    }])
    const run = async (command: string, args: string[]) => {
      calls.push({ command, args })
      return { code: 0, stdout: command === 'powershell.exe' ? cim : '', stderr: '' }
    }
    const adapter = createWindowsPlatform({
      root,
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe', SystemRoot: 'C:\\Windows' },
      run,
      powershell: 'powershell.exe',
      sleep: async () => {},
      spawnProcess: (command: string, args: string[], options: Record<string, any>) => {
        spawns.push({ command, args, options })
        return { pid: 4242, unref() {} }
      },
    })
    const controlDir = profileDir()
    mkdirSync(controlDir, { recursive: true })
    const result = await adapter.launchService({
      profile: 'superagent', root, controlDir, logPath: join(root, '.artifacts', 'my log.log'),
    })
    expect(result).toEqual({ pid: 777 })
    const launcher = read(join(controlDir, 'launch.cmd'))
    expect(launcher).toContain(`cd /d "${root}"`)
    expect(launcher).toContain('call dsh --profile superagent --no-open >> "')
    expect(launcher).toContain('2>&1')
    expect(spawns).toHaveLength(1)
    const spawned = spawns[0]!
    expect(spawned.command).toBe('C:\\Windows\\system32\\cmd.exe')
    expect(spawned.args).toEqual(['/d', '/c', 'call', join(controlDir, 'launch.cmd')])
    expect(spawned.options).toMatchObject({ cwd: root, detached: true, stdio: 'ignore', windowsHide: true })
    expect(calls.some(call => call.command === 'powershell.exe'
      && call.args.some(argument => argument.includes('Win32_Process')))).toBe(true)
  })
})

describe('CLI', () => {
  it('prints one JSON report and exits 1 for a stopped service', async () => {
    const program = tempCheckout()
    const result = await execute(program, ['status', '--profile', 'test-cli-one', '--url', 'http://127.0.0.1:9'])
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      pids: [],
      cwd: realpathSync(join(root, 'checkout')),
      url: 'http://127.0.0.1:9',
      manually_stopped: false,
      health: null,
      errors: null,
      setup: null,
      feishu: null,
    })
    expect(result.stdout.startsWith('{\n  "pids": []')).toBe(true)
  }, 60_000)

  it('reads the profile and URL from the environment and falls back to defaults', async () => {
    const program = tempCheckout()
    const fromEnvironment = await execute(program, ['status'],
      { DSH_SUPERAGENT_PROFILE: 'test-cli-env', DSH_SUPERAGENT_URL: 'http://127.0.0.1:9' })
    const report = JSON.parse(fromEnvironment.stdout)
    expect(report.url).toBe('http://127.0.0.1:9')
    expect(existsSync(join(root, 'checkout', '.artifacts', 'control', 'profiles', 'test-cli-env'))).toBe(true)
    const defaults = await execute(program, ['status', '--profile', 'test-cli-default'])
    expect(JSON.parse(defaults.stdout).url).toBe('http://127.0.0.1:3082')
    // No service runs, so the default URL is never asked and no network is touched.
    expect(defaults.code).toBe(1)
  }, 60_000)

  it('exits 2 for a usage mistake and 0 for help', async () => {
    const program = tempCheckout()
    const missing = await execute(program, [])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('the following arguments are required: action')
    const invalid = await execute(program, ['bogus'])
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain('invalid choice')
    const help = await execute(program, ['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('usage: dsh-superagent')
    expect(help.stderr).toBe('')
  }, 60_000)

  it('keeps a stop per profile and skips automatic recovery for start and restart', async () => {
    const program = tempCheckout()
    const stopped = await execute(program, ['stop', '--profile', 'test-cli-stop'])
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain('dsh-superagent stopped. Automatic recovery is paused until start/restart.')
    expect(existsSync(join(root, 'checkout', '.artifacts', 'control', 'profiles', 'test-cli-stop', 'manually-stopped')))
      .toBe(true)
    const status = await execute(program, ['status', '--profile', 'test-cli-stop', '--url', 'http://127.0.0.1:9'])
    expect(JSON.parse(status.stdout)).toMatchObject({ manually_stopped: true })
    for (const action of ['start', 'restart']) {
      const skipped = await execute(program, ['--respect-stop', action, '--profile', 'test-cli-stop'])
      expect(skipped.code).toBe(0)
      expect(skipped.stdout).toContain('Intentional stop is active; automatic recovery skipped.')
    }
  }, 60_000)

  it('refuses a control operation while another holds the profile lock', async () => {
    const program = tempCheckout()
    const directory = join(root, 'checkout', '.artifacts', 'control', 'profiles', 'test-cli-lock')
    mkdirSync(directory, { recursive: true })
    const { acquireLock } = await load('lock')
    const release = acquireLock(join(directory, 'operation.lock'))
    try {
      // The lock records this test's PID, which is alive, so the child must refuse with the lock message.
      const result = await execute(program, ['status', '--profile', 'test-cli-lock'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Another dsh-superagent control operation is in progress.')
    } finally {
      release()
    }
  }, 60_000)
})

describe.skipIf(!isWindows)('Windows service lifecycle', () => {
  it('starts a fake dsh in a hidden process, records its PID and force-stops it', async () => {
    const program = tempCheckout()
    const profile = 'test-win-lifecycle'
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    const fake = join(root, 'fake-service.mjs')
    writeFileSync(fake, 'setInterval(() => {}, 60000)\n')
    writeFileSync(join(bin, 'dsh.cmd'), `@echo off\r\nnode "${fake}" %*\r\n`)
    const env = { PATH: `${bin};${process.env.PATH ?? ''}` }
    let pid = 0
    try {
      const start = await execute(program, ['start', '--profile', profile, '--url', 'http://127.0.0.1:9',
        '--timeout', '2'], env)
      expect(start.code).toBe(1)
      expect(start.stderr).toContain('Startup health check timed out')
      const pidFile = join(root, 'checkout', '.artifacts', 'control', 'profiles', profile, 'service.pid')
      expect(existsSync(pidFile)).toBe(true)
      pid = Number(read(pidFile).trim())
      expect(pid).toBeGreaterThan(0)
      // The node process behind dsh.cmd is found through CIM, and it is alive although the health check failed.
      expect(() => process.kill(pid, 0)).not.toThrow()
      const status = await execute(program, ['status', '--profile', profile, '--url', 'http://127.0.0.1:9'], env)
      expect(JSON.parse(status.stdout).pids).toEqual([pid])
      const stop = await execute(program, ['stop', '--profile', profile, '--stop-timeout', '15'], env)
      expect(stop.code).toBe(0)
      expect(stop.stdout).toContain('dsh-superagent stopped.')
      expect(stop.stdout).toContain('forced termination')
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      // A failed assertion above must not leave the fake service running.
      await execute(program, ['stop', '--profile', profile, '--stop-timeout', '15'], env)
    }
  }, 120_000)
})
