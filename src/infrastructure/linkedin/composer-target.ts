import { setTimeout } from 'node:timers/promises';
import type { Frame, Page } from 'playwright';
import { ApplicationError } from '../../shared/errors.ts';
import { inspectComposer } from './composer-page.ts';

export function isLinkedInFrame(frame: Frame): boolean {
  const url = frame.url();
  if (url === 'about:blank' || url === 'about:srcdoc') {
    const parent = frame.parentFrame();
    return !!parent && isLinkedInFrame(parent);
  }
  try {
    return ['linkedin.com', 'www.linkedin.com'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function visibleComposerFrames(pages: Page[]): Promise<Frame[]> {
  const result: Frame[] = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      if (!isLinkedInFrame(frame) || frame.isDetached()) continue;
      let visible = true;
      for (
        let current = frame;
        current.parentFrame();
        current = current.parentFrame()!
      ) {
        try {
          const element = await current.frameElement();
          try {
            if (!(await element.isVisible())) visible = false;
          } finally {
            await element.dispose();
          }
        } catch {
          visible = false;
        }
      }
      if (visible) result.push(frame);
    }
  }
  return result;
}

/** Only pages opened by this recipient's Message action are included. */
export async function waitForComposer(
  pages: () => Page[],
  input: { name: string; slug: string; token: string },
  signal: AbortSignal,
  timeout: number,
) {
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const matches = [];
    for (const frame of await visibleComposerFrames(pages())) {
      try {
        const state = await frame.evaluate(inspectComposer, input);
        if (state) matches.push({ frame, state });
      } catch (error) {
        signal.throwIfAborted();
        // Navigating/detaching frames are transient. Other evaluation errors matter.
        if (
          !frame.isDetached() &&
          !(
            error instanceof Error &&
            /execution context was destroyed|cannot find context|frame was detached/i.test(
              error.message,
            )
          )
        )
          throw error;
      }
    }
    if (matches.length > 1)
      throw new ApplicationError(
        'Multiple recipient message composers found. Review the browser.',
      );
    if (matches[0]) return matches[0];
    if (pages().every((page) => page.isClosed()))
      throw new ApplicationError('Recipient message tab was closed.');
    await setTimeout(
      Math.min(100, Math.max(1, deadline - Date.now())),
      undefined,
      { signal },
    );
  } while (Date.now() < deadline);
  throw new ApplicationError(
    `Message action opened no recognized recipient editor in its tab, new tabs, or visible LinkedIn frames within ${timeout} ms.`,
  );
}
