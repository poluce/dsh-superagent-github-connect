/**
 * A cross-platform control lock.
 *
 * `fcntl.flock` does not exist on Windows and Node exposes no equivalent, so this uses an exclusive-create lock file
 * that records the owner PID. A lock whose owner no longer runs is stale and may be taken over, which replaces the
 * automatic release that `flock` gives POSIX when a holder dies. A lock holding no owner (a file left by the earlier
 * Python implementation, whose `flock` cannot be read here) is honoured for `UNKNOWN_OWNER_MS` and then treated as
 * stale, so an interrupted upgrade cannot block the profile forever.
 */
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

/** A lock without a readable owner is honoured this long before it is treated as stale. */
const UNKNOWN_OWNER_MS = 60_000
/** A lock older than this is rebound even if its PID is alive, in case the PID was reused by an unrelated process. */
const MAX_OWNER_AGE_MS = 12 * 60 * 60 * 1000
/** The message the CLI prints when another control operation holds the profile. */
export const LOCKED = 'Another dsh-superagent control operation is in progress.'

/** Whether `pid` names a process that exists; a process owned by another user counts as existing. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function holder(lockPath) {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function age(lockPath, now) {
  try {
    return now() - statSync(lockPath).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Acquire the control lock at `lockPath`, or throw when another live operation holds it.
 *
 * Returns an idempotent release function. The file records this process, so a lock left by a killed process is
 * reclaimed once its owner is gone.
 */
export function acquireLock(lockPath, { pid = process.pid, now = Date.now } = {}) {
  const content = JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockPath, content + '\n', { flag: 'wx', mode: 0o600 })
      return () => releaseLock(lockPath, pid)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const owner = holder(lockPath)
    const ownerPid = Number(owner?.pid)
    if (Number.isInteger(ownerPid) && ownerPid !== pid && processAlive(ownerPid) && age(lockPath, now) < MAX_OWNER_AGE_MS) {
      throw new Error(LOCKED)
    }
    // An ownerless lock (the earlier Python implementation, or a crash between create and write) is stale once old.
    if (!Number.isInteger(ownerPid) && age(lockPath, now) < UNKNOWN_OWNER_MS) throw new Error(LOCKED)
    // The owner is gone or the lock is stale: remove it and try again; a racing removal ends in one winner.
    rmSync(lockPath, { force: true })
  }
  throw new Error(LOCKED)
}

/** Release a lock this process owns; a lock taken over by a later operation, or a file already removed, is left alone. */
export function releaseLock(lockPath, pid = process.pid) {
  const owner = holder(lockPath)
  if (!owner || Number(owner.pid) !== pid) return
  try {
    rmSync(lockPath, { force: true })
  } catch {
    // A lock already removed by a stale takeover is released.
  }
}
