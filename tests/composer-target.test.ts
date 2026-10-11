import assert from 'node:assert/strict';
import test from 'node:test';
import type { Frame, Page } from 'playwright';
import {
  isLinkedInFrame,
  visibleComposerFrames,
  waitForComposer,
} from '../src/infrastructure/linkedin/composer-target.ts';
import { investor } from './helpers.ts';

function frameFixture(
  url: string,
  parent: Frame | null = null,
  visible = true,
  state: unknown = false,
) {
  let disposed = false;
  const frame = {
    url: () => url,
    parentFrame: () => parent,
    isDetached: () => false,
    frameElement: async () => ({
      isVisible: async () => visible,
      dispose: async () => {
        disposed = true;
      },
    }),
    evaluate: async () => state,
  } as unknown as Frame;
  return { frame, disposed: () => disposed };
}
function pageFixture(frames: Frame[]) {
  return { isClosed: () => false, frames: () => frames } as unknown as Page;
}
const input = { name: investor.name, slug: investor.slug, token: 'test-token' };

test('composer frame selection excludes external and hidden frames, including hidden ancestors', async () => {
  const top = frameFixture('https://www.linkedin.com/in/alex-example/');
  const hidden = frameFixture(
    'https://www.linkedin.com/messaging/',
    top.frame,
    false,
  );
  const nested = frameFixture('about:srcdoc', hidden.frame);
  const visible = frameFixture('about:blank', top.frame);
  const external = frameFixture(
    'https://www.linkedin.com.evil.example/messaging/',
    top.frame,
  );
  assert.equal(isLinkedInFrame(external.frame), false);
  assert.equal(isLinkedInFrame(visible.frame), true);
  assert.deepEqual(
    await visibleComposerFrames([
      pageFixture([
        top.frame,
        hidden.frame,
        nested.frame,
        visible.frame,
        external.frame,
      ]),
    ]),
    [top.frame, visible.frame],
  );
  assert.equal(hidden.disposed(), true);
  assert.equal(visible.disposed(), true);
});

test('composer wait can find a recipient editor in a frame or recipient popup', async () => {
  const top = frameFixture('https://www.linkedin.com/in/alex-example/');
  const embedded = frameFixture(
    'https://www.linkedin.com/messaging/thread/',
    top.frame,
    true,
    { kind: 'chat' },
  );
  const page = pageFixture([top.frame, embedded.frame]);
  assert.equal(
    (
      await waitForComposer(
        () => [page],
        input,
        new AbortController().signal,
        100,
      )
    ).frame,
    embedded.frame,
  );
  const popup = frameFixture(
    'https://www.linkedin.com/messaging/thread/',
    null,
    true,
    { kind: 'inmail' },
  );
  assert.equal(
    (
      await waitForComposer(
        () => [pageFixture([top.frame]), pageFixture([popup.frame])],
        input,
        new AbortController().signal,
        100,
      )
    ).frame,
    popup.frame,
  );
});

test('multiple composer targets fail rather than choosing one', async () => {
  const first = frameFixture(
    'https://www.linkedin.com/messaging/',
    null,
    true,
    { kind: 'chat' },
  );
  const second = frameFixture(
    'https://www.linkedin.com/messaging/',
    null,
    true,
    { kind: 'chat' },
  );
  await assert.rejects(
    waitForComposer(
      () => [pageFixture([first.frame, second.frame])],
      input,
      new AbortController().signal,
      100,
    ),
    /Multiple recipient message composers/,
  );
});

test('composer wait is bounded and responds to interruption', async () => {
  const frame = frameFixture('https://www.linkedin.com/in/alex-example/');
  const pages = () => [pageFixture([frame.frame])];
  await assert.rejects(
    waitForComposer(pages, input, new AbortController().signal, 1),
    /within 1 ms/,
  );
  const controller = new AbortController();
  controller.abort(new Error('Browser closed'));
  await assert.rejects(
    waitForComposer(pages, input, controller.signal, 100),
    /Browser closed/,
  );
});
