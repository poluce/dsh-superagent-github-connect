/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { SourceCommands } from './commands.ts'
import { sourceCommands } from './commands.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import type { Localized } from './kind.ts'
import { fill } from '../infra/text.ts'

/** Fixed English health templates of the protocol (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
/** Fixed health messages a Source kind declares, by code; the English text is the template, the panel shows the localized words. */
export type HealthCodes = Readonly<Record<string, Localized>>
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: string; values?: Record<string, string>; text?: Localized }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}
/** Builds a health value for one of a kind's declared codes, or for a shared one; throws for a code the kind does not declare. */
export function kindHealth(codes: HealthCodes | undefined, state: Health['state'], code: string, values: Record<string, string> = {}): Health {
  // The protocol's own codes stay available to every kind, and keep their localized keys; a kind's declaration wins otherwise.
  const declared = codes?.[code]
  if (declared) return { state, detail: fill(declared.en, values), code, text: declared, ...Object.keys(values).length ? { values } : {} }
  if (!(code in HEALTH_TEXT)) throw new Error(`The Source has no health code ${code}`)
  return health(state, code as HealthCode, values)
}
/** The kind information a SourceContext is built for: its id, its health entries, and the fixed messages it declares. */
export interface SourceContextKind { kind: string; health: readonly string[]; healthCodes?: HealthCodes }
export interface SourceHost {
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: SourceContextKind): SourceContext
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  readonly deployment: Deployment
  /** The deployment's commands narrowed to what a Source may use; see `SourceCommands`. */
  readonly commands: SourceCommands
  readonly ready: Promise<void>
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  /** Setup problem keeping this Source's account from running; only the built-in account checks report one. */
  readonly problem?: SetupProblem | undefined
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** Builds a health value with one of the kind's declared codes, or a protocol code such as `setupPending`. */
  healthOf(state: Health['state'], code: string, values?: Record<string, string>): Health
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
}
/** Builds a kind's context and narrows its command surface, so a plugin cannot reach the unrestricted runner. */
export const sourceContext = (host: SourceHost, kind: SourceContextKind): SourceContext => {
  const context = host.context(kind)
  return Object.assign(context, { commands: sourceCommands(context.commands) })
}
