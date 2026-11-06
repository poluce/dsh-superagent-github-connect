/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.ts'
import type { Localized } from './sources/kind.ts'
import { FEISHU_SETUP_PROBLEMS, GITHUB_SETUP_PROBLEMS } from './sources/setup-problems.ts'

/**
 * Place an operator fixes a setup problem: the deployment settings, a Source kind's settings page, or another place a
 * kind names (`setup.problems`); the panel opens this place from the problem.
 */
export type SetupPlace = 'deployment' | 'github' | 'feishu' | (string & {})
/**
 * One setup problem's place, the host's English text with `{value}` placeholders `SetupError` fills, and, for a kind that
 * is not built in, the words the panel shows instead of a localization of its own.
 */
export type SetupProblemSpec = readonly [place: SetupPlace, text: string, words?: Localized]
/** The setup problems a part of dsh-superagent reports, by code. */
export type SetupProblems = Readonly<Record<string, SetupProblemSpec>>
/** Problems of dsh-superagent itself, fixed in the deployment settings rather than on a Source. */
const DEPLOYMENT_SETUP_PROBLEMS = {
  foreignFile: ['deployment', '{file} was not written by dsh-superagent; move it, or choose another state directory.'],
  gitTooOld: ['deployment', 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.'],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
} as const satisfies SetupProblems
/**
 * Every setup problem dsh-superagent itself reports, by code: the deployment's, and those of the built-in Source kinds'
 * account checks. A Source kind that is not built in declares its own table on its kind (`SourceKind.setup.problems`) and
 * throws it as the third argument of `SetupError`.
 */
export const SETUP_PROBLEMS = { ...DEPLOYMENT_SETUP_PROBLEMS, ...GITHUB_SETUP_PROBLEMS, ...FEISHU_SETUP_PROBLEMS } as const satisfies SetupProblems
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem { place: SetupPlace; code: string; values: Record<string, string>; detail: string; text?: Localized }

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  readonly words?: Localized
  constructor(readonly code: string, readonly values: Record<string, string> = {}, problems: SetupProblems = SETUP_PROBLEMS) {
    const spec = problems[code]
    if (!spec) throw new Error(`dsh-superagent has no setup problem for the code ${code}`)
    const [place, text, words] = spec
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
    if (words) this.words = words
  }
  get problem(): SetupProblem {
    return { place: this.place, code: this.code, values: this.values, detail: this.message, ...this.words ? { text: this.words } : {} }
  }
}
