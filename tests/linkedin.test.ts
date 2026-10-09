import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  LinkedInBrowser,
  assertLinkedInPage,
  extractProfile,
  extractSearchResults,
  profileSlug,
  searchUrl,
} from '../src/infrastructure/linkedin/browser.ts';
import { searchLayoutReport } from '../src/infrastructure/linkedin/search-page.ts';
import { profileLayoutReport } from '../src/infrastructure/linkedin/profile-page.ts';
import { investor, temporaryDirectory } from './helpers.ts';

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

const modernSearchFixture = `<div role="main">
  <nav><a href="/in/account-owner/">Account Owner</a></nav>
  <div class="result-wrapper">
    <div class="result-card"><div><a href="/in/alex-example/">Alex Example · 2nd</a></div><p>Angel investor in software</p><button>Connect</button></div>
    <div class="result-card"><div><a href="/in/blair-example/" aria-label="View Blair Example’s profile"><img alt="Avatar"></a><a href="/in/blair-example/">Blair Example</a></div><p>VC Partner</p><button>Message</button></div>
  </div>
  <aside><div><a href="/in/recommendation/">Unrelated Recommendation</a><p>Investor</p></div></aside>
</div>`;

test('search waits for parsed cards and releases its page handle', async () => {
  let disposed = false;
  const main = { count: async () => 1, innerText: async () => 'Results' };
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'https://www.linkedin.com/search/results/people/',
    locator: (selector: string) => ({
      first: () => main,
      allTextContents: async () => [],
      count: async () => (selector.includes('a[href') ? 1 : 0),
    }),
    waitForFunction: async () => ({
      jsonValue: async () => ({ kind: 'results', results: [investor] }),
      dispose: async () => {
        disposed = true;
      },
    }),
  } as unknown as Page;
  const rows: string[] = [];
  const count = await new LinkedInBrowser(
    page,
    new AbortController().signal,
  ).search({ keywords: 'angel', max_results: 1, max_pages: 1 }, (row) => {
    rows.push(row.slug);
  });
  assert.equal(count, 1);
  assert.deepEqual(rows, [investor.slug]);
  assert.equal(disposed, true);
});

test('search parsing timeout saves a layout report and preserves a useful error', async (t) => {
  const directory = await temporaryDirectory(t);
  const main = {
    count: async () => 1,
    innerText: async () => 'Unrecognized layout',
  };
  const report = {
    path: '/search/results/people/',
    mainFound: true,
    profileLinkCount: 3,
    visibleProfileLinkCount: 2,
    listItemCount: 0,
    samples: [],
  };
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'https://www.linkedin.com/search/results/people/',
    locator: () => ({
      first: () => main,
      allTextContents: async () => [],
      count: async () => 1,
    }),
    waitForFunction: async () => {
      throw new Error('Timeout');
    },
    evaluate: async () => report,
  } as unknown as Page;
  const reader = new LinkedInBrowser(
    page,
    new AbortController().signal,
    directory,
  );
  await assert.rejects(
    reader.search(
      { keywords: 'angel', max_results: 1, max_pages: 1 },
      () => {},
    ),
    /Cannot parse.*Layout report:.*2 visible profile links/,
  );
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, files[0]!), 'utf8')),
    report,
  );
});

test('profile loading passes the queued name, releases the handle, and bounds returned text', async () => {
  let suppliedName: string | undefined;
  let disposed = false;
  const text = 'Angel investor\n'.repeat(2_000);
  const main = { count: async () => 1, innerText: async () => text };
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'https://www.linkedin.com/in/alex-example/',
    locator: () => ({
      first: () => main,
      allTextContents: async () => [],
      count: async () => 1,
    }),
    waitForFunction: async (
      _callback: unknown,
      options: { expectedName: string },
    ) => {
      suppliedName = options.expectedName;
      return {
        jsonValue: async () => ({ kind: 'profile', name: investor.name, text }),
        dispose: async () => {
          disposed = true;
        },
      };
    },
  } as unknown as Page;
  const result = await new LinkedInBrowser(
    page,
    new AbortController().signal,
  ).readProfile(investor.slug, investor.name);
  assert.equal(suppliedName, investor.name);
  assert.equal(disposed, true);
  assert.equal(result?.name, investor.name);
  assert.equal(result?.text.length, 24_000);
  assert.equal(result?.truncated, true);
});

test('profile timeout records structure and never becomes a missing-profile result', async (t) => {
  const directory = await temporaryDirectory(t);
  const main = {
    count: async () => 1,
    innerText: async () => 'Unrecognized profile layout',
  };
  const report = {
    path: '/in/<profile>/',
    mainFound: true,
    headingCount: 2,
    visibleHeadingCount: 2,
    expectedNameFound: true,
    iframeCount: 0,
    samples: [],
  };
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => 'https://www.linkedin.com/in/alex-example/',
    locator: () => ({
      first: () => main,
      allTextContents: async () => [],
      count: async () => 1,
    }),
    waitForFunction: async () => {
      throw new Error('Timeout');
    },
    evaluate: async () => report,
  } as unknown as Page;
  await assert.rejects(
    new LinkedInBrowser(
      page,
      new AbortController().signal,
      directory,
    ).readProfile(investor.slug, investor.name),
    /Cannot read.*profile-layout-.*Queue row remains working/,
  );
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, files[0]!), 'utf8')),
    report,
  );
});

const profileFixture = `<main>
  <section><h1>Alex Example</h1><div>Angel investor in software</div></section>
  <section><h2>About</h2><p>I invest in early-stage companies.</p></section>
  <section><h2>Experience</h2><p>Angel investor, Example Ventures</p></section>
  <section><h2>People you may know</h2><p>Unrelated person's investment preferences</p></section>
</main>`;

const modernProfileFixture = `<div role="main">
  <div class="profile-header"><h2>Alex Example</h2><p>Angel investor in software</p><button>Message</button></div>
  <div class="profile-card"><div><h2>About</h2></div><p>I invest in early-stage companies.</p></div>
  <div class="profile-card"><div><h2>Experience</h2></div><p>Angel investor, Example Ventures</p></div>
  <aside><h2>People you may know</h2><p>Unrelated person's investment preferences</p></aside>
</div>`;

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
      'div-based cards and role-main layouts exclude navigation and recommendations',
      async () => {
        fixture = modernSearchFixture;
        await page.goto('https://www.linkedin.com/search/results/people/');
        assert.deepEqual(await extractSearchResults(page), [
          {
            name: 'Alex Example',
            role: 'Angel investor in software',
            slug: 'alex-example',
          },
          { name: 'Blair Example', role: 'VC Partner', slug: 'blair-example' },
        ]);
      },
    );

    await t.test(
      'search waits until delayed headline content has rendered',
      async () => {
        fixture = `<main><div><a href="/in/alex-example/">Alex Example</a><p id="headline"></p></div>
        <script>setTimeout(() => document.querySelector('#headline').textContent = 'Angel investor', 100)</script></main>`;
        const rows: string[] = [];
        assert.equal(
          await new LinkedInBrowser(page, new AbortController().signal).search(
            { keywords: 'angel', max_results: 1, max_pages: 1 },
            (row) => {
              rows.push(row.role);
            },
          ),
          1,
        );
        assert.deepEqual(rows, ['Angel investor']);
      },
    );

    await t.test(
      'a profile link wrapping a complete card uses its heading as the name',
      async () => {
        fixture =
          '<main><div><a href="/in/alex-example/"><h3>Alex Example</h3><p>2nd degree</p><p>Angel investor in software</p></a></div></main>';
        await page.goto('https://www.linkedin.com/search/results/people/');
        assert.deepEqual(await extractSearchResults(page), [
          {
            name: 'Alex Example',
            role: 'Angel investor in software',
            slug: 'alex-example',
          },
        ]);
      },
    );

    await t.test(
      'layout reports omit profile identifiers, visible names, and search queries',
      async () => {
        fixture = modernSearchFixture;
        await page.goto(
          'https://www.linkedin.com/search/results/people/?keywords=private-query',
        );
        const report = await page.evaluate(searchLayoutReport);
        assert.equal(report.mainFound, true);
        assert.ok(report.profileLinkCount >= 2);
        const serialized = JSON.stringify(report);
        assert.ok(!serialized.includes('Alex Example'));
        assert.ok(!serialized.includes('alex-example'));
        assert.ok(!serialized.includes('private-query'));
        assert.match(serialized, /result-card/);
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
        assert.match(profile.sections?.header ?? '', /Angel investor/);
        assert.match(profile.sections?.about ?? '', /early-stage/);
        assert.match(profile.sections?.experience ?? '', /Example Ventures/);
        assert.ok(!profile.text.includes('Unrelated'));
      },
    );

    await t.test(
      'profile supports h2 names and div-based sections',
      async () => {
        fixture = modernProfileFixture;
        await page.goto('https://www.linkedin.com/in/alex-example/');
        const profile = await extractProfile(
          page,
          investor.slug,
          investor.name,
        );
        assert.equal(profile.name, investor.name);
        assert.match(profile.text, /early-stage/);
        assert.match(profile.text, /Example Ventures/);
        assert.ok(!profile.text.includes('Unrelated'));
      },
    );

    await t.test(
      'queued name can identify a plain-text header without a heading element',
      async () => {
        fixture = modernProfileFixture.replace(
          '<h2>Alex Example</h2>',
          '<p>Alex Example</p>',
        );
        await page.goto('https://www.linkedin.com/in/alex-example/');
        const profile = await extractProfile(
          page,
          investor.slug,
          investor.name,
        );
        assert.equal(profile.name, investor.name);
        assert.match(profile.text, /Angel investor in software/);
      },
    );

    await t.test(
      'profile loading waits for content beyond the name and action buttons',
      async () => {
        fixture = `<main><div><h2>Alex Example</h2><button>Message</button><p id="headline"></p></div>
        <script>setTimeout(() => document.querySelector('#headline').textContent = 'Angel investor in software', 100)</script></main>`;
        const profile = await new LinkedInBrowser(
          page,
          new AbortController().signal,
        ).readProfile(investor.slug, investor.name);
        assert.match(profile?.text ?? '', /Angel investor in software/);
      },
    );

    await t.test(
      'profile reports omit queued names, profile identifiers, and visible content',
      async () => {
        fixture = modernProfileFixture;
        await page.goto('https://www.linkedin.com/in/alex-example/');
        const report = await page.evaluate(profileLayoutReport, {
          expectedName: investor.name,
        });
        assert.equal(report.expectedNameFound, true);
        const serialized = JSON.stringify(report);
        for (const value of [
          'Alex Example',
          'alex-example',
          'Example Ventures',
          'early-stage',
        ])
          assert.ok(!serialized.includes(value));
        assert.match(serialized, /profile-header/);
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
