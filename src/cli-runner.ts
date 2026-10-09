import { ApplicationError } from './errors.ts';
import { loadConfiguration, loadStartup } from './config.ts';
import { openQueue } from './queue.ts';
import { openLinkedIn } from './linkedin.ts';
import { LlmWriter } from './llm.ts';
import { runDryRun, runSearch, runMessages, terminalText } from './workflow.ts';

async function main(stage: 'search' | 'message' | 'all'): Promise<void> {
  if (process.argv.length > 2) {
    throw new ApplicationError(
      'This CLI takes no arguments. Configure it in config.yaml.',
    );
  }
  const { config, pitch } =
    stage === 'search'
      ? { config: await loadConfiguration(), pitch: '' }
      : await loadStartup();
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(
      new ApplicationError('Run interrupted. Queue progress is preserved.'),
    );
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const log = (text: string) => process.stderr.write(`${terminalText(text)}\n`);
  let storage: Awaited<ReturnType<typeof openQueue>> | undefined;
  let browser: Awaited<ReturnType<typeof openLinkedIn>> | undefined;
  try {
    storage = await openQueue(config.queue_path);
    controller.signal.throwIfAborted();
    if (stage === 'message') {
      const counts = storage.queue.counts();
      if (!counts.new && !counts.working) {
        log(
          'No pending queue rows. Run npm run dev:search to find profiles, or npm run queue:reset-dryruns to regenerate completed dry runs.',
        );
        return;
      }
    }
    log(
      stage === 'search'
        ? 'Starting LinkedIn search. Results will be added to the queue.'
        : 'Starting dry-run prototype. Generated messages will be printed to the terminal.',
    );
    browser = await openLinkedIn(config.linkedin, controller.signal, log);
    if (stage === 'search') {
      await runSearch({
        config,
        queue: storage.queue,
        linkedin: browser.reader,
        signal: controller.signal,
        log,
      });
      log(
        'Search finished. Run npm run dev:message to process queued profiles.',
      );
      return;
    }
    const writer = new LlmWriter(config.llm, controller.signal);
    await (stage === 'message' ? runMessages : runDryRun)({
      config,
      pitch,
      queue: storage.queue,
      linkedin: browser.reader,
      writer,
      signal: controller.signal,
      output: (text) =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(text, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
      log,
    });
  } finally {
    try {
      await browser?.close();
    } finally {
      await storage?.close();
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}

export function startCli(stage: 'search' | 'message' | 'all'): void {
  process.stdout.on('error', () => {
    // A closed pipe must not be mistaken for successful dry-run delivery.
    process.exitCode = 1;
  });

  main(stage).catch((error: unknown) => {
    const message =
      error instanceof ApplicationError
        ? error.message
        : 'Run stopped unexpectedly. Queue progress is preserved; check local files and service availability.';
    process.stderr.write(`${terminalText(message)}\n`);
    process.exitCode = 1;
  });
}
