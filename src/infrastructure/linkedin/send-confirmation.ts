import { setTimeout } from 'node:timers/promises';
import { SendOutcomeUnknownError } from '../../shared/errors.ts';

export interface SendState {
  messageCount: number;
  cleared: boolean;
  successNotices: number;
  rejected: boolean;
}

/** An empty composer alone is insufficient proof that Send succeeded. */
export async function confirmSend(
  before: SendState,
  read: () => Promise<SendState>,
  signal: AbortSignal,
  timeout: number,
): Promise<void> {
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const after = await read();
    signal.throwIfAborted();
    if (after.rejected)
      throw new SendOutcomeUnknownError(
        'LinkedIn reported a send failure. Verify the conversation before retrying.',
      );
    if (
      after.successNotices > before.successNotices ||
      (after.cleared && after.messageCount > before.messageCount)
    )
      return;
    if (Date.now() >= deadline) break;
    await setTimeout(
      Math.min(100, Math.max(1, deadline - Date.now())),
      undefined,
      { signal },
    );
  } while (Date.now() < deadline);
  throw new SendOutcomeUnknownError(
    `LinkedIn did not confirm sending within ${timeout} ms. Verify the conversation before retrying.`,
  );
}
