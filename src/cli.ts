import { ApplicationError } from './errors.ts';
import { loadStartup } from './config.ts';
import { openQueue } from './queue.ts';
import { openLinkedIn } from './linkedin.ts';
import { LlmWriter } from './llm.ts';
import { runDryRun, terminalText } from './workflow.ts';

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new ApplicationError(
      'This CLI takes no arguments. Configure it in config.yaml.',
    );
  }
  const { config, pitch } = await loadStartup();
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
    log(
      'Starting dry-run prototype. Generated messages will be printed to the terminal.',
    );
    browser = await openLinkedIn(config.linkedin, controller.signal, log);
    const writer = new LlmWriter(config.llm, controller.signal);
    await runDryRun({
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

process.stdout.on('error', () => {
  // A closed pipe must not be mistaken for successful dry-run delivery.
  process.exitCode = 1;
});

main().catch((error: unknown) => {
  const message =
    error instanceof ApplicationError
      ? error.message
      : 'Run stopped unexpectedly. Queue progress is preserved; check local files and service availability.';
  process.stderr.write(`${terminalText(message)}\n`);
  process.exitCode = 1;
});
