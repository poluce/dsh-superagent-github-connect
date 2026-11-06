/**
 * Setup problems of the built-in GitHub and Feishu account checks, declared beside the kinds they belong to.
 * `src/setup.ts` composes the host's table from them; a Source kind declares its own `setup.problems` the same way.
 */
import type { SetupProblems } from '../setup.ts'

/** Problems the GitHub account check in `src/deployment.ts` reports; the operator fixes them on the GitHub Source. */
export const GITHUB_SETUP_PROBLEMS = {
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
} as const satisfies SetupProblems

/** Problems the Feishu bot check in `src/deployment.ts` reports; the operator fixes them on the Feishu Source. */
export const FEISHU_SETUP_PROBLEMS = {
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: ['feishu', 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.'],
  feishuUserIdentity: ['feishu', 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.'],
  feishuNoBot: ['feishu', 'The Feishu bot API did not return the bot\'s open_id.'],
} as const satisfies SetupProblems
