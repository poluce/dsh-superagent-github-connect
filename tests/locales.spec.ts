import { expect, it } from 'vitest'
import type { EffectKind } from '../src/app/effects.ts'
import { en, GLOSSARY, GLOSSARY_VALUES, zh, type DshSuperagentKey } from '../src/client/locales.ts'
import { reasonLabel, type T } from '../src/client/text.ts'
import { REASONS, USER_ERRORS } from '../src/core/index.ts'
import { HEALTH_TEXT, type HealthCode } from '../src/sources/host.ts'
import { SETUP_PROBLEMS, type SetupCode } from '../src/setup.ts'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
/** The words a dictionary has for `key`, or undefined when it has none; the key is built at run time, so it is looked up untyped. */
const words = (dictionary: Record<DshSuperagentKey, string>, key: string): string | undefined =>
  (dictionary as Record<string, string>)[key]

it('names the same placeholders in both languages', () => {
  const keys = Object.keys(zh) as DshSuperagentKey[]
  expect(keys.filter(key => placeholders(zh[key]).join() !== placeholders(en[key]).join())).toEqual([])
  expect(keys.filter(key => !zh[key] || !en[key])).toEqual([])
})

it('words a reason by its code with its values, each of a batch, and words a person or an assessor wrote as written', () => {
  const t = ((key: DshSuperagentKey, values: Record<string, string> = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '')) as T
  expect(reasonLabel(t, 'retried')).toBe(zh['reason.retried'])
  expect(reasonLabel(t, [{ code: 'routed', values: { ticket: 't1' } }])).toBe('已转给工单 t1')
  expect(reasonLabel(t, [{ code: 'not_a_member', triggerId: '1' }, { code: 'no_mention', triggerId: '2' }]))
    .toBe(`${zh['reason.not_a_member']}；${zh['reason.no_mention']}`)
  expect(reasonLabel(t, [{ code: 'said', values: { text: 'The button is already blue' } }])).toBe('The button is already blue')
  // A code the panel has no words for reads as the host words it.
  expect(reasonLabel(t, { code: 'some_new_filter' })).toBe('some_new_filter')
  expect(reasonLabel(t, 'The button is already blue')).toBe('The button is already blue')
})

it('names every health entry of dsh-superagent itself, which the overview shows when it fails', () => {
  // Each entry by its writer: dsh-superagent, the model budget retries, every kind of the effect queue, Channel messages, the
  // Executor and the unavailable Evals of the last hour.
  const entries = { runtime: 0, models: 0, reply: 0, worker: 0, assessment: 0, launch: 0, delivery: 0, relay: 0,
    notice: 0, evals: 0 } satisfies Record<EffectKind | 'runtime' | 'models' | 'reply' | 'worker' | 'evals', 0>
  expect(Object.keys(entries).filter(name => !(`health.${name}` in zh))).toEqual([])
})

it('words every refusal the host words by code, in both languages', () => {
  expect(Object.keys(USER_ERRORS).filter(code => !zh[`userError.${code}` as DshSuperagentKey]
    || !en[`userError.${code}` as DshSuperagentKey])).toEqual([])
})

it('has words for every reason code the core records', () => {
  expect(Object.keys(REASONS).filter(code => code !== 'said' && !(`reason.${code}` in zh))).toEqual([])
})

it('words the reasons agents read in the glossary\'s words: a sender on the list, a Thread', () => {
  expect(Object.values(REASONS).filter(text => /\b(member|members|topic)\b/i.test(text))).toEqual([])
})

it('words every health code and setup problem the host reports, in both languages and in the host\'s own words', () => {
  const healthCodes = Object.keys(HEALTH_TEXT) as HealthCode[]
  expect(healthCodes.filter(code => words(zh, `healthCode.${code}`) === undefined)).toEqual([])
  expect(healthCodes.filter(code => words(en, `healthCode.${code}`) === undefined)).toEqual([])
  // English reuses the host's own text, which the log and the main Session read, so the panel and the log cannot drift apart.
  expect(healthCodes.filter(code => words(en, `healthCode.${code}`) !== HEALTH_TEXT[code])).toEqual([])
  // No stale keys either: a key the host can never report is text nobody reads.
  expect(Object.keys(zh).filter(key => key.startsWith('healthCode.')).map(key => key.slice('healthCode.'.length))
    .filter(code => !(code in HEALTH_TEXT))).toEqual([])
  const setupCodes = Object.keys(SETUP_PROBLEMS) as SetupCode[]
  expect(setupCodes.filter(code => words(zh, `setup.${code}`) === undefined)).toEqual([])
  expect(setupCodes.filter(code => words(en, `setup.${code}`) !== SETUP_PROBLEMS[code][1])).toEqual([])
  expect(Object.keys(zh).filter(key => key.startsWith('setup.')).map(key => key.slice('setup.'.length))
    .filter(code => !(code in SETUP_PROBLEMS))).toEqual([])
})

it('names every glossary term, and every value the glossary lists, in both languages', () => {
  const terms = Object.values(GLOSSARY).flat()
  expect(terms.filter(term => words(zh, `term.${term}`) === undefined || words(zh, `meaning.${term}`) === undefined)).toEqual([])
  expect(terms.filter(term => words(en, `term.${term}`) === undefined || words(en, `meaning.${term}`) === undefined)).toEqual([])
  const values = Object.values(GLOSSARY_VALUES).flat()
  expect(values.filter(key => words(zh, key) === undefined || words(en, key) === undefined)).toEqual([])
})
