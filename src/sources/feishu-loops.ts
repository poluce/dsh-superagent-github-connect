/** Feishu background loops: live event stream consumer, chat/topic history backfill, chat name refresh, and subscribed thread polling. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { feishuChatLink } from './feishu-channel.ts'
import type { FeishuBot } from '../deployment.ts'
import { spawnInvocation, validItems, type Tally } from '../infra/commands.ts'
import { readFeishu, type FeishuRef } from './feishu-read.ts'
import { feishuRef, feishuTime, feishuTrigger, HistoricalMessageSchema, historyEvent, HistoryPageSchema, SOURCE, topicEvent }
  from './feishu-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { family, KV, record } from '../kv.ts'
import { cursorAt, POLL_HORIZON_MS, polled, pollThreads as pollEach } from './poll.ts'
import type { FeishuConfig } from './feishu.ts'

/**
 * Runs the three background loops independently. A loop that dies is reported as the health of the entries it writes
 * instead of disappearing into a settled promise, as the GitHub Source reports an escape from its polling loop.
 */
export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.all([watch(ctx, signal).catch(reported(ctx, 'feishu', signal)),
    backfillLoop(ctx, signal).catch(reported(ctx, 'history', signal)),
    chatNamesLoop(ctx, signal).catch(reported(ctx, 'feishu', signal))])
/** Reports a loop's escape as health unless shutdown aborted the Source; a report that fails must not reject the loop's promise. */
const reported = (ctx: SourceContext, entry: string, signal: AbortSignal) => (error: unknown): void => {
  if (signal.aborted) return
  try { ctx.report(entry, { state: 'error', detail: String(error) }) } catch { /* nothing is left to report to */ }
}
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat = trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
const chatLink = (ctx: SourceContext, chatId: string): string => feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, running.signal) }
    catch (error) { if (!running.signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
    finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
/**
 * Variables the live consumer inherits: where the platform's programs and temporary files are, proxy settings, and the
 * CLI's own switches (`LARKSUITE_CLI_*`, which include the bot's configuration directory). Everything else in the process
 * environment, notably the GitHub token and the agent's credentials, is not handed to a process this Source spawns itself.
 */
const CONSUMER_ENV = new Set(['path', 'pathext', 'path_ext', 'home', 'userprofile', 'username', 'appdata', 'localappdata',
  'tmpdir', 'temp', 'tmp', 'systemroot', 'systemdrive', 'comspec', 'node_options', 'node_extra_ca_certs', 'ssl_cert_file',
  'ssl_cert_dir', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'lang', 'lc_all', 'language', 'tz'])
/** The environment of the event consumer: the variables above, the CLI's own switches, and whatever `extra` adds. */
export function consumerEnvironment(environment: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const inherited = Object.entries(environment).flatMap(([name, value]) => value === undefined ? []
    : CONSUMER_ENV.has(name.toLowerCase()) || name.toUpperCase().startsWith('LARKSUITE_CLI_') ? [[name, value] as const] : [])
  return { ...Object.fromEntries(inherited), LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1', ...extra }
}
/** Longest diagnostic kept on health: enough to name a failure, not the CLI's whole output. */
const DIAGNOSTIC_LIMIT = 240
/** A credential-shaped assignment such as `app_secret=…`, `"tenant_access_token": "…"`, or `password: …`. */
const CREDENTIAL = /((?:app|client|tenant|access|refresh|user)?[_-]?(?:secret|token|password|credential)\s*[=:]\s*)("?[^\s",;]+"?)/gi
/**
 * One line of the consumer's diagnostics, safe to report: credentials are redacted and the line is cut short, so a CLI that
 * echoes a token or prints a wall of output cannot put it on the Source's health, the panel, or the log.
 */
export function diagnosticLine(line: string, limit = DIAGNOSTIC_LIMIT): string {
  const redacted = line.replace(/\b(?:Bearer|Basic)\s+\S+/gi, 'Bearer [redacted]').replace(CREDENTIAL,
    (_match, prefix: string) => `${prefix}[redacted]`)
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted
}
/**
 * A live event whose handling failed: its raw line is kept in the Source's own KV so a later pass delivers it.
 * `attempts` counts the retries that also failed, and `failedAt` is when the first failure happened.
 */
export interface LiveRetry { line: string; failedAt: string; attempts: number }
/**
 * KV key of the live events kept for retry. This loop is its only writer, so the key is declared here rather than in
 * `kv.ts`, whose families are shared by every component; its name follows the `feishu-` prefix of the Feishu Source.
 */
const LIVE_RETRY = record<LiveRetry[]>('feishu-live-retry')
/** How many live events are kept; the oldest is dropped past it so a failure storm cannot fill the store. */
export const LIVE_RETRY_LIMIT = 50
/** A kept live event whose retries keep failing is abandoned after a day, as a failed GitHub notification read is. */
const LIVE_RETRY_WINDOW_MS = 24 * 3600_000
/** How long after a live event failed the kept events are retried while the consumer stays up. */
const LIVE_RETRY_DELAY_MS = 30_000
/** Largest event line accepted from the consumer; a larger one is reported as unusable rather than kept. */
const LIVE_EVENT_LIMIT = 1_048_576
/** Parses one line of the consumer's output into event data; throws when the line is too large or not JSON. */
const parseLine = (line: string): unknown => {
  if (line.length > LIVE_EVENT_LIMIT) throw new Error('Feishu event exceeds 1 MiB')
  return JSON.parse(line)
}
/** Applies one parsed live event; throws when it could not be delivered, so the caller keeps its line for retry. */
export async function applyEvent(ctx: SourceContext, event: unknown): Promise<void> {
  const trigger = feishuTrigger(event, bot(ctx).botId, bot(ctx).appId)
  // Events already read when the Source is disabled are dropped; the consumer stops shortly after.
  if (!trigger || !enabled(ctx)) return
  const chats = ctx.state.get(KV.feishu.chats) ?? {}
  chats[String(trigger.meta.chatId)] = trigger.meta.direct === true
  ctx.state.set(KV.feishu.chats, chats)
  await receive(ctx, trigger)
}
/** Applies one raw event line; used when a kept event is retried. */
export const applyEventLine = (ctx: SourceContext, line: string): Promise<void> => applyEvent(ctx, parseLine(line))
/** Keeps a live event whose handling failed so a later pass delivers it; the oldest out of the limit is dropped and named in health. */
export function queueLiveEvent(ctx: SourceContext, line: string, now = new Date()): void {
  const kept = [...ctx.state.get(LIVE_RETRY) ?? [], { line, failedAt: now.toISOString(), attempts: 0 }]
  const dropped = Math.max(0, kept.length - LIVE_RETRY_LIMIT)
  ctx.state.set(LIVE_RETRY, kept.slice(dropped))
  if (dropped) ctx.report('feishu', { state: 'error', detail: `${dropped} kept Feishu ${dropped === 1 ? 'event' : 'events'} dropped after ${LIVE_RETRY_LIMIT} failures` })
}
/**
 * Applies one line the consumer printed. A line that is not an event (a diagnostic the CLI printed, or one too large) is
 * reported and dropped, as there is nothing to deliver; an event that could not be delivered is kept in the Source's store
 * and reported, so the caller can retry it.
 * @returns true when the line was kept for retry.
 */
export async function takeLine(ctx: SourceContext, line: string, signal: AbortSignal): Promise<boolean> {
  let event: unknown
  try { event = parseLine(line) }
  catch (error) {
    if (!signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) })
    return false
  }
  try { await applyEvent(ctx, event) }
  catch (error) {
    if (signal.aborted) return false
    queueLiveEvent(ctx, line)
    if (!signal.aborted) ctx.report('feishu', { state: 'error', detail: `${String(error)}; the event is kept for retry` })
    return true
  }
  return false
}
/**
 * Retries the kept live events oldest first, so a failure loses no message. One that still fails stays kept until a day
 * has passed since its first failure, and a delivery removes it; both an abandonment and a failed retry are reported on
 * the Source's health, which also keeps the pending count, so nothing is dropped without a trace.
 * @returns how many kept events were delivered.
 */
export async function retryLiveEvents(ctx: SourceContext, signal?: AbortSignal, now = new Date()): Promise<number> {
  const queued = ctx.state.get(LIVE_RETRY) ?? []
  if (!queued.length || !enabled(ctx)) return 0
  const kept: LiveRetry[] = []
  const errors: string[] = []
  let retried = 0
  let abandoned = 0
  for (const item of queued) {
    if (signal?.aborted || !enabled(ctx)) { kept.push(item); continue }
    try { await applyEventLine(ctx, item.line); retried += 1 }
    catch (error) {
      if (signal?.aborted) { kept.push(item); continue }
      if (now.getTime() - Date.parse(item.failedAt) < LIVE_RETRY_WINDOW_MS) kept.push({ ...item, attempts: item.attempts + 1 })
      else abandoned += 1
      errors.push(String(error))
    }
  }
  ctx.state.set(LIVE_RETRY, kept.length ? kept : undefined)
  if (errors.length || abandoned) {
    const lost = abandoned ? `; ${abandoned} kept ${abandoned === 1 ? 'event' : 'events'} abandoned after a day of failed retries` : ''
    ctx.report('feishu', { state: 'error', detail: `${errors.length} kept Feishu ${errors.length === 1 ? 'event' : 'events'} still failed: ${errors[0]}${lost}` })
  } else if (retried) {
    ctx.report('feishu', { state: 'ready',
      detail: `Listening for bot events; ${retried} kept ${retried === 1 ? 'event' : 'events'} recovered`, at: new Date().toISOString() })
  }
  return retried
}
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const invocation = spawnInvocation([bot(ctx).cli, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'])
  const child = spawn(invocation.argv[0]!, invocation.argv.slice(1),
    { stdio: ['pipe', 'pipe', 'pipe'], env: consumerEnvironment(process.env, invocation.env) })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false
  let retrying: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const fail = (error: unknown): void => { if (!signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
  // A failed event is kept in the store; while this consumer stays up, the kept events are retried after a pause instead of
  // waiting for the next event or restart. Only one retry is scheduled at a time, so the queue is not drained concurrently.
  const retrySoon = (): void => {
    if (retrying) return
    retrying = setTimeout(() => { retrying = undefined; drain() }, LIVE_RETRY_DELAY_MS)
    retrying.unref?.()
  }
  // Kept events run before new ones, so an event that failed before the consumer restarted is delivered in order, and a retry
  // that failed again is tried again while the queue is not empty.
  const drain = (): void => {
    chain = chain.then(async () => {
      await retryLiveEvents(ctx, signal)
      if (!signal.aborted && (ctx.state.get(LIVE_RETRY)?.length ?? 0) > 0) retrySoon()
    }).then(() => {}, fail)
  }
  drain()
  const timeout = setTimeout(() => { diagnostic = 'Feishu event consumer did not become ready within 45 seconds'; stop() }, 45_000)
  stderr.on('line', (line: string) => {
    // The CLI's own output may echo credentials and can be long: only a redacted, short form reaches health.
    diagnostic = diagnosticLine(line)
    if (line.startsWith('[event] ready')) {
      ready = true; clearTimeout(timeout)
      ctx.report('feishu', { state: 'ready', detail: 'Listening for bot events', at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report('feishu', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => { if (await takeLine(ctx, line, signal)) retrySoon() })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); clearTimeout(retrying); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z.looseObject({ chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional() })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100']))
  const names = Object.fromEntries((result.chats ?? []).filter(chat => chat.name).map(chat => [chat.chat_id, chat.name!]))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list every minute independently of history backfill (whose rounds can take much longer), so newly joined chats appear within a minute. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) {
      try { await refreshChatNames(ctx, signal) }
      catch { /* Names are a display aid; the stored list stays until a later read succeeds. */ }
    }
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/**
 * Pages of chat and topic history one background round may read across all chats, so a Source turned on after weeks off
 * does not burst through its whole backlog before the next round begins.
 */
export const BACKFILL_PAGES_PER_ROUND = 200
/** Pages one chat's backfill may still read in the current round; a chat and its topics share it. */
export interface BackfillBudget { pages: number }
/** What a chat's backfill covered: whether everything up to `until` was read, and whether its cursor was clamped to the horizon. */
export interface BackfillResult { complete: boolean; clamped?: boolean }
/**
 * How far a chat's history recovery got when a round's page budget stopped it: the time up to which the chat list and each
 * topic were read contiguously. The next round resumes there instead of reading the pages before it again, and the record is
 * dropped once everything up to the round's start is read.
 */
interface BackfillProgress { chat?: string; topics: Record<string, string> }
/** Declared here beside its only writer, as `LIVE_RETRY` is; its name follows the `feishu-` prefix of the Feishu Source. */
const BACKFILL_PROGRESS = family<BackfillProgress, [chat: string]>('feishu-backfill-progress:')
async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) { ctx.report('history', health('paused', 'feishuBotMissing')); return }
  // The chats are visited in a rotating order, so a chat that uses up the round's pages does not keep the chats after it
  // from being read in every round; each chat's cursor advances only once its own backfill finished.
  let first = 0
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    const seen = ctx.state.get(KV.feishu.chats) ?? {}
    const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
    const chats = { ...Object.fromEntries(config.chats.map(chat => [chat.chatId, false])), ...Object.fromEntries(known) }
    const entries = Object.entries(chats)
    const start = entries.length ? first % entries.length : 0
    const rotated = [...entries.slice(start), ...entries.slice(0, start)]
    first += 1
    const budget: BackfillBudget = { pages: BACKFILL_PAGES_PER_ROUND }
    const errors: string[] = []
    const tally = { skipped: 0 }
    let incomplete = 0
    let clamped = 0
    for (const [chatId, direct] of rotated) {
      if (signal.aborted) break
      const started = new Date().toISOString()
      const cursorKey = KV.feishu.history(chatId)
      const since = ctx.state.get(cursorKey)
      if (since === undefined) { ctx.state.set(cursorKey, started); continue }
      try {
        const read = await backfillChat(ctx, chatId, direct, since, started, signal, tally, budget)
        if (signal.aborted) continue
        // A backfill cut short by the round's page limit keeps its cursor, so the next round continues where it stopped.
        if (read.complete) ctx.state.set(cursorKey, cursorAt(started))
        else incomplete += 1
        if (read.clamped) clamped += 1
      } catch (error) { if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`) }
    }
    await pollThreads(ctx, signal, tally)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    // A recovery cut short by the page limit or by the horizon says so, so what was not recovered is never silent.
    const limited = incomplete ? `; history recovery reached the ${BACKFILL_PAGES_PER_ROUND}-page limit and continues next round` : ''
    const horizon = clamped ? `; history before the two-week horizon was not recovered in ${clamped} chat(s)` : ''
    if (!signal.aborted) ctx.report('history', errors.length
      ? { state: 'error', detail: errors.join('\n') }
      : { state: 'ready', detail: `Configured groups and known direct chats recovered${skipped}${limited}${horizon}`, at: new Date().toISOString() })
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * A `since` older than the polling horizon is read from the horizon instead, so a cursor kept across a long time the Source
 * was off does not read every message since. `budget` bounds the pages this round may read: a backfill that stops at the
 * limit remembers how far it got, resumes there next round, and reports `complete: false` so its cursor is not advanced past
 * what was read. Every page of every scan is read oldest first, so the remembered position is a contiguous watermark.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
export async function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string,
  signal: AbortSignal, tally: Tally = { skipped: 0 }, budget?: BackfillBudget): Promise<BackfillResult> {
  const commands = ctx.commands.withSignal(signal)
  const topicsKey = KV.feishu.topics(chatId)
  const topics = { ...ctx.state.get(topicsKey) }
  const progressKey = BACKFILL_PROGRESS(chatId)
  const stored = ctx.state.get(progressKey)
  const progress: BackfillProgress = { ...(stored ?? {}), topics: { ...stored?.topics } }
  // A cursor kept across weeks in which the Source was off would read every message since; the horizon bounds the burst.
  const floor = Date.parse(until) - POLL_HORIZON_MS
  const clamped = Date.parse(since) < floor
  const start = clamped ? new Date(floor).toISOString() : since
  /**
   * Where a container's scan resumes: the start, or five seconds before the watermark a stopped round remembered, so a
   * message that became visible after the round passed its time is not missed. Deterministic Trigger IDs deduplicate it.
   */
  const resume = (watermark: string | undefined): string => {
    if (watermark === undefined) return start
    return new Date(Math.max(Date.parse(start), Date.parse(cursorAt(watermark)))).toISOString()
  }
  /** Reads one container oldest first, returning whether it reached `until` and the newest message time it read. */
  const scan = async (kind: 'chat' | 'thread', id: string, from: string): Promise<{ complete: boolean; last?: string }> => {
    let page: string | undefined
    const pages = new Set<string>()
    let last: string | undefined
    do {
      if (signal.aborted) throw signal.reason
      if (budget && budget.pages <= 0) return { complete: false, ...(last === undefined ? {} : { last }) }
      if (budget) budget.pages -= 1
      const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
      const parameters = { container_id_type: kind, container_id: id, start_time: seconds(from), end_time: seconds(until),
        sort_type: 'ByCreateTimeAsc', page_size: 50, ...(page ? { page_token: page } : {}) }
      const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
      const result = HistoryPageSchema.parse(await commands.lark(request))
      for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
        const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
        if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
        const at = feishuTime(message.create_time)
        if (last === undefined || Date.parse(at) > Date.parse(last)) last = at
        if (message.deleted) continue
        if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) topics[message.thread_id] = at
        const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
        if (trigger) await receive(ctx, trigger)
      }
      const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
      if (stuck) throw new Error('Feishu history pagination did not advance')
      page = result.has_more ? result.page_token : undefined
      if (page) pages.add(page)
    } while (page)
    return { complete: true, ...(last === undefined ? {} : { last }) }
  }
  /** Remembers a stopped scan where it stopped, so the next round reads on from there rather than from the start. */
  const stop = (what: 'chat' | 'topic', id: string, read: { complete: boolean; last?: string }, from: string): boolean => {
    if (read.complete) {
      // A container that reached `until` needs no watermark; keeping a stale one would re-read its range next round.
      if (what === 'chat') delete progress.chat
      else delete progress.topics[id]
      return true
    }
    const watermark = read.last ?? from
    if (what === 'chat') progress.chat = watermark
    else progress.topics[id] = watermark
    return false
  }
  const chatFrom = resume(progress.chat)
  let complete = stop('chat', chatId, await scan('chat', chatId, chatFrom), chatFrom)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread))
    .map(thread => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')))
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) {
      delete topics[id]
      delete progress.topics[id]
    }
  }
  ctx.state.set(topicsKey, topics)
  for (const id of Object.keys(topics)) {
    if (!complete) break
    const from = resume(progress.topics[id])
    complete = stop('topic', id, await scan('thread', id, from), from)
  }
  ctx.state.set(topicsKey, topics)
  // Everything up to `until` is read: the watermarks have served their purpose and the caller may move the chat cursor.
  ctx.state.set(progressKey, complete ? undefined : progress)
  return { complete, ...(clamped ? { clamped } : {}) }
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, tally))
}
/**
 * How many message IDs a polled Thread remembers. Pages are read newest first, so only the newest IDs can be met again;
 * forgetting older ones keeps the checkpoint's write bounded, and re-reading them is harmless because every read path of a
 * message produces the same deterministic Trigger ID, which the Engine deduplicates.
 */
export const SEEN_LIMIT = 500
async function pollThread(ctx: SourceContext, thread: Thread, signal?: AbortSignal, tally?: Tally): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  const commands = ctx.commands.withSignal(signal)
  const pageSize = config.readPageSize
  const checkpoint = KV.feishu.seen(thread.key)
  let known = new Set(ctx.state.get(checkpoint) ?? [])
  /** Adds the IDs of one page in read order (oldest last) and keeps only the newest `SEEN_LIMIT` of them. */
  const remember = (ids: string[]): void => {
    for (const id of ids) known.add(id)
    const kept = [...known].slice(-SEEN_LIMIT)
    known = new Set(kept)
    ctx.state.set(checkpoint, kept)
  }
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    const initial: string[] = []
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(commands, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) initial.push(result.message.message_id)
    }
    remember(initial)
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(commands, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    const encounteredKnown = result.messages.some(message => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger)
    }
    // A page arrives newest first; remembering it oldest first keeps the newest IDs at the end, where the limit trims.
    remember(result.messages.map(message => message.message_id).reverse())
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
