import { ApplicationError } from '../shared/errors.ts';

/** Keeps drafts and failures visible, while browser closure cancels active work. */
export async function withBrowserReview(
  browser: { closed: Promise<void>; isClosed(): boolean },
  controller: AbortController,
  work: () => Promise<unknown>,
  log: (text: string) => void,
): Promise<void> {
  let processing = true;
  void browser.closed.then(() => {
    if (processing && !controller.signal.aborted)
      controller.abort(
        new ApplicationError(
          'Browser closed before draft preparation finished. Queue progress is preserved.',
        ),
      );
  });
  let failure: unknown;
  let failed = false;
  try {
    await work();
  } catch (error) {
    failed = true;
    failure = error;
    if (!controller.signal.aborted)
      log(
        error instanceof ApplicationError
          ? error.message
          : 'Draft preparation stopped unexpectedly. Queue progress is preserved.',
      );
  } finally {
    processing = false;
  }
  controller.signal.throwIfAborted();
  if (!browser.isClosed()) {
    log('Waiting for browser to be closed by the user');
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      void browser.closed.then(() => {
        controller.signal.removeEventListener('abort', abort);
        resolve();
      });
      if (controller.signal.aborted) abort();
    });
  }
  controller.signal.throwIfAborted();
  if (failed) throw failure;
}
