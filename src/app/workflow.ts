import { ApplicationError } from '../shared/errors.ts';
import { runSearch, type SearchOptions } from '../search/workflow.ts';
import { runMessages, type MessageOptions } from '../writing/workflow.ts';

export async function runDryRun(options: SearchOptions & MessageOptions) {
  if (!['dryrun-terminal', 'dryrun-browser'].includes(options.config.mode)) {
    throw new ApplicationError(
      'This prototype supports dryrun-terminal and dryrun-browser; live sending is unavailable.',
    );
  }
  const search = await runSearch(options);
  const messages = await runMessages(options);
  return { ...search, ...messages };
}
