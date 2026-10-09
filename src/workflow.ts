import { stripVTControlCharacters } from 'node:util';
import { ApplicationError } from './errors.ts';
import type { Config } from './config.ts';
import type { Queue } from './queue.ts';
import type { LinkedInReader, PitchWriter } from './types.ts';

export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    '',
  );
}

export async function runDryRun(options: {
  config: Config;
  pitch: string;
  queue: Queue;
  linkedin: LinkedInReader;
  writer: PitchWriter;
  output: (text: string) => Promise<void>;
  log: (text: string) => void;
  signal: AbortSignal;
}) {
  const { config, pitch, queue, linkedin, writer, output, log, signal } =
    options;
  if (config.mode !== 'dryrun') {
    throw new ApplicationError('This prototype only supports mode: dryrun.');
  }
  let appended = 0;
  signal.throwIfAborted();
  const discovered = await linkedin.search(config.search, (investor) => {
    signal.throwIfAborted();
    if (queue.append(investor)) appended++;
  });
  log(
    `Search collected ${discovered} profile(s); appended ${appended} new queue row(s).`,
  );
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
    await output(
      terminalText(
        `\nTo: ${row.name}\nProfile: https://www.linkedin.com/in/${row.slug}/\n\n${message}\n\n`,
      ),
    );
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
  return { discovered, appended, processed, displayed };
}
