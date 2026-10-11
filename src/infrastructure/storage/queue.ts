import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import lockfile from 'proper-lockfile';
import { ApplicationError, StorageError } from '../../shared/errors.ts';
import { SEND_UNCERTAIN_FAILURE } from '../../shared/types.ts';
import type {
  ProfileStore,
  MessagingStore,
  ProfileRow,
  MessageRow,
} from '../../shared/types.ts';

export class Repository {
  private readonly database: DatabaseSync;
  readonly profiles: ProfileStore & { rows(): ProfileRow[] };
  readonly messages: MessagingStore & { rows(): MessageRow[] };

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      if (
        this.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='queue'",
          )
          .get()
      ) {
        throw new ApplicationError(
          'Legacy queue database detected. Start with a fresh database at queue_path; no migration is provided.',
        );
      }
      this.database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS profiles (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','working','written','failed')),
          failure TEXT NOT NULL DEFAULT '',
          CHECK((status = 'failed' AND length(failure) > 0) OR (status != 'failed' AND failure = ''))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS messaging (
          id INTEGER PRIMARY KEY,
          profile_id INTEGER NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
          subject TEXT NOT NULL CHECK(length(trim(subject)) > 0),
          message TEXT NOT NULL CHECK(length(trim(message)) > 0),
          status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','sent','failed','dryrun')),
          failure TEXT NOT NULL DEFAULT '',
          CHECK((status = 'failed' AND length(failure) > 0) OR (status != 'failed' AND failure = ''))
        ) STRICT;
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.profiles = {
      has: (slug) =>
        this.execute(
          () =>
            !!this.database
              .prepare('SELECT id FROM profiles WHERE slug = ?')
              .get(slug),
        ),
      append: (investor, failure = '') =>
        this.execute(
          () =>
            this.database
              .prepare(
                'INSERT INTO profiles(name,role,slug,status,failure) VALUES(?,?,?,?,?) ON CONFLICT(slug) DO NOTHING',
              )
              .run(
                investor.name,
                investor.role,
                investor.slug,
                failure ? 'failed' : 'new',
                failure,
              ).changes === 1,
        ),
      next: (excluded) =>
        this.transaction(() => {
          const row = this.database
            .prepare(
              `SELECT * FROM profiles WHERE status IN ('working','new') ${this.exclude(excluded)} ORDER BY CASE status WHEN 'working' THEN 0 ELSE 1 END,id LIMIT 1`,
            )
            .get(...excluded) as unknown as ProfileRow | undefined;
          if (row?.status === 'new') {
            this.database
              .prepare("UPDATE profiles SET status='working' WHERE id=?")
              .run(row.id);
            row.status = 'working';
          }
          return row;
        }),
      retry: (id) =>
        this.execute(() => {
          this.requireChange(
            this.database
              .prepare(
                "UPDATE profiles SET status='new' WHERE id=? AND status='working'",
              )
              .run(id).changes,
          );
        }),
      counts: () =>
        this.execute(() =>
          this.counts('profiles', {
            new: 0,
            working: 0,
            written: 0,
            failed: 0,
          }),
        ),
      rows: () =>
        this.execute(
          () =>
            this.database
              .prepare('SELECT * FROM profiles ORDER BY id')
              .all() as unknown as ProfileRow[],
        ),
    };
    this.messages = {
      save: (profileId, draft) =>
        this.transaction(() => {
          this.requireChange(
            this.database
              .prepare(
                "UPDATE profiles SET status='written' WHERE id=? AND status='working'",
              )
              .run(profileId).changes,
          );
          this.database
            .prepare(
              'INSERT INTO messaging(profile_id,subject,message) VALUES(?,?,?)',
            )
            .run(profileId, draft.subject, draft.body);
        }),
      next: (excluded) =>
        this.execute(
          () =>
            this.database
              .prepare(
                `${this.messageSelect} WHERE m.status='new' ${this.exclude(excluded, 'm.id')} ORDER BY m.id LIMIT 1`,
              )
              .get(...excluded) as unknown as MessageRow | undefined,
        ),
      finish: (id, status, failure = '') =>
        this.execute(() => {
          this.requireChange(
            this.database
              .prepare(
                `UPDATE messaging SET status=?,failure=? WHERE id=? AND ((status='new' AND ? != 'sent') OR (status='failed' AND failure=? AND ?='sent'))`,
              )
              .run(status, failure, id, status, SEND_UNCERTAIN_FAILURE, status)
              .changes,
          );
        }),
      failSend: (id, reason) =>
        this.execute(() => {
          this.requireChange(
            this.database
              .prepare(
                "UPDATE messaging SET failure=? WHERE id=? AND status='failed' AND failure=?",
              )
              .run(reason, id, SEND_UNCERTAIN_FAILURE).changes,
          );
        }),
      counts: () =>
        this.execute(() =>
          this.counts('messaging', { new: 0, sent: 0, failed: 0, dryrun: 0 }),
        ),
      rows: () =>
        this.execute(
          () =>
            this.database
              .prepare(`${this.messageSelect} ORDER BY m.id`)
              .all() as unknown as MessageRow[],
        ),
    };
  }

  private readonly messageSelect =
    'SELECT m.*,p.name,p.role,p.slug FROM messaging m JOIN profiles p ON p.id=m.profile_id';
  private exclude(ids: number[], column = 'id') {
    return ids.length
      ? `AND ${column} NOT IN (${ids.map(() => '?').join(',')})`
      : '';
  }
  private requireChange(changes: number | bigint) {
    if (changes !== 1 && changes !== 1n)
      throw new StorageError(
        'The selected database row is not in the expected state. Stopping.',
      );
  }
  private execute<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError(
        'Database operation failed. Progress is preserved; check the database and local files.',
        { cause: error },
      );
    }
  }
  private transaction<T>(operation: () => T): T {
    return this.execute(() => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    });
  }
  private counts<T extends Record<string, number>>(
    table: 'profiles' | 'messaging',
    initial: T,
  ): T {
    const groups = this.database
      .prepare(`SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status`)
      .all() as unknown as { status: keyof T; count: number }[];
    for (const group of groups)
      initial[group.status] = group.count as T[keyof T];
    return initial;
  }
  resetDryruns(): number {
    return this.execute(() =>
      Number(
        this.database
          .prepare("UPDATE messaging SET status='new' WHERE status='dryrun'")
          .run().changes,
      ),
    );
  }
  clearMessages(): number {
    return this.transaction(() => {
      const removed = Number(
        this.database.prepare('DELETE FROM messaging').run().changes,
      );
      this.database.exec(
        "UPDATE profiles SET status='new' WHERE status='written'",
      );
      return removed;
    });
  }
  clearProfiles(): number {
    return this.transaction(() => {
      this.database.exec('DELETE FROM messaging');
      return Number(
        this.database.prepare('DELETE FROM profiles').run().changes,
      );
    });
  }
  close(): void {
    this.database.close();
  }
}

export async function openQueue(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'a', 0o600);
  await file.close();
  const canonicalPath = await realpath(
    join(await realpath(dirname(path)), basename(path)),
  );
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(canonicalPath, {
      retries: 0,
      stale: 30_000,
      update: 10_000,
    });
  } catch {
    throw new ApplicationError(
      'Cannot lock the queue. Another run may be using it.',
    );
  }
  let repository: Repository;
  try {
    repository = new Repository(canonicalPath);
  } catch (error) {
    await release();
    if (error instanceof ApplicationError) throw error;
    throw new StorageError(
      'Cannot open the SQLite database. Check queue_path and file permissions.',
      { cause: error },
    );
  }
  return {
    repository,
    profiles: repository.profiles,
    messages: repository.messages,
    close: async () => {
      try {
        repository.close();
      } finally {
        await release();
      }
    },
  };
}
