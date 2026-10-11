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
  existingSubject = '',
) {
  return `${header}<script>
    window.sent = 0;
    document.querySelector('#message').onclick = () => {
      const composer = document.createElement('div');
      composer.setAttribute('role', 'dialog');
      composer.innerHTML = '<h2><a href="/in/${recipient}/">Alex Example</a></h2>${kind === 'inmail' ? `<input aria-label="Subject" placeholder="Subject" value="${existingSubject}">` : ''}<div role="textbox" contenteditable="true">${existing}</div><button id="send">Send</button>';
      document.body.append(composer);
      composer.querySelector('#send').onclick = () => {
        window.sent++;
        const editor = composer.querySelector('[contenteditable]');
        const message = document.createElement('p');
        message.className = 'msg-s-event-listitem__body';
        message.textContent = editor.innerText;
        composer.append(message);
        editor.textContent = '';
      };
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
    for (const kind of ['chat', 'inmail'] as const) {
      await t.test(
        `live send ${kind} clicks exactly once after verification`,
        async () => {
          const context = await browser.newContext();
          context.setDefaultTimeout(500);
          await context.route('**/*', (route) =>
            route.fulfill({ contentType: 'text/html', body: fixture(kind) }),
          );
          const composer = await new LinkedInMessengerBrowser(
            context,
            new AbortController().signal,
            undefined,
            500,
          ).openComposer(investor);
          await composer.fill({
            body: 'Hello Alex, could we discuss funding?',
            ...(kind === 'inmail' ? { subject: 'Funding Acme' } : {}),
          });
          let recorded = false;
          await composer.send!(() => {
            recorded = true;
          });
          assert.equal(recorded, true);
          assert.equal(
            await context
              .pages()[0]!
              .evaluate(() => (window as unknown as { sent: number }).sent),
            1,
          );
          await assert.rejects(
            composer.send!(() => {
              throw new Error('Must not record twice');
            }),
            /No unsent draft/,
          );
          assert.equal(
            await context
              .pages()[0]!
              .evaluate(() => (window as unknown as { sent: number }).sent),
            1,
          );
          await context.close();
        },
      );
    }
    await t.test(
      'live send validates only recipient identity before clicking',
      async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(500);
        await context.route('**/*', (route) =>
          route.fulfill({ contentType: 'text/html', body: fixture('chat') }),
        );
        const composer = await new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          500,
        ).openComposer(investor);
        await composer.fill({ body: 'Funding Acme' });
        await context
          .pages()[0]!
          .locator('[contenteditable]')
          .fill('Edited pitch');
        await context
          .pages()[0]!
          .evaluate(() =>
            document
              .querySelector('[role=dialog]')!
              .insertAdjacentHTML('beforeend', '<button>Send</button>'),
          );
        await composer.send!(() => {});
        assert.equal(
          await context
            .pages()[0]!
            .evaluate(() => (window as unknown as { sent: number }).sent),
          1,
        );
        await context.close();
      },
    );
    await t.test(
      'message center chat matches an ordinary recipient label outside history',
      async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(500);
        const profileHtml = header.replace(
          '<button id="message">Message</button>',
          '<a id="message" href="/messaging/thread/example/">Message</a>',
        );
        const chatHtml = `<main><aside><h2>Wrong Recipient</h2></aside><div class="custom-conversation-pane"><div class="custom-conversation-title"><span>${investor.name}<span class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">View profile information</span></span><button>InMail</button></div><div class="msg-thread"><a href="/in/unrelated-person/">Another profile</a><div class="msg-s-message-list"><p>Previous InMail</p></div><div contenteditable="true" role="textbox" aria-label="Write a message"></div><button id="send">Send</button></div></div></main><script>window.sent = 0; document.querySelector('#send').onclick = () => window.sent++;</script>`;
        await context.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: new URL(route.request().url()).pathname.startsWith(
              '/messaging/',
            )
              ? chatHtml
              : profileHtml,
          }),
        );
        const composer = await new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          500,
        ).openComposer(investor);
        assert.equal(composer.kind, 'chat');
        await composer.fill({ body: 'Funding Acme' });
        assert.equal(
          await context.pages()[0]!.locator('[contenteditable]').innerText(),
          'Funding Acme',
        );
        assert.equal(
          await context
            .pages()[0]!
            .evaluate(() => (window as unknown as { sent: number }).sent),
          0,
        );
        await context.close();
      },
    );
    for (const layout of ['link', 'frame', 'popup'] as const) {
      await t.test(`messaging in ${layout}`, async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(1_000);
        const composerHtml = `<main><div class="msg-thread"><h2><a href="/in/${investor.slug}/">${investor.name}</a></h2><textarea aria-label="Write a message"></textarea><button id="send">Send</button></div></div></main><script>window.sent = 0; document.querySelector('#send').onclick = () => window.sent++;</script>`;
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
    await t.test(
      'rich-text paragraph rendering and draft profile links preserve verification',
      async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(500);
        await context.route('**/*', (route) =>
          route.fulfill({ contentType: 'text/html', body: fixture('inmail') }),
        );
        const composer = await new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          500,
        ).openComposer(investor);
        await context.pages()[0]!.evaluate(() => {
          const editor =
            document.querySelector<HTMLElement>('[contenteditable]')!;
          editor.addEventListener('input', () => {
            const text = editor.innerText;
            editor.replaceChildren();
            for (const line of text.split('\n')) {
              const paragraph = document.createElement('p');
              paragraph.textContent = line || '\u00a0';
              editor.append(paragraph);
            }
            const signature = editor.lastElementChild!;
            const link = document.createElement('a');
            link.href = 'https://www.linkedin.com/in/founder-example/';
            link.textContent = signature.textContent;
            signature.replaceChildren(link);
          });
        });
        await composer.fill({
          body: 'Hello Alex,\n\nCould we discuss funding?\nhttps://www.linkedin.com/in/founder-example/',
          subject: 'Funding Acme',
        });
        assert.equal(
          await context
            .pages()[0]!
            .evaluate(() => (window as unknown as { sent: number }).sent),
          0,
        );
        await context.close();
      },
    );
    for (const [kind, existingBody, existingSubject] of [
      ['chat', 'Funding Acme', ''],
      ['inmail', 'Funding Acme', 'Funding round'],
      ['inmail', 'Funding Acme', ''],
      ['inmail', '', 'Funding round'],
    ] as const) {
      await t.test(
        `fill ${kind} fields: body=${!!existingBody}, subject=${!!existingSubject}`,
        async () => {
          const context = await browser.newContext();
          context.setDefaultTimeout(500);
          await context.route('**/*', (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: fixture(kind, investor.slug, existingBody, existingSubject),
            }),
          );
          const composer = await new LinkedInMessengerBrowser(
            context,
            new AbortController().signal,
            undefined,
            500,
          ).openComposer(investor);
          await composer.fill({
            body: 'Funding Acme',
            ...(kind === 'inmail' ? { subject: 'Funding round' } : {}),
          });
          assert.equal(
            await context.pages()[0]!.locator('[contenteditable]').innerText(),
            'Funding Acme',
          );
          if (kind === 'inmail')
            assert.equal(
              await context.pages()[0]!.locator('input').inputValue(),
              'Funding round',
            );
          assert.equal(
            await context
              .pages()[0]!
              .evaluate(() => (window as unknown as { sent: number }).sent),
            0,
          );
          await context.close();
        },
      );
    }
    await t.test(
      'saved text fills the selected recipient fields despite an existing subject',
      async () => {
        const context = await browser.newContext();
        context.setDefaultTimeout(500);
        await context.route('**/*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: fixture('inmail', investor.slug, '', 'Other funding'),
          }),
        );
        const composer = await new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          undefined,
          500,
        ).openComposer(investor);
        await composer.fill({ body: 'Funding Acme', subject: 'Funding round' });
        assert.equal(
          await context.pages()[0]!.locator('[contenteditable]').innerText(),
          'Funding Acme',
        );
        assert.equal(
          await context.pages()[0]!.locator('input').inputValue(),
          'Funding round',
        );
        await context.close();
      },
    );
    await t.test(
      'saved message replaces an existing draft for the verified recipient',
      async () => {
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
        await composer.fill({ body: 'Replacement' });
        assert.equal(
          await context.pages()[0]!.locator('[contenteditable]').innerText(),
          'Replacement',
        );
        await context.close();
      },
    );
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
      'an unavailable editor fails normally without checking upgrade text',
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
          /no recognized recipient editor/,
        );
        assert.equal(context.pages().length, 1);
        await context.close();
      },
    );
  },
);
