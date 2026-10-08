import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { Config } from './config.ts';
import { ApplicationError } from './errors.ts';
import { inspectSearchPage, searchLayoutReport } from './search-page.ts';
import type {
  Investor,
  LinkedInReader,
  Profile,
  SearchCriteria,
} from './types.ts';

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

const loginPath = /\/(?:login|uas\/login|authwall|signup)(?:\/|$)/i;
const checkpointPath = /\/(?:checkpoint|challenge)(?:\/|$)/i;
const restrictionText =
  /your account (?:has been|is) (?:temporarily |permanently )?restricted|we.ve restricted your account|automated activity|unusual activity|security verification/i;
const missingText =
  /this (?:page|profile) does(?:n.t| not) exist|profile not found/i;
const noResultsText =
  /no results found|no matching results|try (?:different|another) keywords/i;

async function pageText(page: Page): Promise<string> {
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

export async function extractSearchResults(page: Page): Promise<Investor[]> {
  const state = await page.evaluate(inspectSearchPage);
  return state ? state.results : [];
}

export async function extractProfile(
  page: Page,
  slug: string,
): Promise<Profile> {
  const data = await page
    .locator('main, [role="main"]')
    .first()
    .evaluate((main) => {
      const heading = main.querySelector<HTMLElement>('h1');
      const name = heading?.innerText.replace(/\s+/g, ' ').trim() ?? '';
      const top = heading?.closest<HTMLElement>('section');
      const sections = new Set<HTMLElement>();
      if (top) sections.add(top);
      for (const section of main.querySelectorAll<HTMLElement>('section')) {
        const title =
          section.querySelector<HTMLElement>('h2')?.innerText.trim() ?? '';
        if (
          /^(About|Experience)(?:\s|$)/i.test(title) ||
          section.querySelector('#about, #experience')
        )
          sections.add(section);
      }
      const text = [...sections]
        .map((section) => section.innerText.trim())
        .filter(Boolean)
        .join('\n\n');
      return { name, text };
    });
  if (!data.name || !data.text) {
    throw new ApplicationError(
      'Cannot read the LinkedIn profile layout. Use an English interface and review the browser; queue row remains working.',
    );
  }
  return {
    slug,
    name: data.name,
    text: data.text.slice(0, 24_000),
    truncated: data.text.length > 24_000,
  };
}

export class LinkedInBrowser implements LinkedInReader {
  private readonly page: Page;
  private readonly signal: AbortSignal;
  private readonly diagnosticsDirectory: string | undefined;

  constructor(page: Page, signal: AbortSignal, diagnosticsDirectory?: string) {
    this.page = page;
    this.signal = signal;
    this.diagnosticsDirectory = diagnosticsDirectory;
  }

  private async navigate(url: string): Promise<number | undefined> {
    this.signal.throwIfAborted();
    let status: number | undefined;
    try {
      status = (
        await this.page.goto(url, { waitUntil: 'domcontentloaded' })
      )?.status();
    } catch {
      this.signal.throwIfAborted();
      throw new ApplicationError(
        'LinkedIn navigation failed or timed out. Stopping without changing the selected row.',
      );
    }
    await assertLinkedInPage(this.page);
    if (status && status >= 400 && status !== 404) {
      throw new ApplicationError(`LinkedIn returned HTTP ${status}. Stopping.`);
    }
    return status;
  }

  private async searchResults(): Promise<Investor[]> {
    try {
      const handle = await this.page.waitForFunction(inspectSearchPage);
      let state;
      try {
        state = await handle.jsonValue();
      } finally {
        await handle.dispose();
      }
      this.signal.throwIfAborted();
      await assertLinkedInPage(this.page);
      return state ? state.results : [];
    } catch (error) {
      this.signal.throwIfAborted();
      if (error instanceof ApplicationError) throw error;
      await assertLinkedInPage(this.page);
      let diagnostic = '';
      if (this.diagnosticsDirectory) {
        try {
          const report = await this.page.evaluate(searchLayoutReport);
          await mkdir(this.diagnosticsDirectory, {
            recursive: true,
            mode: 0o700,
          });
          const path = join(
            this.diagnosticsDirectory,
            `search-layout-${Date.now()}-${process.pid}.json`,
          );
          await writeFile(path, JSON.stringify(report, null, 2), {
            mode: 0o600,
          });
          diagnostic = ` Layout report: ${path} (${report.visibleProfileLinkCount} visible profile links).`;
        } catch {
          diagnostic = ' A layout report could not be saved.';
        }
      }
      throw new ApplicationError(
        `Cannot parse LinkedIn search results after waiting for complete cards.${diagnostic} Collected rows are preserved.`,
      );
    }
  }

  private async waitForProfile(): Promise<void> {
    try {
      await this.page.waitForFunction(
        ({ missing, restriction }) => {
          if (
            /\/(?:login|uas\/login|authwall|checkpoint|challenge)(?:\/|$)/i.test(
              location.pathname,
            )
          )
            return true;
          const main = document.querySelector<HTMLElement>(
            'main, [role="main"]',
          );
          const text = main?.innerText ?? document.body.innerText;
          if (
            new RegExp(missing, 'i').test(text) ||
            new RegExp(restriction, 'i').test(text)
          )
            return true;
          if (!main) return false;
          return !!main.querySelector('h1');
        },
        {
          missing: missingText.source,
          restriction: restrictionText.source,
        },
      );
    } catch {
      this.signal.throwIfAborted();
      throw new ApplicationError(
        'LinkedIn content did not load in a recognized layout. Review the browser and English interface; progress is preserved.',
      );
    }
    this.signal.throwIfAborted();
    await assertLinkedInPage(this.page);
  }

  async search(
    criteria: SearchCriteria,
    onResult: (investor: Investor) => void,
  ): Promise<number> {
    const seen = new Set<string>();
    for (let index = 1; index <= criteria.max_pages; index++) {
      const status = await this.navigate(searchUrl(criteria.keywords, index));
      if (status === 404)
        throw new ApplicationError('LinkedIn search is unavailable. Stopping.');
      const results = await this.searchResults();
      if (!results.length) {
        const text = await pageText(this.page);
        if (noResultsText.test(text)) break;
        throw new ApplicationError(
          'Cannot parse LinkedIn search results. Review the browser layout; collected rows are preserved.',
        );
      }
      let added = 0;
      for (const investor of results) {
        this.signal.throwIfAborted();
        if (seen.has(investor.slug)) continue;
        seen.add(investor.slug);
        onResult(investor);
        added++;
        if (seen.size >= criteria.max_results) return seen.size;
      }
      if (!added) break;
      const next = this.page.getByRole('button', { name: /^Next$/i }).first();
      if (!(await next.isVisible()) || !(await next.isEnabled())) break;
    }
    return seen.size;
  }

  async readProfile(slug: string): Promise<Profile | null> {
    if (
      profileSlug(
        `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
      ) !== slug
    )
      return null;
    const status = await this.navigate(
      `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
    );
    if (status === 404) return null;
    await this.waitForProfile();
    const text = await pageText(this.page);
    if (
      missingText.test(text) &&
      !(await this.page.locator('main h1, [role="main"] h1').count())
    )
      return null;
    const actualSlug = profileSlug(this.page.url());
    if (actualSlug !== slug) {
      throw new ApplicationError(
        'LinkedIn redirected to a different profile. Stopping for manual review.',
      );
    }
    return extractProfile(this.page, slug);
  }
}

export async function openLinkedIn(
  settings: Config['linkedin'],
  signal: AbortSignal,
  log: (text: string) => void,
) {
  if (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    throw new ApplicationError(
      'A desktop display is required for the visible browser. Run this CLI in a graphical desktop session.',
    );
  }
  await mkdir(settings.session_dir, { recursive: true, mode: 0o700 });
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(settings.session_dir, {
      headless: false,
      acceptDownloads: false,
    });
  } catch {
    throw new ApplicationError(
      'Cannot start Chromium. Run npm run browser:install and ensure this session directory is not in use.',
    );
  }
  const onAbort = () => {
    void context.close().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  context.setDefaultTimeout(settings.timeout_ms);
  context.setDefaultNavigationTimeout(settings.timeout_ms);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
    });
    const path = new URL(page.url()).pathname;
    if (checkpointPath.test(path)) await assertLinkedInPage(page);
    if (loginPath.test(path)) {
      log(
        'Sign in manually in the browser. Waiting for your LinkedIn feed; credentials are not read by the CLI.',
      );
      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForURL(
        (url) =>
          url.hostname === 'www.linkedin.com' &&
          url.pathname.startsWith('/feed'),
        { timeout: settings.login_timeout_ms },
      );
    }
    signal.throwIfAborted();
    await assertLinkedInPage(page);
    return {
      reader: new LinkedInBrowser(
        page,
        signal,
        join(dirname(settings.session_dir), 'diagnostics'),
      ),
      close: async () => {
        signal.removeEventListener('abort', onAbort);
        await context.close();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    await context.close();
    signal.throwIfAborted();
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(
      'LinkedIn login or startup timed out. Restart and complete login in the visible browser.',
    );
  }
}
