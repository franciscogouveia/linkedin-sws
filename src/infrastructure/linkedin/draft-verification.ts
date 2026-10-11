import { setTimeout } from 'node:timers/promises';
import { DraftVerificationError } from '../../shared/errors.ts';
import type { MessageDraft } from '../../shared/types.ts';

// Rich-text editors render paragraphs, trailing blank lines, and NBSP differently
// from the source string. Compare the text's words and punctuation, not its layout.
export function draftTextMatches(actual: string, expected: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
  return normalize(actual) === normalize(expected);
}

export interface DraftReadback {
  recipientVerified: boolean;
  body?: string;
  subject?: string;
}

/** Wait briefly for the editor's input handlers to render; never fill or submit. */
export async function verifyDraft(
  draft: MessageDraft,
  read: () => Promise<DraftReadback>,
  signal: AbortSignal,
  timeout = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let failure = 'recipient or composer layout changed';
  do {
    signal.throwIfAborted();
    let actual: DraftReadback;
    try {
      actual = await read();
    } catch {
      signal.throwIfAborted();
      throw new DraftVerificationError(
        'Draft verification failed: could not read the prepared editor or recipient. Draft left in the browser.',
      );
    }
    signal.throwIfAborted();
    if (!actual.recipientVerified) {
      failure = 'recipient or composer layout could not be confirmed';
    } else if (
      actual.body === undefined ||
      !draftTextMatches(actual.body, draft.body)
    ) {
      failure = `message body differs (expected ${draft.body.length} characters; read ${actual.body?.length ?? 0})`;
    } else if (
      draft.subject !== undefined &&
      (actual.subject === undefined ||
        !draftTextMatches(actual.subject, draft.subject))
    ) {
      failure = `InMail subject differs (expected ${draft.subject.length} characters; read ${actual.subject?.length ?? 0})`;
    } else {
      return;
    }
    if (Date.now() >= deadline) break;
    await setTimeout(
      Math.min(100, Math.max(1, deadline - Date.now())),
      undefined,
      { signal },
    );
  } while (Date.now() < deadline);
  throw new DraftVerificationError(
    `Draft verification failed: ${failure}. Draft left in the browser.`,
  );
}
