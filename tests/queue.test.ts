import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openQueue } from '../src/infrastructure/storage/queue.ts';
import { SEND_UNCERTAIN_FAILURE } from '../src/shared/types.ts';
import { investor, temporaryDirectory } from './helpers.ts';

const draft = { subject: 'Funding Acme', body: 'Could we discuss funding?' };

test('profiles persist, deduplicate slugs, and preserve failed validation', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  assert.equal(first.profiles.append(investor, 'not an investor'), true);
  await first.close();
  const second = await openQueue(path);
  t.after(() => second.close());
  assert.equal(second.profiles.append({ ...investor, name: 'Changed' }), false);
  assert.equal(second.profiles.rows()[0]?.name, investor.name);
  assert.equal(second.profiles.rows()[0]?.failure, 'not an investor');
  assert.equal(second.profiles.next([]), undefined);
});

test('working profiles resume first; excluded retries do not loop in the same run', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  first.profiles.append(investor);
  first.profiles.append({ ...investor, slug: 'later-working' });
  const firstId = first.profiles.next([])!.id;
  const later = first.profiles.next([firstId])!;
  first.profiles.retry(firstId);
  await first.close();
  const second = await openQueue(path);
  t.after(() => second.close());
  assert.equal(second.profiles.next([])?.id, later.id);
  second.profiles.retry(later.id);
  assert.equal(second.profiles.next([later.id])?.id, firstId);
});

test('saving a message atomically marks the profile written and persists a unique recipient', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  first.profiles.append(investor);
  const row = first.profiles.next([])!;
  assert.throws(() => first.messages.save(row.id, { ...draft, subject: '' }));
  assert.equal(first.profiles.rows()[0]?.status, 'working');
  assert.equal(first.messages.rows().length, 0);
  first.messages.save(row.id, draft);
  assert.throws(() => first.messages.save(row.id, draft));
  assert.throws(() => first.messages.save(999, draft));
  await first.close();
  const second = await openQueue(path);
  t.after(() => second.close());
  assert.equal(second.profiles.rows()[0]?.status, 'written');
  assert.equal(second.profiles.next([]), undefined);
  const saved = second.messages.next([])!;
  assert.equal(saved.slug, investor.slug);
  assert.equal(saved.profile_id, row.id);
  assert.equal(saved.message, draft.body);
  assert.equal(saved.subject, draft.subject);
  assert.equal(second.messages.next([saved.id]), undefined);
});

test('one process owns the database lock until release', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  await assert.rejects(openQueue(path), /Cannot lock/);
  await first.close();
  const second = await openQueue(path);
  await second.close();
});

test('sent requires the durable attempt marker, which survives restart and is not retryable', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const first = await openQueue(path);
  first.profiles.append(investor);
  first.messages.save(first.profiles.next([])!.id, draft);
  const row = first.messages.next([])!;
  assert.throws(() => first.messages.finish(row.id, 'sent'));
  assert.throws(() => first.messages.finish(row.id, 'failed'));
  assert.throws(() =>
    first.messages.finish(row.id, 'dryrun', 'unexpected failure'),
  );
  first.messages.finish(row.id, 'failed', SEND_UNCERTAIN_FAILURE);
  await first.close();
  const second = await openQueue(path);
  t.after(() => second.close());
  assert.equal(second.messages.next([]), undefined);
  assert.equal(second.repository.resetDryruns(), 0);
  second.messages.finish(row.id, 'sent');
  assert.equal(second.messages.rows()[0]?.status, 'sent');
  assert.equal(second.messages.rows()[0]?.failure, '');
  assert.throws(() => second.messages.finish(row.id, 'dryrun'));
});

test('reset only requeues dryrun messages; clear messages allows regeneration without revalidating profiles', async (t) => {
  const storage = await openQueue(
    join(await temporaryDirectory(t), 'queue.sqlite'),
  );
  t.after(() => storage.close());
  for (const slug of ['dryrun', 'sent', 'failed', 'pending']) {
    storage.profiles.append({ ...investor, slug });
    storage.messages.save(storage.profiles.next([])!.id, draft);
  }
  storage.profiles.append({ ...investor, slug: 'rejected' }, 'not an investor');
  const rows = storage.messages.rows();
  storage.messages.finish(rows[0]!.id, 'dryrun');
  storage.messages.finish(rows[1]!.id, 'failed', SEND_UNCERTAIN_FAILURE);
  storage.messages.finish(rows[1]!.id, 'sent');
  storage.messages.finish(rows[2]!.id, 'failed', SEND_UNCERTAIN_FAILURE);
  storage.messages.failSend(rows[2]!.id, 'submission failed');
  const before = storage.messages.rows().map((row) => ({ ...row }));
  const profilesBefore = storage.profiles.rows();
  assert.equal(storage.repository.resetDryruns(), 1);
  assert.equal(storage.repository.resetDryruns(), 0);
  assert.deepEqual(
    storage.messages.rows().map((row) => ({ ...row })),
    before.map((row) => ({
      ...row,
      status: row.status === 'dryrun' ? 'new' : row.status,
    })),
  );
  assert.deepEqual(storage.profiles.rows(), profilesBefore);
  assert.throws(() => storage.messages.finish(rows[2]!.id, 'sent'));
  assert.equal(storage.repository.clearMessages(), 4);
  assert.equal(storage.messages.rows().length, 0);
  assert.equal(storage.profiles.counts().new, 4);
  assert.equal(storage.profiles.counts().failed, 1);
  storage.messages.save(storage.profiles.next([])!.id, draft);
  assert.equal(storage.repository.clearProfiles(), 5);
  assert.equal(storage.profiles.rows().length, 0);
  assert.equal(storage.messages.rows().length, 0);
});

test('legacy databases are rejected without migration or modification', async (t) => {
  const path = join(await temporaryDirectory(t), 'queue.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE queue (name TEXT); INSERT INTO queue VALUES ('preserved');",
  );
  legacy.close();
  await assert.rejects(openQueue(path), /Legacy queue database/);
  await assert.rejects(openQueue(path), /Legacy queue database/);
  const check = new DatabaseSync(path);
  t.after(() => check.close());
  assert.equal(
    check.prepare('SELECT name FROM queue').get()?.name,
    'preserved',
  );
  assert.equal(
    check.prepare("SELECT name FROM sqlite_master WHERE name='profiles'").get(),
    undefined,
  );
});
