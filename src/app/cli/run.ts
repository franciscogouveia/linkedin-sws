import { withBrowserReview } from '../browser-review.ts';
import { ApplicationError } from '../../shared/errors.ts';
import { loadConfiguration, loadStartup } from '../config.ts';
import { openQueue } from '../../infrastructure/storage/queue.ts';
import { openLinkedIn } from '../../infrastructure/linkedin/browser.ts';
import { LlmWriter } from '../../writing/llm.ts';
import { OpenAITextClient } from '../../infrastructure/llm/client.ts';
import { runSearch } from '../../search/workflow.ts';
import { runWrite } from '../../writing/workflow.ts';
import { runSend } from '../../communication/workflow.ts';
import { terminalText } from '../../communication/terminal.ts';

async function main(stage: 'search' | 'write' | 'send' | 'all'): Promise<void> {
  if (process.argv.length > 2)
    throw new ApplicationError(
      'This CLI takes no arguments. Configure it in config.yaml.',
    );
  const { config, pitch } =
    stage === 'write' || stage === 'all'
      ? await loadStartup()
      : { config: await loadConfiguration(), pitch: '' };
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(
      new ApplicationError('Run interrupted. Database progress is preserved.'),
    );
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const log = (text: string) => {
    process.stderr.write(`${terminalText(text)}\n`);
  };
  let storage: Awaited<ReturnType<typeof openQueue>> | undefined;
  let browser: Awaited<ReturnType<typeof openLinkedIn>> | undefined;
  let readingProfiles = false;
  const output = (text: string) =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(text, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  try {
    storage = await openQueue(config.queue_path);
    controller.signal.throwIfAborted();
    if (stage === 'write') {
      const counts = storage.profiles.counts();
      if (!counts.new && !counts.working) {
        log('No profiles pending writing. Run npm run dev:search first.');
        return;
      }
    }
    if (stage === 'send' && !storage.messages.counts().new) {
      log(
        'No new messages to deliver. Run npm run dev:write or npm run queue:reset-dryruns.',
      );
      return;
    }
    log(
      `Starting ${stage === 'all' ? 'search → write → send' : stage} (${config.mode}).`,
    );
    if (stage === 'send' && config.mode === 'dryrun-terminal') {
      await runSend({
        config,
        messages: storage.messages,
        output,
        log,
        signal: controller.signal,
      });
      return;
    }
    browser = await openLinkedIn(config.linkedin, controller.signal, log);
    readingProfiles = stage !== 'send';
    void browser.closed.then(() => {
      if (readingProfiles && !controller.signal.aborted)
        controller.abort(
          new ApplicationError(
            'Browser closed during profile processing. Database progress is preserved.',
          ),
        );
    });
    // Search/write need the LLM. Delivery uses only persisted text.
    if (stage !== 'send') {
      const writer = new LlmWriter(
        new OpenAITextClient(config.llm, controller.signal),
        config.llm.max_message_characters,
      );
      if (stage === 'search' || stage === 'all')
        await runSearch({
          config,
          profiles: storage.profiles,
          linkedin: browser.reader,
          writer,
          log,
          signal: controller.signal,
        });
      if (stage === 'write' || stage === 'all')
        await runWrite({
          config,
          pitch,
          profiles: storage.profiles,
          messages: storage.messages,
          linkedin: browser.reader,
          writer,
          log,
          signal: controller.signal,
        });
    }
    readingProfiles = false;
    controller.signal.throwIfAborted();
    if (stage === 'send' || stage === 'all') {
      if (!storage.messages.counts().new) {
        log('No new messages to deliver.');
        return;
      }
      const work = () =>
        runSend({
          config,
          messages: storage!.messages,
          messenger: browser!.messenger,
          output,
          log,
          signal: controller.signal,
        });
      if (config.mode === 'dryrun-terminal') await work();
      else await withBrowserReview(browser, controller, work, log);
    }
  } finally {
    readingProfiles = false;
    try {
      await browser?.close();
    } finally {
      await storage?.close();
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}

export function startCli(stage: 'search' | 'write' | 'send' | 'all'): void {
  process.stdout.on('error', () => {
    process.exitCode = 1;
  });
  main(stage).catch((error: unknown) => {
    const message =
      error instanceof ApplicationError
        ? error.message
        : 'Run stopped unexpectedly. Database progress is preserved; check local files and service availability.';
    process.stderr.write(`${terminalText(message)}\n`);
    process.exitCode = 1;
  });
}
