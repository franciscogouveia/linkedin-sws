import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadStartup, parseConfig } from '../src/config.ts';
import { configYaml, temporaryDirectory } from './helpers.ts';

test('configuration resolves paths against its location and sets small prototype limits', () => {
  const config = parseConfig(configYaml, '/tmp/example/config.yaml');
  assert.equal(config.pitch_path, '/tmp/example/pitch.md');
  assert.equal(config.queue_path, '/tmp/example/data/queue.sqlite');
  assert.equal(config.linkedin.session_dir, '/tmp/example/data/browser');
  assert.equal(config.search.max_results, 5);
  assert.equal(config.search.max_pages, 1);
  assert.equal(config.max_profiles_per_run, 1);
});

test('configuration rejects live mode, unsupported filters, duplicate keys, and invalid limits', () => {
  for (const text of [
    configYaml.replace('mode: dryrun', 'mode: live'),
    configYaml.replace('search:', 'search:\n  location: London'),
    configYaml.replace('search:', 'search:\n  max_results: -1'),
    `${configYaml}\nmode: dryrun`,
  ]) {
    assert.throws(() => parseConfig(text, '/tmp/config.yaml'));
  }
});

test('processing limits above ten are accepted but must be positive safe integers', () => {
  const text = `${configYaml}\nmax_profiles_per_run: 100`;
  assert.equal(parseConfig(text, '/tmp/config.yaml').max_profiles_per_run, 100);
  for (const value of ['0', '-1', '1.5', '9007199254740992']) {
    assert.throws(() =>
      parseConfig(
        `${configYaml}\nmax_profiles_per_run: ${value}`,
        '/tmp/config.yaml',
      ),
    );
  }
});

test('configuration permits Ollama over HTTP on loopback, LAN addresses, and hostnames', () => {
  for (const endpoint of [
    'http://localhost:11434/v1/',
    'http://192.168.0.2:11434/v1',
    'http://ollama.lan:11434/v1/',
    'https://api.openai.com/v1',
  ]) {
    const config = parseConfig(
      configYaml.replace('https://api.openai.com/v1', endpoint),
      '/tmp/config.yaml',
    );
    assert.equal(config.llm.base_url, endpoint);
  }
});

test('configuration rejects non-HTTP protocols and URLs with credentials, queries, or fragments', () => {
  for (const endpoint of [
    'ftp://example.com/v1',
    'https://secret@example.com/v1',
    'http://user:password@192.168.0.2:11434/v1',
    'http://192.168.0.2:11434/v1?token=secret',
    'http://192.168.0.2:11434/v1#fragment',
  ]) {
    assert.throws(() =>
      parseConfig(
        configYaml.replace('https://api.openai.com/v1', endpoint),
        '/tmp/config.yaml',
      ),
    );
  }
});

test('configuration errors do not echo API keys or invalid YAML source lines', () => {
  const key = 'private-secret-example';
  for (const text of [
    configYaml.replace('api_key: test-key', `api_key: [${key}`),
    configYaml
      .replace('model: test-model', 'model: 123')
      .replace('api_key: test-key', `api_key: ${key}`),
  ]) {
    assert.throws(
      () => parseConfig(text, '/tmp/config.yaml'),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(key));
        return true;
      },
    );
  }
  assert.throws(
    () =>
      parseConfig(
        configYaml.replace('test-key', 'YOUR_OPENAI_API_KEY'),
        '/tmp/config.yaml',
      ),
    /placeholder/,
  );
});

test('startup loads the pitch once and does not create storage on an invalid startup', async (t) => {
  const directory = await temporaryDirectory(t);
  const configPath = join(directory, 'config.yaml');
  await writeFile(configPath, configYaml);
  await assert.rejects(loadStartup(configPath), /Markdown/);
  await assert.rejects(access(join(directory, 'data')));
  await writeFile(join(directory, 'pitch.md'), 'Original pitch');
  const startup = await loadStartup(configPath);
  await writeFile(join(directory, 'pitch.md'), 'Modified pitch');
  assert.equal(startup.pitch, 'Original pitch');
});

test('queue path cannot overwrite pitch or configuration', () => {
  for (const path of ['pitch.md', 'config.yaml']) {
    assert.throws(
      () =>
        parseConfig(
          configYaml.replace('data/queue.sqlite', path),
          '/tmp/config.yaml',
        ),
      /must differ/,
    );
  }
});
