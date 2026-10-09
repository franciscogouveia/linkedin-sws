import OpenAI from 'openai';
import type { Config } from '../../app/config.ts';

export function describeLlmError(
  error: unknown,
  settings: Config['llm'],
  operation: string,
  sourceValues: string[] = [],
): string {
  const clean = (value: unknown): string => {
    let text = String(value);
    for (const secret of [settings.api_key, ...sourceValues]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text
      .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .slice(0, 1500);
  };
  const endpoint = `${settings.base_url.replace(/\/$/, '')}/${settings.api === 'responses' ? 'responses' : 'chat/completions'}`;
  const details = [
    `LLM ${operation} failed.`,
    `Endpoint: ${clean(endpoint)}; model: ${clean(settings.model)}.`,
  ];
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    details.push(
      `Request timed out (configured timeout: ${settings.timeout_ms} ms).`,
    );
  } else if (error instanceof OpenAI.APIConnectionError) {
    details.push('Connection failed before receiving an HTTP response.');
  } else if (error instanceof OpenAI.APIError && error.status) {
    details.push(`HTTP ${error.status}.`);
  }
  if (error instanceof OpenAI.APIError) {
    for (const [label, value] of [
      ['Provider code', error.code],
      ['Provider type', error.type],
      ['Parameter', error.param],
      ['Request ID', error.requestID],
    ]) {
      if (value) details.push(`${label}: ${clean(value)}.`);
    }
  }
  const seen = new Set<unknown>();
  const causes: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5)
      return;
    seen.add(value);
    const cause = value as Record<string, unknown>;
    const fields = ['code', 'syscall', 'hostname', 'address', 'port']
      .filter(
        (field) =>
          typeof cause[field] === 'string' || typeof cause[field] === 'number',
      )
      .map((field) => `${field}=${clean(cause[field])}`);
    if (typeof cause.message === 'string') fields.unshift(clean(cause.message));
    if (fields.length) causes.push(fields.join('; '));
    visit(cause.cause, depth + 1);
    if (Array.isArray(cause.errors)) {
      for (const child of cause.errors.slice(0, 4)) visit(child, depth + 1);
    }
  };
  visit(error, 0);
  if (causes.length)
    details.push(`Details: ${causes.join(' -> ').slice(0, 3000)}`);
  else details.push(`Details: ${clean(error)}`);
  details.push('Queue row remains working.');
  return details.join('\n');
}
