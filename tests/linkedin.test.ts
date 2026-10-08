import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import {
  LinkedInBrowser,
  assertLinkedInPage,
  extractProfile,
  extractSearchResults,
  profileSlug,
  searchUrl,
} from '../src/linkedin.ts';

test('profile identifiers and keyword searches preserve encoding and reject unrelated URLs', () => {
  assert.equal(profileSlug('/in/alex-example/?tracking=123'), 'alex-example');
  assert.equal(
    profileSlug('https://www.linkedin.com/in/alex-example'),
    'alex-example',
  );
  for (const href of [
    'https://evil.example/in/alex-example/',
    '/company/example/',
    '/in/alex%2Fwrong/',
    '/in/alex-example/details/',
  ]) {
    assert.equal(profileSlug(href), undefined);
  }
  const url = new URL(searchUrl('"angel investor" OR VC', 2));
  assert.equal(url.hostname, 'www.linkedin.com');
  assert.equal(url.searchParams.get('keywords'), '"angel investor" OR VC');
  assert.equal(url.searchParams.get('page'), '2');
});

const searchFixture = `<main><ul>
  <li class="reusable-search__result-container">
    <div class="entity-result__title-text"><a href="/in/alex-example/?tracking=1"><span aria-hidden="true">Alex Example</span><span class="visually-hidden">View Alex Example's profile</span></a></div>
    <div class="entity-result__primary-subtitle">Angel investor in software</div>
    <a href="/in/alex-example/">Alex Example</a>
  </li>
  <li class="reusable-search__result-container">
    <div class="entity-result__title-text"><a href="/in/blair-example/"><span aria-hidden="true">Blair Example</span></a></div>
    <div class="entity-result__primary-subtitle">VC Partner</div>
  </li>
  <li><a href="https://evil.example/in/incorrect/">Incorrect</a></li>
</ul><button aria-label="Next">Next</button></main>`;

const profileFixture = `<main>
  <section><h1>Alex Example</h1><div>Angel investor in software</div></section>
  <section><h2>About</h2><p>I invest in early-stage companies.</p></section>
  <section><h2>Experience</h2><p>Angel investor, Example Ventures</p></section>
  <section><h2>People you may know</h2><p>Unrelated person's investment preferences</p></section>
</main>`;

// Browser fixture checks use no LinkedIn account, API credentials, or real network.
test(
  'browser fixtures validate extraction, pagination, missing profiles, and account guards',
  {
    skip:
      !existsSync(chromium.executablePath()) &&
      'Install Chromium with npm run browser:install to run browser fixture checks.',
  },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(1_000);
    page.setDefaultNavigationTimeout(1_000);
    let fixture = searchFixture;
    let status = 200;
    await context.route('**/*', (route) =>
      route.fulfill({ status, contentType: 'text/html', body: fixture }),
    );

    await t.test(
      'search deduplicates profile links and reads names and roles',
      async () => {
        await page.goto('https://www.linkedin.com/search/results/people/');
        const results = await extractSearchResults(page);
        assert.deepEqual(
          results.map((row) => row.slug),
          ['alex-example', 'blair-example'],
        );
        assert.equal(results[0]?.name, 'Alex Example');
        assert.equal(results[0]?.role, 'Angel investor in software');
      },
    );

    await t.test(
      'profile extracts its owner, About, and Experience without recommendations',
      async () => {
        fixture = profileFixture;
        await page.goto('https://www.linkedin.com/in/alex-example/');
        const profile = await extractProfile(page, 'alex-example');
        assert.match(profile.text, /early-stage/);
        assert.match(profile.text, /Example Ventures/);
        assert.ok(!profile.text.includes('Unrelated'));
      },
    );

    const reader = new LinkedInBrowser(page, new AbortController().signal);
    await t.test(
      'search limits results and persists each result via the callback',
      async () => {
        fixture = searchFixture;
        const slugs: string[] = [];
        const count = await reader.search(
          { keywords: 'angel', max_results: 1, max_pages: 2 },
          (row) => {
            slugs.push(row.slug);
          },
        );
        assert.equal(count, 1);
        assert.deepEqual(slugs, ['alex-example']);
      },
    );

    await t.test(
      'repeated pagination ends without duplicating investors',
      async () => {
        fixture = searchFixture;
        const slugs: string[] = [];
        await reader.search(
          { keywords: 'angel', max_results: 5, max_pages: 3 },
          (row) => {
            slugs.push(row.slug);
          },
        );
        assert.deepEqual(slugs, ['alex-example', 'blair-example']);
        assert.equal(new URL(page.url()).searchParams.get('page'), '2');
      },
    );

    await t.test(
      'an explicit empty search is distinct from an unrecognized layout',
      async () => {
        fixture = '<main>No results found</main>';
        assert.equal(
          await reader.search(
            { keywords: 'angel', max_results: 5, max_pages: 1 },
            () => {},
          ),
          0,
        );
        fixture =
          '<main><a href="/in/alex-example/">Unexpected card layout</a></main>';
        await assert.rejects(
          reader.search(
            { keywords: 'angel', max_results: 5, max_pages: 1 },
            () => {},
          ),
          /Cannot parse/,
        );
      },
    );

    await t.test(
      'HTTP 404 and explicit missing-page notices return a missing profile',
      async () => {
        status = 404;
        fixture = '<main>This page does not exist</main>';
        assert.equal(await reader.readProfile('missing-example'), null);
        status = 200;
        fixture = "<p>This page doesn't exist</p>";
        assert.equal(await reader.readProfile('missing-example'), null);
      },
    );

    await t.test(
      'login, checkpoint, and account warning pages stop processing',
      async () => {
        for (const path of ['/login', '/checkpoint/challenge', '/feed/']) {
          fixture =
            '<main><div role="alert">Your account has been restricted</div></main>';
          await page.goto(`https://www.linkedin.com${path}`);
          await assert.rejects(
            assertLinkedInPage(page),
            /authentication|checkpoint|warning/,
          );
        }
      },
    );

    await t.test(
      'a login redirect returning 404 is never mistaken for a missing profile',
      async () => {
        const redirectedPage = {
          goto: async () => ({ status: () => 404 }),
          url: () => 'https://www.linkedin.com/login',
        } as unknown as Page;
        await assert.rejects(
          new LinkedInBrowser(
            redirectedPage,
            new AbortController().signal,
          ).readProfile('alex-example'),
          /authentication/,
        );
      },
    );
  },
);
