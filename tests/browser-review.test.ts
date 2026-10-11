import assert from 'node:assert/strict';
import test from 'node:test';
import { withBrowserReview } from '../src/app/browser-review.ts';
import { ApplicationError } from '../src/shared/errors.ts';

function browserFixture() {
  let close!: () => void;
  let isClosed = false;
  const closed = new Promise<void>((resolve) => {
    close = () => {
      isClosed = true;
      resolve();
    };
  });
  return { closed, isClosed: () => isClosed, close };
}

test('successful batch waits for browser closure and prints the exact instruction', async () => {
  const browser = browserFixture();
  const controller = new AbortController();
  let completed = false;
  const logs: string[] = [];
  const task = withBrowserReview(
    browser,
    controller,
    async () => {},
    (text) => logs.push(text),
  ).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(logs, ['Waiting for browser to be closed by the user']);
  browser.close();
  await task;
  assert.equal(controller.signal.aborted, false);
});

test('processing errors remain visible until closure and then propagate', async () => {
  const browser = browserFixture();
  const logs: string[] = [];
  const error = new ApplicationError('Existing draft preserved');
  const task = withBrowserReview(
    browser,
    new AbortController(),
    async () => {
      throw error;
    },
    (text) => logs.push(text),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs, [
    'Existing draft preserved',
    'Waiting for browser to be closed by the user',
  ]);
  browser.close();
  await assert.rejects(task, (actual) => actual === error);
});

test('closing the browser during processing aborts unfinished work', async () => {
  const browser = browserFixture();
  const controller = new AbortController();
  await assert.rejects(
    withBrowserReview(
      browser,
      controller,
      async () => {
        browser.close();
        await new Promise((resolve) => setImmediate(resolve));
        controller.signal.throwIfAborted();
      },
      () => {},
    ),
    /Browser closed before draft preparation finished/,
  );
});

test('emergency interruption cancels the review wait', async () => {
  const browser = browserFixture();
  const controller = new AbortController();
  const task = withBrowserReview(
    browser,
    controller,
    async () => {},
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new ApplicationError('Interrupted'));
  await assert.rejects(task, /Interrupted/);
  browser.close();
});
