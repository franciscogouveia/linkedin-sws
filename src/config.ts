import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ApplicationError } from './errors.ts';

const nonempty = z.string().trim().min(1);
const configSchema = z.strictObject({
  mode: z.literal('dryrun'),
  pitch_path: nonempty,
  queue_path: nonempty,
  max_profiles_per_run: z.number().int().min(1).max(10).default(1),
  search: z.strictObject({
    keywords: nonempty.max(500),
    max_results: z.number().int().min(1).max(50).default(5),
    max_pages: z.number().int().min(1).max(10).default(1),
  }),
  linkedin: z.strictObject({
    session_dir: nonempty,
    timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
    login_timeout_ms: z.number().int().min(1_000).max(600_000).default(300_000),
  }),
  llm: z.strictObject({
    provider: z.literal('openai-compatible'),
    base_url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' || url.protocol === 'http:')
      );
    }, 'Use HTTP or HTTPS without credentials, query parameters, or fragments.'),
    model: nonempty,
    api_key: nonempty.refine(
      (value) => !/^(YOUR_|REPLACE_|CHANGE_ME)/i.test(value),
      'Replace the API key placeholder in your private config.yaml.',
    ),
    api: z.enum(['responses', 'chat-completions']).default('responses'),
    structured_output: z.boolean().default(true),
    timeout_ms: z.number().int().min(1_000).max(300_000).default(60_000),
    max_output_tokens: z.number().int().min(256).max(16_384).default(2_048),
    max_message_characters: z
      .number()
      .int()
      .min(200)
      .max(10_000)
      .default(1_500),
  }),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(text: string, configPath: string): Config {
  let value: unknown;
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw new Error('Invalid YAML');
    value = document.toJS({ maxAliasCount: 50 });
  } catch {
    // YAML errors can quote source lines containing credentials.
    throw new ApplicationError('config.yaml is not valid YAML.');
  }
  const result = configSchema.safeParse(value);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('\n');
    throw new ApplicationError(`Invalid configuration:\n${problems}`);
  }
  const config = result.data;
  const directory = dirname(resolve(configPath));
  config.pitch_path = resolve(directory, config.pitch_path);
  config.queue_path = resolve(directory, config.queue_path);
  config.linkedin.session_dir = resolve(directory, config.linkedin.session_dir);
  if ([resolve(configPath), config.pitch_path].includes(config.queue_path)) {
    throw new ApplicationError(
      'queue_path must differ from config.yaml and pitch_path.',
    );
  }
  return config;
}

export async function loadStartup(configPath = resolve('config.yaml')) {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    throw new ApplicationError(
      'Cannot read config.yaml. Copy config.example.yaml to config.yaml and edit it first.',
    );
  }
  const config = parseConfig(text, configPath);
  let pitch: string;
  try {
    pitch = await readFile(config.pitch_path, 'utf8');
  } catch {
    throw new ApplicationError(
      'Cannot read the Markdown file configured by pitch_path.',
    );
  }
  if (!pitch.trim() || Buffer.byteLength(pitch) > 128 * 1_024) {
    throw new ApplicationError(
      'The pitch must be nonempty and no larger than 128 KiB.',
    );
  }
  return { config, pitch };
}
