import { ApplicationError, SendOutcomeUnknownError } from '../shared/errors.ts';
import { SEND_UNCERTAIN_FAILURE } from '../shared/types.ts';
import type { LinkedInMessenger, MessagingStore } from '../shared/types.ts';
import { failureReason, rethrowFatal } from '../shared/failure.ts';
import { terminalText } from './terminal.ts';
import { displayMessage } from './delivery.ts';

export interface SendOptions {
  config: {
    mode: 'dryrun-terminal' | 'dryrun-browser' | 'live';
    max_profiles_per_run: number;
  };
  messages: MessagingStore;
  messenger?: LinkedInMessenger;
  output: (text: string) => Promise<void>;
  log: (text: string) => void;
  signal: AbortSignal;
}
export async function runSend(options: SendOptions) {
  const { config, messages, output, log, signal } = options;
  if (!['dryrun-terminal', 'dryrun-browser', 'live'].includes(config.mode))
    throw new ApplicationError('Unsupported delivery mode.');
  if (config.mode !== 'dryrun-terminal' && !options.messenger)
    throw new ApplicationError(
      'Browser messaging requires a LinkedIn messenger.',
    );
  const attempted: number[] = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  while (attempted.length < config.max_profiles_per_run) {
    signal.throwIfAborted();
    const row = messages.next(attempted);
    if (!row) break;
    attempted.push(row.id);
    let sendAttempted = false;
    log(
      `Delivering saved message to ${terminalText(row.name)} (${terminalText(row.slug)}).`,
    );
    try {
      if (config.mode === 'dryrun-terminal')
        await displayMessage(row, row.message, output, row.subject);
      else {
        const composer = await options.messenger!.openComposer(row);
        signal.throwIfAborted();
        await composer.fill({
          body: row.message,
          ...(composer.kind === 'inmail' ? { subject: row.subject } : {}),
        });
        signal.throwIfAborted();
        if (config.mode === 'live') {
          if (!composer.send)
            throw new ApplicationError(
              'This composer does not support sending.',
            );
          await composer.send(() => {
            signal.throwIfAborted();
            if (sendAttempted)
              throw new ApplicationError('Refusing a duplicate send attempt.');
            messages.finish(row.id, 'failed', SEND_UNCERTAIN_FAILURE);
            sendAttempted = true;
          });
          if (!sendAttempted)
            throw new SendOutcomeUnknownError(
              'Send returned without recording an attempt.',
            );
          signal.throwIfAborted();
          messages.finish(row.id, 'sent');
          completed++;
          log(`Message sent to ${terminalText(row.name)}.`);
          continue;
        }
      }
      signal.throwIfAborted();
      messages.finish(row.id, 'dryrun');
      completed++;
    } catch (error) {
      rethrowFatal(error, signal);
      if (sendAttempted) {
        messages.failSend(
          row.id,
          `${SEND_UNCERTAIN_FAILURE}: ${failureReason(error)}`,
        );
        failed++;
        log(
          `${terminalText(row.name)}: submission failed: ${terminalText(failureReason(error))}. Saved failed; will not retry automatically.`,
        );
      } else {
        skipped++;
        log(
          `${terminalText(row.name)}: preparation failed: ${terminalText(failureReason(error))}. Skipped; message remains new for the next send run.`,
        );
      }
    }
  }
  log(
    `Send finished (${config.mode}): ${attempted.length} attempted, ${completed} completed, ${failed} failed, ${skipped} retryable; ${messages.counts().new} message(s) pending.`,
  );
  return { processed: attempted.length, completed, failed, skipped };
}
