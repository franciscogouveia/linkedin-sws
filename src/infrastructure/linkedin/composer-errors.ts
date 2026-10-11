import type { Investor } from '../../shared/types.ts';

/** Keep the useful first line; omit Playwright's call log and recipient selectors. */
export function composerFailure(
  error: unknown,
  stage: string,
  recipient: Investor,
): string {
  const cause =
    error instanceof Error
      ? `${error.name}: ${error.message.split(/\r?\n/)[0] ?? ''}`
      : 'Unknown browser error';
  const clean = cause
    .replaceAll(recipient.name, '[recipient]')
    .replaceAll(recipient.slug, '[profile]')
    .replace(/https?:\/\/[^\s'"<>]+/gi, '[URL]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 400);
  return `LinkedIn draft preparation failed while ${stage}. ${clean}. Review the browser; queue row remains working.`;
}
