import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { runWorkflow } from '../src/app/workflow.ts';
import { runSearch } from '../src/search/workflow.ts';
import { runWrite } from '../src/writing/workflow.ts';
import { runSend } from '../src/communication/workflow.ts';
import { openQueue } from '../src/infrastructure/storage/queue.ts';
import {
  ApplicationError,
  DraftVerificationError,
  LinkedInSessionError,
  StorageError,
} from '../src/shared/errors.ts';
import type {
  Investor,
  LinkedInReader,
  PitchWriter,
  MessageDraft,
  MessageComposer,
} from '../src/shared/types.ts';
import { SEND_UNCERTAIN_FAILURE } from '../src/shared/types.ts';
import {
  investor,
  profile,
  temporaryDirectory,
  testConfig,
} from './helpers.ts';
import type { TestContext } from 'node:test';

async function fixture(t: TestContext) {
  const directory = await temporaryDirectory(t);
  const storage = await openQueue(join(directory, 'queue.sqlite'));
  t.after(() => storage.close());
  const logs: string[] = [];
  const outputs: string[] = [];
  const config = { ...testConfig(directory), max_profiles_per_run: 10 };
  const controller = new AbortController();
  const linkedin: LinkedInReader = {
    search: async (_criteria, onResult) => {
      onResult(investor);
      return 1;
    },
    readProfile: async (slug) => ({ ...profile, slug }),
  };
  const writer: PitchWriter = {
    classify: async () => ({
      decision: 'investor',
      evidence: investor.role,
      reason: 'Explicit angel investor',
    }),
    write: async () => 'Hello Alex, could we discuss funding?',
    writeSubject: async () => 'Funding Acme',
  };
  const options = {
    config,
    profiles: storage.profiles,
    messages: storage.messages,
    linkedin,
    writer,
    pitch: 'Acme builds software.',
    log: (text: string) => logs.push(text),
    output: async (text: string) => {
      outputs.push(text);
    },
    signal: controller.signal,
  };
  function seed(count = 1) {
    for (let i = 0; i < count; i++)
      storage.profiles.append({ ...investor, slug: `investor-${i}` });
  }
  function seedMessages(count = 1) {
    seed(count);
    for (let i = 0; i < count; i++)
      storage.messages.save(storage.profiles.next([])!.id, {
        subject: 'Funding Acme',
        body: 'Hello Alex, could we discuss funding?',
      });
  }
  return { storage, logs, outputs, options, controller, seed, seedMessages };
}

test('full pipeline validates once, saves subject and body, and delivers saved messages', async (t) => {
  const f = await fixture(t);
  let classifications = 0;
  let reads = 0;
  f.options.linkedin.readProfile = async () => {
    reads++;
    return { ...profile };
  };
  f.options.writer.classify = async (p) => {
    classifications++;
    assert.equal(p.searchRole, investor.role);
    return {
      decision: 'investor',
      reason: 'Angel Investor',
      evidence: investor.role,
    };
  };
  const result = await runWorkflow(f.options);
  assert.equal(result.search.accepted, 1);
  assert.equal(result.write.written, 1);
  assert.equal(result.send.completed, 1);
  assert.equal(classifications, 1);
  assert.equal(reads, 2);
  assert.equal(f.storage.profiles.rows()[0]?.status, 'written');
  assert.equal(f.storage.messages.rows()[0]?.status, 'dryrun');
  assert.match(f.outputs[0]!, /Subject: Funding Acme/);
  assert.match(f.outputs[0]!, /Hello Alex/);
});

test('search finishes discovery before validation, saves all failures, and skips existing slugs', async (t) => {
  const f = await fixture(t);
  const candidates = [
    'accepted',
    'rejected',
    'uncertain',
    'missing',
    'broken',
  ].map((slug) => ({ ...investor, slug }));
  let discoveryFinished = false;
  f.options.linkedin.search = async (_criteria, onResult) => {
    for (const row of candidates) onResult(row);
    onResult(candidates[0]!);
    discoveryFinished = true;
    return 5;
  };
  f.options.linkedin.readProfile = async (slug) => {
    assert.equal(discoveryFinished, true);
    if (slug === 'missing') return null;
    if (slug === 'broken') throw new ApplicationError('Network failure');
    return { ...profile, slug };
  };
  f.options.writer.classify = async (p) => ({
    decision:
      p.slug === 'accepted'
        ? 'investor'
        : p.slug === 'rejected'
          ? 'not_investor'
          : 'uncertain',
    reason: 'classification reason',
    evidence: '',
  });
  assert.deepEqual(await runSearch(f.options), {
    discovered: 5,
    accepted: 1,
    failed: 4,
    skipped: 0,
  });
  assert.equal(f.storage.profiles.counts().failed, 4);
  assert.equal(
    f.storage.profiles.rows().find((p) => p.slug === 'missing')?.failure,
    'invalid slug, profile not found',
  );
  assert.match(
    f.storage.profiles.rows().find((p) => p.slug === 'rejected')!.failure,
    /not an investor/,
  );
  assert.equal(
    f.storage.profiles.rows().find((p) => p.slug === 'broken')?.failure,
    'Network failure',
  );
  assert.equal((await runSearch(f.options)).skipped, 5);
  assert.equal(f.storage.messages.rows().length, 0);
});

test('write skips generation failures once per invocation and retries them next time', async (t) => {
  const f = await fixture(t);
  f.seed(3);
  let calls = 0;
  f.options.writer.write = async (p) => {
    calls++;
    if (p.slug === 'investor-0') throw new ApplicationError('LLM timed out');
    return 'Funding pitch';
  };
  f.options.writer.classify = async () => {
    throw new Error('Write must not classify');
  };
  assert.deepEqual(await runWrite(f.options), { processed: 3, written: 2 });
  assert.equal(calls, 3);
  assert.equal(f.storage.profiles.rows()[0]?.status, 'new');
  assert.equal(f.storage.messages.rows().length, 2);
  f.options.writer.write = async () => 'Retried funding pitch';
  assert.deepEqual(await runWrite(f.options), { processed: 1, written: 1 });
  assert.equal(f.storage.messages.rows().length, 3);
});

test('subject generation failure saves no partial message and remains retryable', async (t) => {
  const f = await fixture(t);
  f.seed();
  f.options.writer.writeSubject = async () => {
    throw new ApplicationError('Subject timed out');
  };
  await runWrite(f.options);
  assert.equal(f.storage.profiles.rows()[0]?.status, 'new');
  assert.equal(f.storage.messages.rows().length, 0);
});

test('write interruption leaves working profile resumable; database errors stop processing', async (t) => {
  const f = await fixture(t);
  f.seed(2);
  f.options.writer.write = async () => {
    f.controller.abort(new ApplicationError('Interrupted'));
    return 'Body';
  };
  await assert.rejects(runWrite(f.options), /Interrupted/);
  assert.equal(f.storage.profiles.rows()[0]?.status, 'working');
  assert.equal(f.storage.profiles.rows()[1]?.status, 'new');
  const nextOptions = {
    ...f.options,
    signal: new AbortController().signal,
    writer: { ...f.options.writer, write: async () => 'Body' },
    messages: {
      ...f.options.messages,
      save: () => {
        throw new StorageError('Database failed');
      },
    },
  };
  await assert.rejects(runWrite(nextOptions), /Database failed/);
  assert.equal(f.storage.profiles.rows()[0]?.status, 'working');
});

test('write and send independently respect attempt limits and preserve unprocessed rows', async (t) => {
  const f = await fixture(t);
  f.seed(3);
  f.options.config.max_profiles_per_run = 2;
  assert.equal((await runWrite(f.options)).processed, 2);
  assert.equal(f.storage.profiles.counts().new, 1);
  f.options.config.max_profiles_per_run = 1;
  assert.equal((await runSend(f.options)).processed, 1);
  assert.equal(f.storage.messages.counts().new, 1);
});

test('terminal send uses only saved text without browser, profile reader, or LLM', async (t) => {
  const f = await fixture(t);
  f.seedMessages(2);
  const result = await runSend({
    config: f.options.config,
    messages: f.storage.messages,
    log: f.options.log,
    output: f.options.output,
    signal: f.options.signal,
  });
  assert.equal(result.completed, 2);
  assert.equal(f.outputs.length, 2);
  assert.equal(f.storage.profiles.counts().written, 2);
  assert.equal((await runSend(f.options)).processed, 0);
  f.storage.repository.resetDryruns();
  assert.equal((await runSend(f.options)).completed, 2);
});

for (const mode of ['dryrun-browser', 'live'] as const) {
  test(`${mode} preparation failure continues and remains new; InMail receives stored subject`, async (t) => {
    const f = await fixture(t);
    f.seedMessages(3);
    const filled: MessageDraft[] = [];
    const messenger = {
      openComposer: async (recipient: Investor): Promise<MessageComposer> => ({
        kind: 'inmail',
        fill: async (draft) => {
          if (recipient.slug === 'investor-0')
            throw new DraftVerificationError('Wrong text');
          filled.push(draft);
        },
        send: async (beforeClick) => {
          beforeClick();
        },
      }),
    };
    const result = await runSend({
      ...f.options,
      config: { ...f.options.config, mode },
      messenger,
    });
    assert.equal(result.processed, 3);
    assert.equal(result.completed, 2);
    assert.equal(result.skipped, 1);
    assert.equal(f.storage.messages.rows()[0]?.status, 'new');
    assert.deepEqual(filled[0], {
      body: 'Hello Alex, could we discuss funding?',
      subject: 'Funding Acme',
    });
    assert.equal(
      f.storage.messages.rows()[1]?.status,
      mode === 'live' ? 'sent' : 'dryrun',
    );
  });
}

test('chat omits subject and browser dryrun never submits', async (t) => {
  const f = await fixture(t);
  f.seedMessages();
  await runSend({
    ...f.options,
    config: { ...f.options.config, mode: 'dryrun-browser' },
    messenger: {
      openComposer: async () => ({
        kind: 'chat',
        fill: async (draft) => {
          assert.equal(draft.subject, undefined);
        },
        send: async () => {
          throw new Error('Must not send');
        },
      }),
    },
  });
  assert.equal(f.storage.messages.rows()[0]?.status, 'dryrun');
});

test('submission failure persists a nonretryable failed row, then processes the next message', async (t) => {
  const f = await fixture(t);
  f.seedMessages(2);
  let clicks = 0;
  const messenger = {
    openComposer: async (recipient: Investor): Promise<MessageComposer> => ({
      kind: 'chat',
      fill: async () => {},
      send: async (beforeClick) => {
        beforeClick();
        assert.equal(
          f.storage.messages.rows().find((r) => r.slug === recipient.slug)
            ?.failure,
          SEND_UNCERTAIN_FAILURE,
        );
        clicks++;
        if (recipient.slug === 'investor-0')
          throw new ApplicationError('Confirmation timed out');
      },
    }),
  };
  assert.equal(
    (
      await runSend({
        ...f.options,
        config: { ...f.options.config, mode: 'live' },
        messenger,
      })
    ).failed,
    1,
  );
  assert.equal(clicks, 2);
  assert.equal(f.storage.messages.rows()[0]?.status, 'failed');
  assert.match(f.storage.messages.rows()[0]!.failure, /Confirmation timed out/);
  assert.equal(f.storage.messages.rows()[1]?.status, 'sent');
  assert.equal(
    (
      await runSend({
        ...f.options,
        config: { ...f.options.config, mode: 'live' },
        messenger,
      })
    ).processed,
    0,
  );
});

test('account checkpoints stop search, write, and send rather than skipping the batch', async (t) => {
  const f = await fixture(t);
  const failure = new LinkedInSessionError('Account checkpoint');
  f.options.linkedin.readProfile = async () => {
    throw failure;
  };
  await assert.rejects(runSearch(f.options), /Account checkpoint/);
  assert.equal(f.storage.profiles.rows().length, 0);
  f.seed(2);
  await assert.rejects(runWrite(f.options), /Account checkpoint/);
  assert.equal(f.storage.profiles.rows()[0]?.status, 'working');
  f.storage.messages.save(f.storage.profiles.next([])!.id, {
    body: 'Pitch',
    subject: 'Funding',
  });
  await assert.rejects(
    runSend({
      ...f.options,
      config: { ...f.options.config, mode: 'live' },
      messenger: {
        openComposer: async () => {
          throw failure;
        },
      },
    }),
    /Account checkpoint/,
  );
  assert.equal(f.storage.messages.rows()[0]?.status, 'new');
});

test('interruption after clicking leaves a durable failed marker and stops later messages', async (t) => {
  const f = await fixture(t);
  f.seedMessages(2);
  await assert.rejects(
    runSend({
      ...f.options,
      config: { ...f.options.config, mode: 'live' },
      messenger: {
        openComposer: async () => ({
          kind: 'chat',
          fill: async () => {},
          send: async (beforeClick) => {
            beforeClick();
            f.controller.abort(new ApplicationError('Interrupted'));
            throw new ApplicationError('Interrupted');
          },
        }),
      },
    }),
    /Interrupted/,
  );
  assert.equal(f.storage.messages.rows()[0]?.failure, SEND_UNCERTAIN_FAILURE);
  assert.equal(f.storage.messages.rows()[1]?.status, 'new');
});

test('terminal output failure remains new and does not block the following message', async (t) => {
  const f = await fixture(t);
  f.seedMessages(2);
  let outputs = 0;
  const result = await runSend({
    ...f.options,
    output: async () => {
      if (++outputs === 1) throw new Error('Output unavailable');
    },
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.completed, 1);
  assert.equal(f.storage.messages.rows()[0]?.status, 'new');
  assert.equal(f.storage.messages.rows()[1]?.status, 'dryrun');
});

test('send does not click when saving the durable attempt fails', async (t) => {
  const f = await fixture(t);
  f.seedMessages(2);
  let clicks = 0;
  const messenger = {
    openComposer: async (): Promise<MessageComposer> => ({
      kind: 'chat',
      fill: async () => {},
      send: async (beforeClick) => {
        beforeClick();
        clicks++;
      },
    }),
  };
  await assert.rejects(
    runSend({
      ...f.options,
      config: { ...f.options.config, mode: 'live' },
      messages: {
        ...f.storage.messages,
        finish: () => {
          throw new StorageError('Cannot persist attempt');
        },
      },
      messenger,
    }),
    /Cannot persist attempt/,
  );
  assert.equal(clicks, 0);
  assert.equal(f.storage.messages.counts().new, 2);
});

test('send delivers stored text without repeating writing-stage content validation', async (t) => {
  const f = await fixture(t);
  f.seedMessages();
  const row = f.storage.messages.next([])!;
  let filled = '';
  const result = await runSend({
    ...f.options,
    config: { ...f.options.config, mode: 'dryrun-browser' },
    messages: {
      ...f.storage.messages,
      next: (excluded) =>
        excluded.includes(row.id)
          ? undefined
          : { ...row, message: '[Your Name]' },
    },
    messenger: {
      openComposer: async () => ({
        kind: 'chat',
        fill: async (draft) => {
          filled = draft.body;
        },
      }),
    },
  });
  assert.equal(filled, '[Your Name]');
  assert.equal(result.completed, 1);
  assert.equal(f.storage.messages.rows()[0]?.status, 'dryrun');
});
