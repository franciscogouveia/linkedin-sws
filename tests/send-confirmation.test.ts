import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmSend,
  type SendState,
} from '../src/infrastructure/linkedin/send-confirmation.ts';
import { SendOutcomeUnknownError } from '../src/shared/errors.ts';

const baseline: SendState = {
  messageCount: 0,
  cleared: false,
  successNotices: 0,
  rejected: false,
};

test('sending requires new message evidence or a new explicit success notice', async () => {
  await confirmSend(
    baseline,
    async () => ({ ...baseline, messageCount: 1, cleared: true }),
    new AbortController().signal,
    1,
  );
  await confirmSend(
    baseline,
    async () => ({ ...baseline, successNotices: 1 }),
    new AbortController().signal,
    1,
  );
  for (const after of [
    { ...baseline, cleared: true },
    { ...baseline, messageCount: 1 },
  ]) {
    await assert.rejects(
      confirmSend(baseline, async () => after, new AbortController().signal, 1),
      (error) => error instanceof SendOutcomeUnknownError,
    );
  }
});

test('previous messages and old toasts do not confirm a new send', async () => {
  const previous = { ...baseline, messageCount: 1, successNotices: 1 };
  await assert.rejects(
    confirmSend(
      previous,
      async () => ({ ...previous, cleared: true }),
      new AbortController().signal,
      1,
    ),
    /did not confirm/,
  );
});

test('explicit rejection and interruption cannot be mistaken for sent', async () => {
  await assert.rejects(
    confirmSend(
      baseline,
      async () => ({ ...baseline, rejected: true, successNotices: 1 }),
      new AbortController().signal,
      1,
    ),
    /send failure/,
  );
  const controller = new AbortController();
  controller.abort(new Error('Browser closed'));
  await assert.rejects(
    confirmSend(
      baseline,
      async () => ({ ...baseline, successNotices: 1 }),
      controller.signal,
      1,
    ),
    /Browser closed/,
  );
});
