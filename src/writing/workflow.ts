import { ApplicationError } from '../shared/errors.ts';
import type {
  LinkedInReader,
  PitchWriter,
  QueueStore,
  OutreachContext,
} from '../shared/types.ts';
import { terminalText } from '../communication/terminal.ts';
import { displayMessage } from '../communication/delivery.ts';

export interface MessageOptions {
  config: {
    mode: 'dryrun';
    max_profiles_per_run: number;
    outreach: OutreachContext;
  };
  pitch: string;
  queue: QueueStore;
  linkedin: Pick<LinkedInReader, 'readProfile'>;
  writer: PitchWriter;
  output: (text: string) => Promise<void>;
  log: (text: string) => void;
  signal: AbortSignal;
}

export async function runMessages(options: MessageOptions) {
  const { config, pitch, queue, linkedin, writer, output, log, signal } =
    options;
  if (config.mode !== 'dryrun') {
    throw new ApplicationError('This prototype only supports mode: dryrun.');
  }
  const initial = queue.counts();
  log(
    `Queue: ${initial.new} new, ${initial.working} working, ${initial.dryrun} dryrun, ${initial.sent} sent, ${initial.failed} failed. Processing limit: ${config.max_profiles_per_run}. Completed and failed rows are skipped.`,
  );

  let processed = 0;
  let displayed = 0;
  while (processed < config.max_profiles_per_run) {
    signal.throwIfAborted();
    const row = queue.next();
    if (!row) break;
    processed++;
    log(`Analyzing ${terminalText(row.name)} (${terminalText(row.slug)}).`);
    const profile = await linkedin.readProfile(row.slug, row.name);
    signal.throwIfAborted();
    if (!profile) {
      queue.finish(row.id, 'failed', 'invalid slug, profile not found');
      log('Profile not found; recorded failed.');
      continue;
    }
    profile.searchRole = row.role;
    log(
      profile.sections
        ? `Profile data: header ${profile.sections.header.length}, About ${profile.sections.about.length}, Experience ${profile.sections.experience.length} characters; search role: ${terminalText(row.role)}; truncated: ${profile.truncated}.`
        : `Profile data: ${profile.text.length} characters; search role: ${terminalText(row.role)}; truncated: ${profile.truncated}.`,
    );
    const assessment = await writer.classify(profile);
    log(
      `Investor assessment: ${assessment.decision}. Reason: ${terminalText(assessment.reason)}${assessment.evidence ? ` Evidence: ${terminalText(assessment.evidence)}` : ''}`,
    );
    signal.throwIfAborted();
    if (assessment.decision !== 'investor') {
      const failure =
        assessment.decision === 'not_investor'
          ? 'not an investor'
          : 'investor status uncertain';
      queue.finish(row.id, 'failed', failure);
      log(`${failure}; recorded failed.`);
      continue;
    }
    const message = await writer.write(profile, pitch, config.outreach);
    signal.throwIfAborted();
    await displayMessage(row, message, output);
    // Record completion only after the destination successfully accepts the output.
    signal.throwIfAborted();
    queue.finish(row.id, 'dryrun');
    displayed++;
  }
  const final = queue.counts();
  const pending = final.new + final.working;
  log(
    `Dry run finished: ${processed} processed, ${displayed} message(s) displayed, ${processed - displayed} failed this run; ${pending} pending.`,
  );
  log(
    pending === 0
      ? 'Stopped because no new or working queue rows remain.'
      : `Stopped at max_profiles_per_run (${config.max_profiles_per_run}); rerun to process remaining rows.`,
  );
  return { processed, displayed };
}
