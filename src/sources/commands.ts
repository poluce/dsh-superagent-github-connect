/** The command surface a Source may use: reads through the deployment's configured CLIs, without the unrestricted runner. */
import type { ZodType } from 'zod'
import type { Deployment } from '../deployment.ts'
import type { Commands, Tally } from '../infra/commands.ts'

/**
 * What a Source kind may call on the deployment's commands. It leaves out `run`, `gh` and `git`: a Source reads its own
 * provider's API through `api`, `pages` and `lark`, which stay bound to the configured repository and account, and never
 * starts an arbitrary program. `sourceCommands` narrows the host's `Commands` to this surface at run time, so a plugin
 * written against the type cannot reach the rest.
 */
export interface SourceCommands {
  /** The resolved deployment; reading it before setup completes throws, as with the host's commands. */
  readonly deployment: Deployment
  /** The same read surface bound to `signal` as well as the Source's lifetime. */
  withSignal(signal?: AbortSignal): SourceCommands
  /** Calls the GitHub API on a path within the configured repository, as `Commands.api`. */
  api<T>(schema: ZodType<T>, path: string, ...flags: string[]): Promise<T>
  api(path: string, ...flags: string[]): Promise<string>
  /** Fetches all pages of a GitHub API list within the configured repository. */
  pages<T>(item: ZodType<T>, path: string, tally?: Tally): Promise<T[]>
  /** Runs the Feishu bot's `lark-cli` and returns its JSON `data` payload. */
  lark<T>(args: string[], cwd?: string): Promise<T>
}
/** Narrows a deployment's commands to the surface a Source may use; the returned object exposes nothing else. */
export const sourceCommands = (commands: Commands | SourceCommands): SourceCommands => {
  const api = ((schema: unknown, path: string, ...flags: string[]) => typeof schema === 'string'
    ? (commands.api as (path: string, ...flags: string[]) => Promise<string>)(schema, path, ...flags)
    : (commands.api as (schema: ZodType<unknown>, path: string, ...flags: string[]) => Promise<unknown>)(schema as ZodType<unknown>,
      path, ...flags)) as SourceCommands['api']
  return {
    get deployment() { return commands.deployment },
    withSignal: signal => sourceCommands(commands.withSignal(signal)),
    api,
    // The optional arguments are left off when they are absent, so a caller and a spy see the same call as with `Commands`.
    pages: (item, path, tally) => tally === undefined ? commands.pages(item, path) : commands.pages(item, path, tally),
    lark: (args, cwd) => cwd === undefined ? commands.lark(args) : commands.lark(args, cwd),
  }
}
