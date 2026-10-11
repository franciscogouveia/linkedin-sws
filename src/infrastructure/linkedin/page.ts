import type { Page } from 'playwright';
import { ApplicationError } from '../../shared/errors.ts';
export function profileSlug(href: string): string | undefined {
  try {
    const url = new URL(href, 'https://www.linkedin.com');
    if (url.hostname !== 'www.linkedin.com' && url.hostname !== 'linkedin.com')
      return;
    const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
    const slug = match?.[1] ? decodeURIComponent(match[1]) : undefined;
    return slug && /^[\p{L}\p{N}_-]+$/u.test(slug) ? slug : undefined;
  } catch {
    return;
  }
}

export function searchUrl(keywords: string, pageNumber: number): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  url.searchParams.set('keywords', keywords);
  url.searchParams.set('page', String(pageNumber));
  return url.href;
}

export const loginPath = /\/(?:login|uas\/login|authwall|signup)(?:\/|$)/i;
export const checkpointPath = /\/(?:checkpoint|challenge)(?:\/|$)/i;
const restrictionText =
  /your account (?:has been|is) (?:temporarily |permanently )?restricted|we.ve restricted your account|automated activity|unusual activity|security verification/i;

export async function pageText(page: Page): Promise<string> {
  const main = page.locator('main, [role="main"]').first();
  return (await main.count())
    ? main.innerText()
    : page.locator('body').innerText();
}

export async function assertLinkedInPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  if (!['www.linkedin.com', 'linkedin.com'].includes(url.hostname)) {
    throw new ApplicationError(
      'LinkedIn redirected outside its website. Stopping.',
    );
  }
  if (loginPath.test(url.pathname)) {
    throw new ApplicationError(
      'LinkedIn authentication expired. Restart and sign in manually.',
    );
  }
  if (checkpointPath.test(url.pathname)) {
    throw new ApplicationError(
      'LinkedIn requires a security checkpoint. Stopping; resolve it manually before restarting.',
    );
  }
  // Scan notices, not arbitrary profile prose that might mention automation.
  const notices = await page
    .locator(
      '[role="alert"], [role="dialog"], .artdeco-inline-feedback, .challenge',
    )
    .allTextContents();
  const mainText = await pageText(page);
  const hasProfile = await page
    .locator(
      'main h1, main a[href*="/in/"], [role="main"] h1, [role="main"] a[href*="/in/"]',
    )
    .count();
  if (
    notices.some((text) => restrictionText.test(text)) ||
    (!hasProfile && restrictionText.test(mainText))
  ) {
    throw new ApplicationError(
      'LinkedIn displayed an account or automation warning. Stopping.',
    );
  }
}
