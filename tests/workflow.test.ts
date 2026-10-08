import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { openQueue } from '../src/queue.ts';
import { runDryRun } from '../src/workflow.ts';
import type { LinkedInReader, PitchWriter } from '../src/types.ts';
import {
  investor,
  profile,
  temporaryDirectory,
  testConfig,
} from './helpers.ts';

async function setup(t: Parameters<typeof temporaryDirectory>[0]) {
  const directory = await temporaryDirectory(t);
  const storage = await openQueue(join(directory, 'queue.sqlite'));
  t.after(() => storage.close());
  const generated: { profile: string; pitch: string }[] = [];
  const output: string[] = [];
  const linkedin: LinkedInReader = {
    search: async (_criteria, onResult) => {
      onResult(investor);
      return 1;
    },
    readProfile: async () => profile,
  };
  const writer: PitchWriter = {
    classify: async () => ({
      decision: 'investor',
      evidence: investor.role,
      reason: 'Explicit investor headline.',
    }),
    write: async (inputProfile, pitch) => {
      generated.push({ profile: inputProfile.slug, pitch });
      return 'Hello Alex, could we discuss funding our business?';
    },
  };
  const options = {
    config: testConfig(directory),
    pitch: 'Our verified business pitch',
    queue: storage.queue,
    linkedin,
    writer,
    output: async (text: string) => {
      output.push(text);
    },
    log: (_text: string) => {},
    signal: new AbortController().signal,
  };
  return { storage, options, generated, output };
}

test('dry run generates with profile and startup pitch, prints once, and skips completed rows on rerun', async (t) => {
  const { storage, options, generated, output } = await setup(t);
  let suppliedName: string | undefined;
  options.linkedin.readProfile = async (_slug, name) => {
    suppliedName = name;
    return profile;
  };
  const result = await runDryRun(options);
  assert.equal(suppliedName, investor.name);
  assert.equal(result.displayed, 1);
  assert.deepEqual(generated, [
    { profile: investor.slug, pitch: options.pitch },
  ]);
  assert.match(output[0] ?? '', /Hello Alex/);
  assert.match(output[0] ?? '', /alex-example/);
  assert.equal(storage.queue.rows()[0]?.status, 'dryrun');
  assert.equal((await runDryRun(options)).processed, 0);
  assert.equal(output.length, 1);
});

test('missing profiles and negative or uncertain assessments fail without generating messages', async (t) => {
  for (const decision of ['missing', 'not_investor', 'uncertain'] as const) {
    await t.test(decision, async (t) => {
      const { storage, options, generated, output } = await setup(t);
      if (decision === 'missing')
        options.linkedin.readProfile = async () => null;
      else
        options.writer.classify = async () => ({
          decision,
          evidence: '',
          reason: 'Insufficient evidence.',
        });
      await runDryRun(options);
      const expected =
        decision === 'missing'
          ? 'invalid slug, profile not found'
          : decision === 'not_investor'
            ? 'not an investor'
            : 'investor status uncertain';
      assert.equal(storage.queue.rows()[0]?.status, 'failed');
      assert.equal(storage.queue.rows()[0]?.failure, expected);
      assert.equal(generated.length, 0);
      assert.equal(output.length, 0);
      assert.equal((await runDryRun(options)).processed, 0);
    });
  }
});

test('browser, LLM, and output failures preserve working rows for a later restart', async (t) => {
  for (const stage of ['profile', 'classify', 'write', 'output'] as const) {
    await t.test(stage, async (t) => {
      const { storage, options } = await setup(t);
      const fail = async (): Promise<never> => {
        throw new Error('Required service unavailable');
      };
      if (stage === 'profile') options.linkedin.readProfile = fail;
      if (stage === 'classify') options.writer.classify = fail;
      if (stage === 'write') options.writer.write = fail;
      if (stage === 'output') options.output = fail;
      await assert.rejects(runDryRun(options), /unavailable/);
      assert.equal(storage.queue.rows()[0]?.status, 'working');
      assert.equal(storage.queue.rows()[0]?.failure, '');
    });
  }
});

test('search interruption retains already discovered rows without beginning profile processing', async (t) => {
  const { storage, options } = await setup(t);
  options.linkedin.search = async (_criteria, onResult) => {
    onResult(investor);
    throw new Error('Checkpoint');
  };
  await assert.rejects(runDryRun(options), /Checkpoint/);
  assert.equal(storage.queue.rows()[0]?.status, 'new');
});

test('dry-run output removes terminal escape sequences from scraped and generated content', async (t) => {
  const { options, output } = await setup(t);
  options.writer.write = async () => '\x1b[31mHello\x1b[0m\x00';
  await runDryRun(options);
  assert.ok(!output[0]?.includes('\x1b'));
  assert.ok(!output[0]?.includes('\x00'));
  assert.match(output[0] ?? '', /Hello/);
});
