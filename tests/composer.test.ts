import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';
import { LinkedInMessengerBrowser } from '../src/infrastructure/linkedin/composer.ts';
import { investor } from './helpers.ts';

const header =
  '<main><section class="pv-top-card"><h1>Alex Example</h1><p>Angel Investor</p><button id="message">Message</button></section><section><h2>About</h2><p>I invest in software.</p></section></main>';
function fixture(
  kind: 'chat' | 'inmail',
  recipient = investor.slug,
  existing = '',
) {
  return `${header}<script>
    window.sent = 0;
    document.querySelector('#message').onclick = () => {
      const composer = document.createElement('div');
      composer.setAttribute('role', 'dialog');
      composer.innerHTML = '<h2><a href="/in/${recipient}/">Alex Example</a></h2>${kind === 'inmail' ? '<input aria-label="Subject" placeholder="Subject">' : ''}<div role="textbox" contenteditable="true">${existing}</div><button id="send">Send</button>';
      document.body.append(composer);
      composer.querySelector('#send').onclick = () => window.sent++;
      composer.onkeydown = (event) => { if (event.key === 'Enter') window.sent++; };
    };
  </script>`;
}

test(
  'browser draft fixtures: separate tabs, chat/InMail, existing drafts, recipient and send protection',
  { skip: !existsSync(chromium.executablePath()) },
  async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    for (const kind of ['chat', 'inmail'] as const) {
      await t.test(kind, async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(500);
        await context.route('**/*', (route) =>
          route.fulfill({ contentType: 'text/html', body: fixture(kind) }),
        );
        const messenger = new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          500,
        );
        const first = await messenger.openComposer(investor);
        await first.fill({
          body: 'Hello Alex,\nFunding opportunity.',
          ...(kind === 'inmail' ? { subject: 'Funding Acme' } : {}),
        });
        await messenger.openComposer(investor);
        assert.equal(context.pages().length, 2);
        assert.equal(first.kind, kind);
        assert.equal(
          await context
            .pages()[0]!
            .evaluate(() => (window as unknown as { sent: number }).sent),
          0,
        );
        assert.equal(
          await context.pages()[0]!.locator('[contenteditable]').innerText(),
          'Hello Alex,\nFunding opportunity.',
        );
        await context.close();
      });
    }
    for (const layout of ['link', 'frame', 'popup'] as const) {
      await t.test(`messaging in ${layout}`, async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(1_000);
        const composerHtml = `<main><div class="msg-thread"><h2><a href="/in/${investor.slug}/">${investor.name}</a></h2><textarea aria-label="Write a message"></textarea><button id="send">Send</button></div></main><script>window.sent = 0; document.querySelector('#send').onclick = () => window.sent++;</script>`;
        const profileHtml =
          layout === 'link'
            ? header.replace(
                '<button id="message">Message</button>',
                '<a id="message" href="/messaging/thread/test/">Message</a>',
              ) +
              '<script>document.querySelector("#message").onclick = (event) => event.preventDefault();</script>'
            : header +
              `<script>document.querySelector('#message').onclick = () => { ${layout === 'frame' ? 'const frame = document.createElement("iframe"); frame.src = "/messaging/thread/test/"; document.body.append(frame);' : 'window.open("/messaging/thread/test/");'} };</script>`;
        await context.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: new URL(route.request().url()).pathname.startsWith(
              '/messaging/',
            )
              ? composerHtml
              : profileHtml,
          }),
        );
        const messenger = new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          1_000,
        );
        const composer = await messenger.openComposer(investor);
        await composer.fill({ body: 'Funding Acme' });
        const targetPage =
          layout === 'popup' ? context.pages()[1]! : context.pages()[0]!;
        const target = targetPage
          .frames()
          .find((frame) => frame.url().includes('/messaging/'))!;
        assert.equal(
          await target.locator('textarea').inputValue(),
          'Funding Acme',
        );
        assert.equal(
          await target.evaluate(
            () => (window as unknown as { sent: number }).sent,
          ),
          0,
        );
        await context.close();
      });
    }
    await t.test('nonempty draft is untouched', async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(500);
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: fixture('chat', investor.slug, 'Existing draft'),
        }),
      );
      const composer = await new LinkedInMessengerBrowser(
        context,
        new AbortController().signal,
        undefined,
        500,
      ).openComposer(investor);
      await assert.rejects(
        composer.fill({ body: 'Replacement' }),
        /existing nonempty draft/i,
      );
      assert.equal(
        await context.pages()[0]!.locator('[contenteditable]').innerText(),
        'Existing draft',
      );
      await context.close();
    });
    await t.test('wrong recipient leaves text untouched', async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(100);
      await context.route('**/*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: fixture('chat', 'wrong-recipient'),
        }),
      );
      await assert.rejects(
        new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          100,
        ).openComposer(investor),
        /waiting for message composer after opening Message/,
      );
      assert.equal(
        await context.pages()[0]!.locator('[contenteditable]').innerText(),
        '',
      );
      await context.close();
    });
    await t.test(
      'explicit upgrade fails and closes the unavailable draft tab',
      async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(500);
        await context.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `${header}<script>document.querySelector('#message').onclick = () => { document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Upgrade to Premium to send InMail</div>'); };</script>`,
          }),
        );
        await assert.rejects(
          new LinkedInMessengerBrowser(
            context,
            new AbortController().signal,
            undefined,
            500,
          ).openComposer(investor),
          /requires an upgrade/,
        );
        assert.equal(context.pages().length, 0);
        await context.close();
      },
    );
  },
);
