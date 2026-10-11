import assert from 'node:assert/strict';
import test from 'node:test';
import {
  draftTextMatches,
  verifyDraft,
} from '../src/infrastructure/linkedin/draft-verification.ts';

test('draft text accepts rich-text whitespace but rejects missing or changed content', () => {
  const expected = 'Hello Alex,\n\nPlease consider Acme.\nSam';
  for (const actual of [
    expected,
    'Hello Alex,\nPlease consider Acme.\n\nSam\n',
    'Hello\u00a0Alex,\r\n\r\nPlease consider Acme.\r\nSam ',
  ])
    assert.ok(draftTextMatches(actual, expected));
  for (const actual of [
    'Hello Alex, Please consider Acme.',
    'Hello Alex, Please consider Beta. Sam',
    'Hello Alex, Please consider Acme! Sam',
    'hello Alex, Please consider Acme. Sam',
  ])
    assert.ok(!draftTextMatches(actual, expected));
});

test('verification accepts rendered paragraphs and separately checks the InMail subject', async () => {
  await verifyDraft(
    { body: 'Hello Alex,\n\nFunding Acme.', subject: 'Funding Acme' },
    async () => ({
      recipientVerified: true,
      body: 'Hello Alex,\nFunding\u00a0Acme.\n',
      subject: 'Funding Acme',
    }),
    new AbortController().signal,
  );
  await assert.rejects(
    verifyDraft(
      { body: 'Hello Alex', subject: 'Funding Acme' },
      async () => ({
        recipientVerified: true,
        body: 'Hello Alex',
        subject: 'Funding Beta',
      }),
      new AbortController().signal,
      1,
    ),
    /InMail subject differs/,
  );
});

test('verification retries asynchronous rendering, without accepting a changed recipient', async () => {
  let reads = 0;
  await verifyDraft(
    { body: 'Funding Acme' },
    async () => ({
      recipientVerified: true,
      body: ++reads === 1 ? '' : 'Funding Acme',
    }),
    new AbortController().signal,
    500,
  );
  assert.equal(reads, 2);
  await assert.rejects(
    verifyDraft(
      { body: 'Funding Acme' },
      async () => ({ recipientVerified: false, body: 'Funding Acme' }),
      new AbortController().signal,
      1,
    ),
    /recipient or composer layout/,
  );
});

test('body mismatch diagnostics give lengths without logging draft text', async () => {
  await assert.rejects(
    verifyDraft(
      { body: 'Private pitch' },
      async () => ({ recipientVerified: true, body: 'Changed private pitch' }),
      new AbortController().signal,
      1,
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /message body differs/);
      assert.ok(!error.message.includes('Private pitch'));
      assert.ok(!error.message.includes('Changed private pitch'));
      return true;
    },
  );
});

test('unreadable prepared fields are a per-profile verification error; interruption still aborts', async () => {
  const { DraftVerificationError } = await import('../src/shared/errors.ts');
  await assert.rejects(
    verifyDraft(
      { body: 'Funding Acme' },
      async () => {
        throw new Error('Editor detached');
      },
      new AbortController().signal,
      1,
    ),
    (error) => error instanceof DraftVerificationError,
  );
  const controller = new AbortController();
  await assert.rejects(
    verifyDraft(
      { body: 'Funding Acme' },
      async () => {
        controller.abort(new Error('Browser closed'));
        throw new Error('Editor detached');
      },
      controller.signal,
      1,
    ),
    /Browser closed/,
  );
});
