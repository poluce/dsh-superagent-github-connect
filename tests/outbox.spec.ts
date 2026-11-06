/** Outbox delivery when processing is paused or a Source kind registers late, and the crash window between a send and its receipt. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Effects } from '../src/app/effects.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { SourceChannel, SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}
/** A Source kind whose Channel runs `send`, so a test sees the message and the idempotency key the Outbox hands it. */
const probeKind = (send: SourceChannel<Record<string, never>>['send']): SourceKind<Record<string, never>> => ({ kind: 'probe',
  title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [], schema: z.object({}).strict(), fields: [],
  channel: { send, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } })
/** A message for the `probe` kind's Channel. */
const probeMessage = (id: string, text = 'Done'): OutboundMessage =>
  ({ id, channel: { source: 'probe', thread: 'probe:1', address: {} }, text, kind: 'reply' })

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting under its id, and sends it once the Source\'s kind registers', async () => {
  const sent: { id: string; key: string }[] = []
  h.runtime.outbox.send(probeMessage('waiting'))
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probeKind(async (_host, message, idempotencyKey) => {
    sent.push({ id: message.id, key: idempotencyKey })
    return 'sent'
  }))
  // A message whose Source was not installed is tried again after 5 seconds, under the same id, which an installed kind is
  // handed as the idempotency key.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent]).toEqual(['sent', [{ id: 'waiting', key: 'waiting' }]])
})

it('sends a message a restart found pending again, with the same idempotency key, so its Channel publishes it once', async () => {
  const sends: { id: string; key: string }[] = []
  /** What the Channel's service published, by idempotency key: a second send under a key it already saw changes nothing there. */
  const published = new Map<string, string>()
  h.runtime.sources.register(probeKind(async (_host, message, idempotencyKey) => {
    sends.push({ id: message.id, key: idempotencyKey })
    if (!published.has(idempotencyKey)) published.set(idempotencyKey, message.text)
    return 'sent'
  }))
  // The Channel took the message, then this process stopped before it recorded the receipt: the window a crash leaves open.
  vi.spyOn(h.runtime.store.receipts, 'settle').mockImplementationOnce(() => { throw new Error('the process stopped before the receipt was recorded') })
  h.runtime.outbox.send(probeMessage('crash-window'))
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('crash-window'), sends]).toEqual(['pending', [{ id: 'crash-window', key: 'crash-window' }]])
  // The process stops, and its queue with it; the message's row stays in the database for the next process.
  await h.runtime.effects.drain()
  expect([h.runtime.store.receipts.get('crash-window')?.status, h.runtime.effects.pending('reply', 'crash-window')]).toEqual(['pending', true])
  // A restarted process opens the same database with its own queue and Outbox; the Channel is the service outside it.
  const restarted = new Effects(h.runtime.store, new HealthBoard(), () => Date.now() + 5000)
  const outbox = new Outbox({ store: h.runtime.store, effects: restarted, sources: h.runtime.sources, commands: h.runtime.commands, paused: () => false })
  restarted.start()
  await outbox.sent()
  expect([outbox.status('crash-window'), h.runtime.effects.pending('reply', 'crash-window')]).toEqual(['sent', false])
  // Both attempts passed the message's own id: one outbound message, though its Channel was asked to send it twice.
  expect(sends).toEqual([{ id: 'crash-window', key: 'crash-window' }, { id: 'crash-window', key: 'crash-window' }])
  expect([...published]).toEqual([['crash-window', 'Done']])
  await restarted.drain()
})

it('drops a message its Channel says is gone, and never queues it again under another key', async () => {
  const sends: string[] = []
  h.runtime.sources.register(probeKind(async (_host, _message, idempotencyKey) => { sends.push(idempotencyKey); return 'gone' }))
  h.runtime.outbox.send(probeMessage('gone-target'))
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('gone-target'), sends]).toEqual(['dropped', ['gone-target']])
  // The receipt keeps the id, so queueing the same message again adds no second attempt under another key.
  h.runtime.outbox.send(probeMessage('gone-target', 'Done again'))
  await at(5000)
  expect(sends).toEqual(['gone-target'])
})
