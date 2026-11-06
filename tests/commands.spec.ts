import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CliError, Commands, commandError, spawnInvocation } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { githubKind } from '../src/sources/github.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(feishuKind); sources.register(githubKind)
const send = (commands: Commands, message: OutboundMessage) => sources.send(message, commands)
const deployment = testDeployment({ github: { ...testDeployment().github, cli: '/path/agent-gh' } })
const REPOSITORY = deployment.repository
const reply = { id: 'stable-operation', channel: githubChannel(8), text: 'Done', kind: 'reply' as const }
describe('account-isolated operations', () => {
  it('uses the agent account\'s GitHub CLI and preserves literal shell metacharacters in argv', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{}')
    await commands.gh(['api','some-path','-f','body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api','some-path','-f','body=`whoami` $(touch x)'])
  })
  it('runs every command with its environment over the process environment, where undefined removes a variable', async () => {
    process.env.GH_TOKEN = 'personal'
    try {
      // `env` prints the child's environment on POSIX only; Node prints it on every platform.
      const output = await new Commands(() => deployment, { GH_TOKEN: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal)
        .run(process.execPath, ['-e', 'console.log(JSON.stringify({ probe: process.env.DSH_SUPERAGENT_PROBE, token: process.env.GH_TOKEN ?? null }))'])
      expect(JSON.parse(output)).toEqual({ probe: 'agent', token: null })
    } finally { delete process.env.GH_TOKEN }
  })
  it('refuses Feishu commands when the deployment has no Feishu bot', async () => {
    await expect(new Commands(() => testDeployment({ feishu: undefined }), {}, new AbortController().signal).lark(['im', '+chat-list'])).rejects.toThrow('The Feishu Source has no working bot CLI')
  })
  it('reconciles an uncertain GitHub send with its stable marker', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    vi.spyOn(commands,'pages').mockResolvedValue([{ body:'<!-- dsh-superagent:stable-operation -->',user:{login:'agent-bot'} }])
    const gh = vi.spyOn(commands,'gh')
    await send(commands, reply); expect(gh).not.toHaveBeenCalled()
  })
  it('posts the reply as the model wrote it, only to the fixed repository', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValue({})
    await send(commands, reply)
    // The disclosure line is prompt text: the model writes it, and the host adds nothing.
    expect(gh).toHaveBeenCalledWith(['api',`repos/${REPOSITORY}/issues/8/comments`,'--method','POST','-f',expect.stringMatching(/^body=Done\n\n<!-- dsh-superagent:stable-operation -->$/)])
    await expect(new Commands(() => deployment, {}, new AbortController().signal).pages(z.unknown(),
      '../../someone/else/issues')).rejects.toThrow()
  })
  it('routes review-comment replies to the root review comment', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); vi.spyOn(commands,'pages').mockResolvedValue([])
    const gh = vi.spyOn(commands,'gh').mockResolvedValueOnce({ id: 7, in_reply_to_id: 3 }).mockResolvedValueOnce({})
    await send(commands, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })
    expect(gh.mock.calls[1]![0]).toEqual(['api', `repos/${REPOSITORY}/pulls/8/comments/3/replies`, '--method', 'POST', '-f', expect.stringContaining('Done')])
  })
  it('uses Feishu bot identity and one idempotency key on retries', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{"ok":true,"data":{}}')
    await send(commands, { ...reply, channel: feishuChannel('oc_1', 'om_1') })
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--as','bot','--idempotency-key','stable-operation','--message-id','om_1']))
  })
})

it('reports Feishu failures with their code and without command arguments', () => {
  const membership = commandError({stderr:'[page 1] fetching...\n'+JSON.stringify({error:{code:232011,message:'operator is not in the chat'}})})
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(commandError({stderr:JSON.stringify({error:{code:999,message:'scope missing'}})}).message).toBe('scope missing (999)')
})
describe('Channels', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  const feishu = { ...reply, channel: feishuChannel('oc_1', 'om_1') }
  const lark = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })
  it('drop a Feishu reply to a recalled message or one Feishu no longer finds, and say how to add the bot to a chat', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run')
    for (const [code, message] of [[230011, 'The message is recalled'], [230001, 'message not found'], [231003,
      'The message is withdrawn']] as const) {
      run.mockRejectedValueOnce(lark(code, message))
      expect(await send(value, feishu)).toBe('gone')
    }
    run.mockRejectedValueOnce(lark(232011, 'operator is not in the chat'))
    const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
    await expect(send(value, feishu)).rejects.toThrow(hint)
    run.mockRejectedValueOnce(lark(99991400, 'rate limited'))
    await expect(send(value, feishu)).rejects.toThrow('rate limited (99991400)')
  })
  it('keep a Feishu reply whose command timed out for a retry, whatever its text says', async () => {
    const value = commands()
    const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
    vi.spyOn(value, 'run').mockRejectedValueOnce(commandError(timedOut, 'lark-bot'))
    await expect(send(value, { ...feishu, text: 'The change was withdrawn' })).rejects.toThrow('lark-bot timed out after 90 s')
  })
  it('drop a GitHub reply to an Issue that is deleted or locked, and keep others for a retry', async () => {
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
    for (const stderr of ['gh: This issue was deleted (HTTP 410)', 'gh: Unable to create comment because issue is locked. (HTTP 403)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      expect(await send(value, reply)).toBe('gone')
    }
    // GitHub also answers 404 for a private repository the agent lost access to, so 404 is retried rather than dropped.
    for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: Server Error (HTTP 500)']) {
      gh.mockRejectedValueOnce(commandError({ stderr, code: 1 }))
      await expect(send(value, reply)).rejects.toThrow(stderr)
    }
  })
  it('reply on the PR\'s conversation when the review comment a reply points at is gone', async () => {
    const value = commands()
    const pages = vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh')
      .mockRejectedValueOnce(commandError({ stderr: 'gh: Not Found (HTTP 404)', code: 1 })).mockResolvedValueOnce({})
    expect(await send(value, { ...reply, channel: githubChannel(8, `https://github.com/${REPOSITORY}/pull/8#discussion_r7`) })).toBe('sent')
    expect((pages.mock.calls[0] as unknown[])[1]).toBe('issues/8/comments')
    const post = ['api', `repos/${REPOSITORY}/issues/8/comments`, '--method', 'POST', '-f', expect.stringContaining('Done')]
    expect(gh.mock.calls[1]![0]).toEqual(post)
  })
  it('link each address to its page with its label', () => {
    const links = { repository: REPOSITORY, feishu: deployment.feishu! }
    expect(githubKind.channel!.link(githubChannel(8).address, links)).toEqual({ url: `https://github.com/${REPOSITORY}/issues/8`,
      label: { zh: 'GitHub #8', en: 'GitHub #8' } })
    const review = `https://github.com/${REPOSITORY}/pull/8#discussion_r7`
    expect(githubKind.channel!.link(githubChannel(8, review).address, links))
      .toEqual({ url: review, label: { zh: 'GitHub #8 的 review 讨论', en: 'Review discussion on GitHub #8' } })
    expect(githubKind.channel!.link(githubChannel(8).address, {}).url).toBe('')
    const message = feishuChannel('oc_1', 'om_1').address
    expect(feishuKind.channel!.link(message, links)).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: key('feishu', 'om_1') })
  })
})

describe('GitHub calls', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  it('go only to paths inside the configured repository, and validate what GitHub answers', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12,"title":"Login fails","extra":true}')
    expect(await value.api(z.looseObject({ number: z.number() }), 'issues/12')).toEqual({ number: 12, title: 'Login fails', extra: true })
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12`])
    await expect(value.api(z.looseObject({ number: z.string() }), 'issues/12')).rejects.toThrow()
    for (const path of ['../other/repo/issues', 'issues/../../x', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('restricted to the configured repository')
    }
    expect(run).toHaveBeenCalledTimes(2)
    // An empty path targets the repository root.
    await value.api(z.unknown(), '')
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}`])
    // Without a schema, api() returns the raw CLI stdout.
    run.mockResolvedValue('raw file')
    expect(await value.api('contents/README.md', '-H', 'Accept: application/vnd.github.raw')).toBe('raw file')
  })
  it('read every page of a list, and skip and count an item that does not validate', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('[[{"id":1}],[{"id":2}]]')
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments?per_page=100')).toEqual([{ id: 1 }, { id: 2 }])
    expect(run).toHaveBeenLastCalledWith('/path/agent-gh', ['api', `repos/${REPOSITORY}/issues/12/comments?per_page=100`, '--paginate',
      '--slurp'])
    run.mockResolvedValue('[[{"id":1}],[{"id":"two"}]]')
    const tally = { skipped: 0 }
    expect(await value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments', tally)).toEqual([{ id: 1 }])
    expect(tally).toEqual({ skipped: 1 })
    run.mockResolvedValue('{"message":"not a list"}')
    await expect(value.pages(z.looseObject({ id: z.number() }), 'issues/12/comments')).rejects.toThrow()
  })
})
it('says how to add the bot to a chat when Feishu answers that it is not a member, and keeps the code', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = vi.spyOn(commands, 'run').mockRejectedValueOnce(commandError({ stderr: membership, code: 1 }))
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011, exitCode: 1 })
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011 })
})
it('names only the program and how it ended when a command prints no diagnostics, never its arguments', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const secret = 'secret reply text'
  // `sh` names the program that exits with 3 on POSIX; Windows has no `sh`, so Node is the program there.
  const program = process.platform === 'win32' ? process.execPath : 'sh'
  const failingArgs = process.platform === 'win32' ? ['-e', 'process.exit(3)', secret] : ['-c', 'exit 3', secret]
  await expect(commands.run(program, failingArgs)).rejects.toMatchObject({ message: `${basename(program)} exited with code 3`, exitCode: 3 })
  // A POSIX shell reports a signal as one; Windows terminates a process with an exit code instead, which needs no spelling here.
  if (process.platform !== 'win32') await expect(commands.run('sh', ['-c', 'kill -9 $$', secret])).rejects.toMatchObject({ message: 'sh was stopped by SIGKILL' })
  await expect(commands.run('/no/such/program', ['secret reply text'])).rejects.toMatchObject({ message: 'program could not run: ENOENT' })
  // Timeouts kill the child with SIGTERM; Node's default error message would echo every argument.
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  expect(commandError(timedOut, '/path/lark-bot')).toMatchObject({ message: 'lark-bot timed out after 90 s' })
  expect(String(commandError(timedOut, '/path/lark-bot'))).not.toContain('withdrawn')
})
it('reports failures as CliError with the code the CLI names and the exit status', async () => {
  const notFound = commandError({ stderr: 'gh: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'gh: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  expect(commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
    code: 1 })).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // A cancelled command stays an AbortError so callers can distinguish cancellation from failure.
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await expect(commands.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
})

it('stops a running command when the signal of its work aborts, or the lifetime, and leaves the other work running', async () => {
  const lifetime = new AbortController(), work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  // A program that waits, on every platform; `sleep` is POSIX-only.
  const waiting = ['-e', 'setTimeout(() => {}, 60_000)']
  const running = commands.withSignal(work.signal).run(process.execPath, waiting)
  work.abort()
  await expect(running).rejects.toThrow()
  // Only commands bound to the aborted work signal stop.
  expect(await commands.run(process.execPath, ['-p', '"still"'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run(process.execPath, waiting)
  lifetime.abort()
  await expect(other).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(4000)
})

describe('batch CLI wrappers', () => {
  it('runs a .cmd or .bat program through cmd.exe on Windows, and leaves other programs alone', () => {
    // Windows starts a process only from an executable image, so a deployment that names a `.cmd` wrapper as its CLI needs cmd.exe.
    expect(spawnInvocation(['/path/agent-gh', 'api', 'user'])).toEqual({ argv: ['/path/agent-gh', 'api', 'user'], env: {} })
    const invocation = spawnInvocation(['C:\\tools\\gh-agent.cmd', 'api', 'user'])
    if (process.platform !== 'win32') return expect(invocation).toEqual({ argv: ['C:\\tools\\gh-agent.cmd', 'api', 'user'], env: {} })
    expect(invocation.argv).toEqual([process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', '%DSH_SUPERAGENT_SPAWN%'])
    expect(invocation.env.DSH_SUPERAGENT_SPAWN).toBe('call "C:\\tools\\gh-agent.cmd" "api" "user"')
  })
  it.runIf(process.platform === 'win32')('runs a .cmd CLI a deployment names, with its arguments, as a worker shell would', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commands-cmd-'))
    const file = join(directory, 'say-args.cmd')
    writeFileSync(file, '@echo off\r\necho [%~1] [%~2]\r\n', 'utf8')
    try {
      const commands = new Commands(() => deployment, {}, new AbortController().signal)
      expect((await commands.run(file, ['api', 'a b'])).trim()).toBe('[api] [a b]')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
