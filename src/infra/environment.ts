/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

/** Windows starts a process only from an executable image, a `.cmd`, or a `.bat`, never from an extensionless file. */
const WINDOWS = process.platform === 'win32'
const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  // Windows paths are case-insensitive and may carry a trailing separator, such as a PATH entry has.
  const same = (left: string, right: string): boolean => WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right
  return same(real(a), real(b))
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  // A Windows shim carries the marker as a `rem` comment, its second line, because a bare `#` line is not a command.
  const head = (await readFile(file, 'utf8')).split('\n', 2).map(line => line.trim().replace(/^@?rem\s+/i, ''))
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.includes(marker))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Batch lines that rebuild PATH without the directory holding the running shim, so a wrapper script that runs
 * `gh` or `lark-cli` by name reaches the real binary instead of the shim again.
 */
const BATCH_STRIP_PATH = [
  'setlocal EnableExtensions DisableDelayedExpansion',
  'set "DSH_SHIM_DIR=%~dp0"',
  'if "%DSH_SHIM_DIR:~-1%"=="\\" set "DSH_SHIM_DIR=%DSH_SHIM_DIR:~0,-1%"',
  'set "DSH_SHIM_PATH="',
  'for %%D in ("%PATH:;=" "%") do call :dsh_keep "%%~D"',
  'set "PATH=%DSH_SHIM_PATH%"',
]
/** The `:dsh_keep` subroutine of {@link BATCH_STRIP_PATH}, which appends one PATH entry unless it is the shim directory. */
const BATCH_KEEP_ENTRY = [
  ':dsh_keep',
  'set "DSH_SHIM_ENTRY=%~1"',
  'if not defined DSH_SHIM_ENTRY exit /b 0',
  'if "%DSH_SHIM_ENTRY:~-1%"=="\\" set "DSH_SHIM_ENTRY=%DSH_SHIM_ENTRY:~0,-1%"',
  'if /I "%DSH_SHIM_ENTRY%"=="%DSH_SHIM_DIR%" exit /b 0',
  'if defined DSH_SHIM_PATH (set "DSH_SHIM_PATH=%DSH_SHIM_PATH%;%DSH_SHIM_ENTRY%") else set "DSH_SHIM_PATH=%DSH_SHIM_ENTRY%"',
  'exit /b 0',
]
/** Escapes a path for a batch line: `%` would otherwise expand, and the path is quoted for spaces. */
const batchPath = (value: string): string => `"${value.replaceAll('%', '%%')}"`
/** Escapes text for `echo(`, whose argument cmd reads literally except for its metacharacters. */
const batchText = (value: string): string => value.replace(/[%^&|<>()]/g, char => char === '%' ? '%%' : `^${char}`)
/** Batch lines that run `program` with the shim's own arguments and end with its exit status. */
function batchRun(program: string): string {
  // A batch target must be called so control returns here; direct invocation would end this shim instead.
  const invoke = /\.(?:cmd|bat)$/i.test(program) ? `call ${batchPath(program)} %*` : `${batchPath(program)} %*`
  return [...BATCH_STRIP_PATH, invoke, 'exit /b %ERRORLEVEL%', ...BATCH_KEEP_ENTRY].join('\n')
}
/** Batch lines that report `message` on stderr and fail. */
function batchFail(message: string): string {
  return ['setlocal EnableExtensions DisableDelayedExpansion', `1>&2 echo(${batchText(message)}`, 'exit /b 1'].join('\n')
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 * On Windows the shims are `.cmd` files, because CreateProcess ignores an extensionless file: a missing shim would silently let a
 * worker command run as the operator's own account instead.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, body: string): Promise<void> => {
    const file = WINDOWS ? `${name}.cmd` : name
    const temporary = join(dir, `.${file}.${process.pid}.tmp`)
    const text = WINDOWS ? `@echo off\r\n@rem ${MARKER}\r\n${body.replaceAll('\n', '\r\n')}\r\n` : `#!/bin/sh\n${MARKER}\n${body}\n`
    await writeFile(temporary, text, { mode: 0o755 })
    await rename(temporary, join(dir, file))
    kept.add(file)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => WINDOWS ? batchRun(program) : `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => WINDOWS ? batchFail(message) : `echo ${shellQuote(message)} >&2\nexit 1`
  await shim('gh', run(github.cli))
  await shim('lark-cli', feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.'))
  for (const name of new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))) {
    await shim(name, fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** Applies environment overrides and prepends worker shims to `process.env.PATH`, returning a restore callback. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/**
 * Windows starts a process only from an executable image, so a `.cmd` or `.bat` CLI would make CreateProcess fail. It is
 * run through `cmd.exe` instead, as a shell would run it. Node's own argument quoting escapes quotes with a backslash,
 * which cmd.exe does not read as an escape, so the command line travels as an environment variable that cmd expands once:
 * `call` keeps the leading quoted path from being stripped with `/s`.
 */
function spawnSpec(argv: readonly string[], env: Record<string, string> | undefined): { argv: string[]; env: Record<string, string> | undefined } {
  const program = argv[0]
  if (!WINDOWS || program === undefined || !/\.(?:cmd|bat)$/i.test(program)) return { argv: [...argv], env }
  const command = ['call', ...argv.map(argument => `"${argument.replaceAll('"', '""')}"`)].join(' ')
  return { argv: [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', '%DSH_SUPERAGENT_SPAWN%'], env: { ...env, DSH_SUPERAGENT_SPAWN: command } }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const spec = spawnSpec(argv, env)
  const handle = subprocess.spawn({ argv: spec.argv, cwd, graceMs: 2000, signal, ...spec.env ? { env: spec.env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** The path a `--show-origin` entry names: Windows paths come back C-quoted, with their backslashes escaped. */
function originPath(entry: string): string {
  const value = entry.startsWith('file:') ? entry.slice('file:'.length) : entry
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  return value.slice(1, -1).replace(/\\(.)/g, '$1')
}
/** Compares two absolute paths, case-insensitively on Windows, where either separator may spell the same file. */
const samePath = (a: string, b: string): boolean => a === b || WINDOWS && resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)])).catch(() => '')).split('\0')
  // git spells the origin of the isolated gitconfig with the path it was given, and Windows paths come back quoted.
  const same = helpers.length === 3 && helpers[0]!.startsWith('file:') && samePath(originPath(helpers[0]!), workerGitConfig(stateDir))
    && helpers[1] === credentialHelper(github.cli) && helpers[2] === ''
  if (!same) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
