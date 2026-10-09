import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openQueue } from '../src/queue.ts';
import { investor, temporaryDirectory } from './helpers.ts';

test('queue persists completed statuses, deduplicates slugs, and preserves original details', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  assert.equal(first.queue.append(investor), true);
  const row = first.queue.next();
  assert.ok(row);
  first.queue.finish(row.id, 'failed', 'not an investor');
  await first.close();

  const second = await openQueue(path);
  t.after(() => second.close());
  assert.equal(
    second.queue.append({ ...investor, name: 'Changed name' }),
    false,
  );
  assert.equal(second.queue.rows().length, 1);
  assert.equal(second.queue.rows()[0]?.name, investor.name);
  assert.equal(second.queue.rows()[0]?.failure, 'not an investor');
  assert.equal(second.queue.next(), undefined);
});

test('restart resumes working before older new rows, then selects new rows in insertion order', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  first.queue.append(investor);
  first.queue.append({ ...investor, slug: 'second-investor' });
  const interrupted = first.queue.next();
  assert.ok(interrupted);
  assert.equal(interrupted.status, 'working');
  await first.close();
  const second = await openQueue(path);
  t.after(() => second.close());
  assert.equal(second.queue.next()?.id, interrupted.id);
  second.queue.finish(interrupted.id, 'dryrun');
  const next = second.queue.next();
  assert.equal(next?.slug, 'second-investor');
  assert.ok(next);
  second.queue.finish(next.id, 'dryrun');
  assert.equal(second.queue.next(), undefined);
});

test('an active queue refuses a second process owner and becomes available after release', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  await assert.rejects(openQueue(path), /Cannot lock/);
  assert.equal(first.queue.rows().length, 0);
  await first.close();
  const second = await openQueue(path);
  await second.close();
});

test('a later working row takes priority over an earlier new row', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const original = await openQueue(path);
  original.queue.append(investor);
  original.queue.append({ ...investor, slug: 'later-working' });
  await original.close();
  const fixture = new DatabaseSync(path);
  fixture.exec(
    "UPDATE queue SET status = 'working' WHERE slug = 'later-working'",
  );
  fixture.close();
  const restarted = await openQueue(path);
  t.after(() => restarted.close());
  const row = restarted.queue.next();
  assert.ok(row);
  assert.equal(row.slug, 'later-working');
  restarted.queue.finish(row.id, 'dryrun');
  assert.equal(restarted.queue.next()?.slug, investor.slug);
});

test('queue refuses invalid failure reasons and completion of terminal rows', async (t) => {
  const storage = await openQueue(
    join(await temporaryDirectory(t), 'queue.sqlite'),
  );
  t.after(() => storage.close());
  storage.queue.append(investor);
  const row = storage.queue.next();
  assert.ok(row);
  assert.throws(() => storage.queue.finish(row.id, 'failed'));
  assert.throws(() =>
    storage.queue.finish(row.id, 'dryrun', 'unexpected failure'),
  );
  storage.queue.finish(row.id, 'failed', 'not an investor');
  assert.throws(
    () => storage.queue.finish(row.id, 'dryrun'),
    /no longer working/,
  );
});

test('resetting dryruns persists only dryrun-to-new changes and preserves other statuses and details', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const fixture = await openQueue(path);
  const statuses = ['dryrun', 'dryrun', 'failed', 'sent', 'working', 'new'];
  for (let i = 0; i < statuses.length; i++) {
    fixture.queue.append({ ...investor, slug: `profile-${i}` });
  }
  await fixture.close();
  const database = new DatabaseSync(path);
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    database
      .prepare('UPDATE queue SET status = ?, failure = ? WHERE slug = ?')
      .run(
        status!,
        status === 'failed' ? 'not an investor' : '',
        `profile-${i}`,
      );
  }
  database.close();
  const storage = await openQueue(path);
  const before = storage.queue.rows();
  assert.equal(storage.queue.resetDryruns(), 2);
  assert.equal(storage.queue.resetDryruns(), 0);
  await storage.close();
  const reopened = await openQueue(path);
  t.after(() => reopened.close());
  assert.deepEqual(
    reopened.queue.rows().map((row) => ({ ...row })),
    before.map((row) => ({
      ...row,
      status: row.status === 'dryrun' ? 'new' : row.status,
    })),
  );
});
