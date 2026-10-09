import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import lockfile from 'proper-lockfile';
import { ApplicationError } from '../../shared/errors.ts';
import type {
  Investor,
  QueueRow,
  QueueStatus,
  QueueStore,
} from '../../shared/types.ts';

export class Queue implements QueueStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'new'
          CHECK (status IN ('new', 'working', 'sent', 'failed', 'dryrun')),
        failure TEXT NOT NULL DEFAULT '',
        CHECK ((status = 'failed' AND length(failure) > 0)
          OR (status != 'failed' AND failure = ''))
      ) STRICT;
    `);
  }

  append(investor: Investor): boolean {
    const result = this.database
      .prepare(
        `INSERT INTO queue (name, role, slug) VALUES (?, ?, ?)
        ON CONFLICT(slug) DO NOTHING`,
      )
      .run(investor.name, investor.role, investor.slug);
    return result.changes === 1;
  }

  next(): QueueRow | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM queue WHERE status IN ('working', 'new')
          ORDER BY CASE status WHEN 'working' THEN 0 ELSE 1 END, id LIMIT 1`,
        )
        .get() as unknown as QueueRow | undefined;
      if (row?.status === 'new') {
        this.database
          .prepare(
            "UPDATE queue SET status = 'working' WHERE id = ? AND status = 'new'",
          )
          .run(row.id);
        row.status = 'working';
      }
      this.database.exec('COMMIT');
      return row;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  finish(id: number, status: 'failed' | 'dryrun', failure = ''): void {
    const result = this.database
      .prepare(
        "UPDATE queue SET status = ?, failure = ? WHERE id = ? AND status = 'working'",
      )
      .run(status, failure, id);
    if (result.changes !== 1) {
      throw new ApplicationError(
        'The selected queue row is no longer working. Stopping.',
      );
    }
  }

  resetDryruns(): number {
    return Number(
      this.database
        .prepare("UPDATE queue SET status = 'new' WHERE status = 'dryrun'")
        .run().changes,
    );
  }

  counts(): Record<QueueStatus, number> {
    const counts = { new: 0, working: 0, sent: 0, failed: 0, dryrun: 0 };
    const groups = this.database
      .prepare('SELECT status, COUNT(*) AS count FROM queue GROUP BY status')
      .all() as unknown as { status: QueueStatus; count: number }[];
    for (const group of groups) counts[group.status] = group.count;
    return counts;
  }

  rows(): QueueRow[] {
    return this.database
      .prepare('SELECT * FROM queue ORDER BY id')
      .all() as unknown as QueueRow[];
  }

  close(): void {
    this.database.close();
  }
}

export async function openQueue(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'a', 0o600);
  await file.close();
  // Canonicalize to prevent two aliases of one database from acquiring different locks.
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
  let queue: Queue;
  try {
    queue = new Queue(canonicalPath);
  } catch {
    await release();
    throw new ApplicationError(
      'Cannot open the SQLite queue. Check queue_path and file permissions.',
    );
  }
  return {
    queue,
    close: async () => {
      try {
        queue.close();
      } finally {
        await release();
      }
    },
  };
}
