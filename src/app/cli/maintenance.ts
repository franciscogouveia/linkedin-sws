import { access } from 'node:fs/promises';
import { loadConfiguration } from '../config.ts';
import { ApplicationError } from '../../shared/errors.ts';
import { openQueue } from '../../infrastructure/storage/queue.ts';
import { terminalText } from '../../communication/terminal.ts';

export function maintain(
  action: 'reset-dryruns' | 'clear-messages' | 'clear-profiles',
): void {
  async function main() {
    if (process.argv.length > 2)
      throw new ApplicationError(
        'This command takes no arguments. It uses queue_path from config.yaml.',
      );
    const config = await loadConfiguration();
    try {
      await access(config.queue_path);
    } catch {
      throw new ApplicationError(
        'Cannot find the configured database. Run the application first.',
      );
    }
    const storage = await openQueue(config.queue_path);
    try {
      const count =
        action === 'reset-dryruns'
          ? storage.repository.resetDryruns()
          : action === 'clear-messages'
            ? storage.repository.clearMessages()
            : storage.repository.clearProfiles();
      console.log(
        action === 'reset-dryruns'
          ? `Reset ${count} dryrun message(s) to new.`
          : action === 'clear-messages'
            ? `Cleared ${count} message(s); written profiles reset to new.`
            : `Cleared ${count} profile(s) and all associated messages.`,
      );
    } finally {
      await storage.close();
    }
  }
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${terminalText(error instanceof ApplicationError ? error.message : 'Database maintenance failed. Check queue_path and local files.')}\n`,
    );
    process.exitCode = 1;
  });
}
