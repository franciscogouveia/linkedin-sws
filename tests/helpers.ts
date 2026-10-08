import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { parseConfig } from '../src/config.ts';
import type { Investor, Profile } from '../src/types.ts';

export async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'linkedin-sws-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export const configYaml = `
mode: dryrun
pitch_path: pitch.md
queue_path: data/queue.sqlite
search:
  keywords: '"angel investor"'
linkedin:
  session_dir: data/browser
llm:
  provider: openai-compatible
  base_url: https://api.openai.com/v1
  model: test-model
  api_key: test-key
`;

export function testConfig(directory: string) {
  return parseConfig(configYaml, join(directory, 'config.yaml'));
}

export const investor: Investor = {
  name: 'Alex Example',
  role: 'Angel investor in early-stage software',
  slug: 'alex-example',
};

export const profile: Profile = {
  slug: investor.slug,
  name: investor.name,
  text: `${investor.name}\n${investor.role}\nAbout\nI invest in early-stage software companies.`,
  truncated: false,
};
