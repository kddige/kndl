// Whether a Hub is running on a database: a running Hub holds a lock on `<database>.lock`, and
// what must not run under a live Hub, such as `secrets-reset` (SecretsReset.ts), takes the same
// lock for as long as it runs, so neither starts while the other runs.
//
// The lock is SQLite's own: the lock file is a small SQLite database, opened in EXCLUSIVE
// locking mode and written once, which keeps an exclusive lock on it until it is closed. The
// operating system drops the lock when the process ends, however it ends (even `kill -9`), so a
// crashed Hub leaves nothing stale behind, unlike a pid file, whose pid can be reused. It doesn't
// depend on the port or the host the Hub listens on either, as asking `/health` would. It holds
// across processes and within one. Like SQLite itself, it can't be trusted on a network
// filesystem.
//
// The lock is on a file beside the database rather than on the database itself: an exclusive
// lock on `hub.db` would also keep out what may run beside a live Hub, such as issuing a Runner
// token or `claude-hub doctor`.
import { Database } from "bun:sqlite"
import { Effect, Schema, type Scope } from "effect"

/**
 * The lock on a database wasn't taken, saying why: a Hub is running on it (or something else
 * holds the lock), or the lock file can't be opened.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class HubLockRefused extends Schema.TaggedError<HubLockRefused>()("HubLockRefused", {
  message: Schema.String,
}) {}

/** The lock file of the database at `database`. */
export const lockFileOf = (database: string) => `${database}.lock`

/** Whether `database` is a file, so it can be locked: not an in-memory database. */
const isFile = (database: string) => database !== "" && !database.startsWith(":memory:")

/** Takes the lock, or fails with SQLite's SQLITE_BUSY while another connection holds it. */
function take(file: string): Database {
  const db = new Database(file, { create: true })
  try {
    // Fail at once rather than wait for the holder.
    db.run("PRAGMA busy_timeout = 0")
    db.run("PRAGMA locking_mode = EXCLUSIVE")
    // No `-journal` file beside it, which a holder that is killed would leave in the home.
    db.run("PRAGMA journal_mode = MEMORY")
    // A write takes the exclusive lock, which EXCLUSIVE locking mode keeps after the commit.
    db.run("BEGIN EXCLUSIVE")
    db.run("CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL)")
    db.run("DELETE FROM holder")
    db.run("INSERT INTO holder (pid) VALUES (?)", [process.pid])
    db.run("COMMIT")
    return db
  } catch (cause) {
    db.close()
    throw cause
  }
}

const isBusy = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "SQLITE_BUSY" || cause.code === "SQLITE_LOCKED")

/**
 * Holds the lock on `database` until the scope closes, or fails with {@link HubLockRefused} while a
 * Hub runs on it (or anything else holds it). `doing` says what was refused, as in "Can't reset
 * the Sensitive values". An in-memory database has no lock to take.
 */
export const holdHubLock = (
  database: string,
  doing: string,
): Effect.Effect<void, HubLockRefused, Scope.Scope> =>
  isFile(database)
    ? Effect.asVoid(
        Effect.acquireRelease(
          Effect.try({
            try: () => take(lockFileOf(database)),
            catch: (cause) =>
              isBusy(cause)
                ? new HubLockRefused({
                    message: `${doing}: a Hub is running on ${database}. Stop it first.`,
                  })
                : new HubLockRefused({
                    message: `${doing}: its lock, ${lockFileOf(database)}, can't be taken: ${String(cause)}`,
                  }),
          }),
          (db) => Effect.sync(() => db.close()),
        ),
      )
    : Effect.void
