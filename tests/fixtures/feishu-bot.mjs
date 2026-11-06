/**
 * A fake `lark-cli` bot for the Feishu event consumer tests.
 *
 * The consumer spawns its CLI as a process, which Windows starts only from an executable image, so the tests write a
 * launcher beside the temporary store — a `.cmd` that runs this script through the Node that runs the tests, and a `sh`
 * script that execs it elsewhere — and both platforms then drive the same behaviour. `event consume` prints the lines a
 * real bot prints and stays up; every other call (a chat list, a chat's members) answers an empty success.
 *
 * Usage: `feishu-bot.mjs <mode> <dir> [lark-cli arguments…]`
 * - `mode` says what `event consume` does: `never` gets ready, `warn` warns once ready, `ready` stays up, `flaky` exits
 *   after its first ready, `events` prints the lines in `<dir>/events` once ready, and `late` prints them a second later.
 * - `dir` is where the run counter, the PID of the latest run, and the `printed` marker are written.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, dir, ...args] = process.argv.slice(2)
/** Writes a file beside the store, or reads one a mode may not have written yet. */
const put = (name, text = '') => writeFileSync(join(dir, name), text)
const get = name => { try { return readFileSync(join(dir, name), 'utf8') } catch { return undefined } }
/** Writes one line out, and waits until it is flushed, so the consumer has it before the process settles. */
const print = (stream, text) => new Promise(resolve => stream.write(text, resolve))
const out = text => print(process.stdout, text)
const err = text => print(process.stderr, text)

// The consumer runs `lark-cli event consume im.message.receive_v1 --as bot`; anything else is an API call it answers empty.
if (args[0] !== 'event') {
  await out('{"ok":true,"data":{}}\n')
  process.exit(0)
}
// The consumer stops the CLI by ending its stdin, and on Windows the process it kills is `cmd.exe` rather than this one,
// so leaving when stdin ends is what ends this process on either platform.
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
// Each run is numbered, so a mode can behave differently on a restart, as a real CLI's reconnect does.
const runs = Number(get('runs') ?? 0) + 1
put('runs', String(runs))
put('pid', String(process.pid))
switch (mode) {
  case 'warn': await err('[event] ready\n'); await err('WARN the connection was reset\n'); break
  case 'ready': await err('[event] ready\n'); break
  // The first run exits after getting ready, so the consumer restarts it; the second run stays up.
  case 'flaky': await err('[event] ready\n'); if (runs > 1) break; process.exit(1)
  case 'events': await err('[event] ready\n'); await out(get('events') ?? ''); put('printed'); break
  // Prints the event only after the consumer has been listening for a while, so a Source turned off meanwhile drops it.
  case 'late': await err('[event] ready\n'); await new Promise(resolve => setTimeout(resolve, 1000)); await out(get('events') ?? ''); put('printed'); break
}
/** Stays up, as the consumer keeps listening, until it stops the CLI. */
setInterval(() => {}, 60_000)
