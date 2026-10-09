import { ApplicationError } from '../shared/errors.ts';
import { runSearch, type SearchOptions } from '../search/workflow.ts';
import { runMessages, type MessageOptions } from '../writing/workflow.ts';

export async function runDryRun(options: SearchOptions & MessageOptions) {
  if (options.config.mode !== 'dryrun') {
    throw new ApplicationError('This prototype only supports mode: dryrun.');
  }
  const search = await runSearch(options);
  const messages = await runMessages(options);
  return { ...search, ...messages };
}
