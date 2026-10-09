import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseConfig } from '../shared/config.ts';
import { ApplicationError } from '../shared/errors.ts';
import { openQueue } from '../storage/queue.ts';
import { terminalText } from '../communication/terminal.ts';

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new ApplicationError(
      'This command takes no arguments. It uses queue_path from config.yaml.',
    );
  }
  const configPath = resolve('config.yaml');
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    throw new ApplicationError('Cannot read config.yaml.');
  }
  const config = parseConfig(text, configPath);
  try {
    await access(config.queue_path);
  } catch {
    throw new ApplicationError(
      'Cannot find the configured queue. Run the application first.',
    );
  }
  const storage = await openQueue(config.queue_path);
  try {
    const reset = storage.queue.resetDryruns();
    console.log(`Reset ${reset} dryrun row(s) to new.`);
  } finally {
    await storage.close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ApplicationError
      ? error.message
      : 'Cannot reset dryrun rows. Check queue_path and file permissions.';
  process.stderr.write(`${terminalText(message)}\n`);
  process.exitCode = 1;
});
