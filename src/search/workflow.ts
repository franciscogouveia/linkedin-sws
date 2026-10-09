import type { Config } from '../shared/config.ts';
import type { Queue } from '../storage/queue.ts';
import type { LinkedInReader } from '../shared/types.ts';

export interface SearchOptions {
  config: Config;
  queue: Queue;
  linkedin: Pick<LinkedInReader, 'search'>;
  log: (text: string) => void;
  signal: AbortSignal;
}

export async function runSearch(options: SearchOptions) {
  const { config, queue, linkedin, log, signal } = options;
  let appended = 0;
  signal.throwIfAborted();
  const discovered = await linkedin.search(config.search, (investor) => {
    signal.throwIfAborted();
    if (queue.append(investor)) appended++;
  });
  log(
    `Search collected ${discovered} profile(s); appended ${appended} new queue row(s).`,
  );
  return { discovered, appended };
}
