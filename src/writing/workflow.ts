import { ApplicationError } from '../shared/errors.ts';
import { failureReason, rethrowFatal } from '../shared/failure.ts';
import type {
  LinkedInReader,
  PitchWriter,
  ProfileStore,
  MessagingStore,
  OutreachContext,
} from '../shared/types.ts';
import { terminalText } from '../communication/terminal.ts';

export interface WriteOptions {
  config: { max_profiles_per_run: number; outreach: OutreachContext };
  pitch: string;
  profiles: ProfileStore;
  messages: MessagingStore;
  linkedin: Pick<LinkedInReader, 'readProfile'>;
  writer: Pick<PitchWriter, 'write' | 'writeSubject'>;
  log: (text: string) => void;
  signal: AbortSignal;
}

export async function runWrite(options: WriteOptions) {
  const { config, pitch, profiles, messages, linkedin, writer, log, signal } =
    options;
  const attempted: number[] = [];
  let written = 0;
  while (attempted.length < config.max_profiles_per_run) {
    signal.throwIfAborted();
    const row = profiles.next(attempted);
    if (!row) break;
    attempted.push(row.id);
    log(`Writing for ${terminalText(row.name)} (${terminalText(row.slug)}).`);
    try {
      const profile = await linkedin.readProfile(row.slug, row.name);
      signal.throwIfAborted();
      if (!profile)
        throw new ApplicationError('invalid slug, profile not found');
      profile.searchRole = row.role;
      const body = await writer.write(profile, pitch, config.outreach);
      signal.throwIfAborted();
      const subject = await writer.writeSubject(
        profile,
        pitch,
        body,
        config.outreach,
      );
      signal.throwIfAborted();
      messages.save(row.id, { body, subject });
      written++;
      log(`Saved message and subject for ${terminalText(row.name)}.`);
    } catch (error) {
      rethrowFatal(error, signal);
      profiles.retry(row.id);
      log(
        `${terminalText(row.name)}: message generation failed: ${terminalText(failureReason(error))}. Skipped; will retry on the next write run.`,
      );
    }
  }
  const counts = profiles.counts();
  log(
    `Write finished: ${attempted.length} attempted, ${written} message(s) saved, ${attempted.length - written} skipped; ${counts.new + counts.working} profile(s) pending.`,
  );
  return { processed: attempted.length, written };
}
