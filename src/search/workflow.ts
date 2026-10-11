import type {
  LinkedInReader,
  SearchCriteria,
  ProfileStore,
  PitchWriter,
  Investor,
} from '../shared/types.ts';
import { failureReason, rethrowFatal } from '../shared/failure.ts';
import { terminalText } from '../communication/terminal.ts';

export interface SearchOptions {
  config: { search: SearchCriteria };
  profiles: ProfileStore;
  linkedin: LinkedInReader;
  writer: Pick<PitchWriter, 'classify'>;
  log: (text: string) => void;
  signal: AbortSignal;
}

export async function runSearch(options: SearchOptions) {
  const { config, profiles, linkedin, writer, log, signal } = options;
  const candidates = new Map<string, Investor>();
  signal.throwIfAborted();
  // Finish discovery before profile navigation changes the reader's page.
  const discovered = await linkedin.search(config.search, (investor) => {
    signal.throwIfAborted();
    if (!candidates.has(investor.slug)) candidates.set(investor.slug, investor);
  });
  let accepted = 0;
  let failed = 0;
  let skipped = 0;
  for (const candidate of candidates.values()) {
    signal.throwIfAborted();
    if (profiles.has(candidate.slug)) {
      skipped++;
      continue;
    }
    log(
      `Validating ${terminalText(candidate.name)} (${terminalText(candidate.slug)}).`,
    );
    let failure = '';
    try {
      const profile = await linkedin.readProfile(
        candidate.slug,
        candidate.name,
      );
      signal.throwIfAborted();
      if (!profile) failure = 'invalid slug, profile not found';
      else {
        profile.searchRole = candidate.role;
        log(
          `Profile data: ${profile.text.length} characters; search role: ${terminalText(candidate.role)}; truncated: ${profile.truncated}.`,
        );
        const assessment = await writer.classify(profile);
        signal.throwIfAborted();
        log(
          `Investor assessment: ${assessment.decision}. Reason: ${terminalText(assessment.reason)}${assessment.evidence ? ` Evidence: ${terminalText(assessment.evidence)}` : ''}`,
        );
        if (assessment.decision !== 'investor')
          failure = `${assessment.decision === 'not_investor' ? 'not an investor' : 'investor status uncertain'}: ${assessment.reason}`;
      }
    } catch (error) {
      rethrowFatal(error, signal);
      failure = failureReason(error);
    }
    signal.throwIfAborted();
    if (profiles.append(candidate, failure)) {
      if (failure) {
        failed++;
        log(`${terminalText(failure)}; saved failed profile.`);
      } else accepted++;
    }
  }
  log(
    `Search finished: ${discovered} discovered, ${accepted} validated investor(s), ${failed} failed, ${skipped} existing profile(s) skipped.`,
  );
  return { discovered, accepted, failed, skipped };
}
