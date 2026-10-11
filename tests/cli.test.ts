import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openQueue } from '../src/infrastructure/storage/queue.ts';
import { configYaml, investor, temporaryDirectory } from './helpers.ts';

const execute = promisify(execFile);
const cliEnvironment = { ...process.env };
// Node's no-isolation runner sets this internally; child CLIs must run normally.
delete cliEnvironment.NODE_TEST_CONTEXT;
const cliDirectory = fileURLToPath(new URL('../src/app/cli/', import.meta.url));

test('send CLI delivers persisted text without a pitch file, display, or reachable LLM', async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(
    join(directory, 'config.yaml'),
    configYaml.replace('https://api.openai.com/v1', 'http://127.0.0.1:1/v1'),
  );
  const path = join(directory, 'data/queue.sqlite');
  const storage = await openQueue(path);
  storage.profiles.append(investor);
  storage.messages.save(storage.profiles.next([])!.id, {
    subject: 'Funding Acme',
    body: 'Our saved funding message.',
  });
  await storage.close();
  const run = (command: string) =>
    execute(process.execPath, [join(cliDirectory, `${command}.ts`)], {
      cwd: directory,
      timeout: 10000,
      env: { ...cliEnvironment, DISPLAY: '', WAYLAND_DISPLAY: '' },
    });
  await run('send');
  const inspect = await openQueue(path);
  assert.equal(inspect.messages.rows()[0]?.status, 'dryrun');
  await inspect.close();
  await run('send');
  await run('reset-dryruns');
  const reset = await openQueue(path);
  assert.equal(reset.messages.rows()[0]?.status, 'new');
  assert.equal(reset.messages.rows()[0]?.message, 'Our saved funding message.');
  await reset.close();
  await run('send');
  await run('clear-messages');
  const cleared = await openQueue(path);
  assert.equal(cleared.messages.rows().length, 0);
  assert.equal(cleared.profiles.rows()[0]?.status, 'new');
  await cleared.close();
  await run('clear-profiles');
  const fresh = await openQueue(path);
  t.after(() => fresh.close());
  assert.equal(fresh.profiles.rows().length, 0);
});
