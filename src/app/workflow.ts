import { runSearch, type SearchOptions } from '../search/workflow.ts';
import { runWrite, type WriteOptions } from '../writing/workflow.ts';
import { runSend, type SendOptions } from '../communication/workflow.ts';

export async function runWorkflow(
  options: SearchOptions & WriteOptions & SendOptions,
) {
  const search = await runSearch(options);
  const write = await runWrite(options);
  const send = await runSend(options);
  return { search, write, send };
}
