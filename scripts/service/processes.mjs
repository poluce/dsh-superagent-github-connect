/**
 * Process discovery shared by the platform adapters: POSIX `ps` lines and Windows CIM command lines.
 *
 * Both platforms describe a process with the same `{ pid, name, argv }` shape, so the service logic can
 * apply one rule to decide whether a process serves a profile.
 */
import { basename } from 'node:path'

/** Process names that may run the DSH service on either platform. */
const SERVICE_NAMES = new Set(['node', 'dsh', 'node.exe', 'dsh.exe'])

/** Whether `name` is the short command name (`ucomm` on POSIX, `Name` on Windows) of a DSH service process. */
export function isServiceName(name) {
  return SERVICE_NAMES.has(String(name).toLowerCase())
}

/**
 * Whether command-line words belong to the main DSH service process for `profile`.
 *
 * Only `--profile` and non-option words are inspected, so a command line that merely mentions the profile
 * (for example `dsh plugin --profile superagent add link:/x`) does not count. `argv[0]` is the executable.
 */
export function serves(argv, profile) {
  const words = []
  let matched = false
  let value = false
  for (const word of argv.slice(1)) {
    if (value) {
      matched = matched || word === profile
      value = false
    } else if (word === '--profile') {
      value = true
    } else if (word === '--profile=' + profile) {
      matched = true
    } else if (!word.startsWith('-')) {
      words.push(word)
    }
  }
  return matched && !words.includes('plugin')
}

/** The command names of this controller process, which a service scan must not mistake for the service. */
export function selfCommandNames(argv0 = process.argv[1]) {
  const names = new Set()
  if (argv0) names.add(basename(argv0).toLowerCase())
  return names
}

/**
 * Return the entries that serve `profile`, in scan order, excluding this controller process.
 *
 * POSIX cannot spawn itself, but this script runs as `node`, the same name as the service, so the controller
 * would otherwise find itself and refuse every start as a duplicate.
 */
export function findServiceEntries(entries, profile, { selfPid = process.pid, selfNames = selfCommandNames() } = {}) {
  return entries.filter(entry => {
    if (entry.pid === selfPid) return false
    if (!isServiceName(entry.name)) return false
    if (!serves(entry.argv, profile)) return false
    return !entry.argv.some(word => selfNames.has(basename(word).toLowerCase()))
  })
}

/** Parse `ps -o pid=,ucomm=,args=` output; a path with spaces becomes several words, as only options and subcommands matter. */
export function parsePsOutput(text) {
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    entries.push({ pid: Number(match[1]), name: match[2], argv: match[3].split(/\s+/).filter(Boolean) })
  }
  return entries
}

/**
 * Parse the JSON that PowerShell prints for `Win32_Process`; `ConvertTo-Json` prints a bare object for one match.
 * A process whose command line is hidden (another user's process) is skipped because it cannot be identified.
 */
export function parseCimOutput(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  const value = JSON.parse(trimmed)
  const items = Array.isArray(value) ? value : value ? [value] : []
  const entries = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const commandLine = typeof item.CommandLine === 'string' ? item.CommandLine : ''
    const pid = Number(item.ProcessId)
    if (!commandLine || !Number.isInteger(pid)) continue
    entries.push({ pid, name: String(item.Name ?? ''), argv: splitCommandLine(commandLine) })
  }
  return entries
}

/**
 * Split a Windows command line into words the way `CommandLineToArgvW` does, so paths with spaces stay whole.
 * Backslashes are literal unless they precede a quote, where `2n` of them yield `n` backslashes and a quote
 * delimiter, and `2n + 1` yield `n` backslashes and a literal quote.
 */
export function splitCommandLine(commandLine) {
  const words = []
  let word = ''
  let quoted = false
  let backslashes = 0
  for (const character of commandLine) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      word += '\\'.repeat(backslashes >> 1)
      if (backslashes % 2 === 1) word += '"'
      else quoted = !quoted
      backslashes = 0
      continue
    }
    word += '\\'.repeat(backslashes)
    backslashes = 0
    if (!quoted && /\s/.test(character)) {
      if (word) words.push(word)
      word = ''
      continue
    }
    word += character
  }
  word += '\\'.repeat(backslashes)
  if (word) words.push(word)
  return words
}
