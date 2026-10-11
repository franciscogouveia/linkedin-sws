import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { LinkedInMessengerBrowser } from '../src/infrastructure/linkedin/composer.ts';
import { composerFailure } from '../src/infrastructure/linkedin/composer-errors.ts';
import { investor, temporaryDirectory } from './helpers.ts';

test('composer failures preserve the cause without URLs, names, identifiers, or call logs', () => {
  const error = new Error(
    `locator.click: Timeout 30000ms exceeded for ${investor.name} at https://www.linkedin.com/in/${investor.slug}/\nCall log: private details`,
  );
  error.name = 'TimeoutError';
  const text = composerFailure(
    error,
    'opening profile Message action',
    investor,
  );
  assert.match(text, /opening profile Message action/);
  assert.match(text, /TimeoutError: locator.click: Timeout 30000ms exceeded/);
  for (const privateText of [
    investor.name,
    investor.slug,
    'https://',
    'private details',
  ])
    assert.ok(!text.includes(privateText));
});

test('composer errors identify profile wait, Message click, and composer wait separately', async (t) => {
  for (const stage of ['profile', 'click', 'composer'] as const) {
    await t.test(stage, async (t) => {
      const directory = await temporaryDirectory(t);
      const timeout = new Error(
        'Timeout 30000ms exceeded.\nCall log: not retained',
      );
      timeout.name = 'TimeoutError';
      let waits = 0;
      let clicked = false;
      const locator = {
        count: async () => 1,
        innerText: async () => 'Profile',
        allTextContents: async () => [],
        isEnabled: async () => true,
        waitFor: async () => {},
        getAttribute: async () => null,
        click: async () => {
          if (stage === 'click') throw timeout;
          clicked = true;
        },
        first: () => locator,
        getByRole: () => locator,
        or: () => locator,
        and: () => locator,
        filter: () => locator,
      };
      const page = {
        on: () => {},
        removeListener: () => {},
        waitForLoadState: async () => {},
        bringToFront: async () => {},
        goto: async () => ({ status: () => 200 }),
        url: () => `https://www.linkedin.com/in/${investor.slug}/`,
        isClosed: () => false,
        locator: () => locator,
        waitForFunction: async () => {
          if (waits++ > 0 || stage === 'profile') throw timeout;
          return {
            jsonValue: async () => ({ kind: 'profile', name: investor.name }),
            dispose: async () => {},
          };
        },
        frames: () => [],
        evaluate: async () => ({
          dialogs: 2,
          visibleDialogs: 0,
          editableFields: 0,
        }),
      } as unknown as Page;
      const context = {
        newPage: async () => page,
      } as unknown as BrowserContext;
      const expected =
        stage === 'profile'
          ? 'waiting for recipient profile'
          : stage === 'click'
            ? 'opening profile Message action'
            : 'waiting for message composer after opening Message';
      await assert.rejects(
        new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          directory,
          1,
        ).openComposer(investor),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(expected));
          if (stage !== 'composer') assert.match(error.message, /TimeoutError/);
          else assert.match(error.message, /no recognized recipient editor/);
          return true;
        },
      );
      const [file] = await readdir(directory);
      const report = JSON.parse(await readFile(join(directory, file!), 'utf8'));
      assert.equal(report.stage, expected);
      assert.equal(
        report.action,
        stage === 'profile'
          ? 'not attempted'
          : stage === 'click'
            ? 'clicking profile Message control'
            : 'profile Message control clicked',
      );
      assert.equal(report.visibleDialogs, 0);
      assert.equal(clicked, stage === 'composer');
    });
  }
});

test('a verified profile slug permits display-name differences and follows its anchor after full load', async () => {
  const events: string[] = [];
  let url = `https://www.linkedin.com/in/${investor.slug}/`;
  const locator = {
    count: async () => 1,
    innerText: async () => 'Page',
    allTextContents: async () => [],
    isEnabled: async () => true,
    waitFor: async () => {},
    getAttribute: async () => '/messaging/compose/?recipient=example',
    click: async () => {
      throw new Error('The messaging anchor should be followed');
    },
    first: () => locator,
    getByRole: () => locator,
    or: () => locator,
    and: () => locator,
    filter: () => locator,
  };
  const frame = {
    url: () => url,
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async () => ({ kind: 'chat' }),
    page: () => page,
    locator: () => locator,
  };
  const page = {
    on: () => {},
    removeListener: () => {},
    bringToFront: async () => {},
    goto: async (next: string) => {
      url = next;
      events.push(
        next.includes('/messaging/')
          ? 'messaging navigation'
          : 'profile navigation',
      );
      return { status: () => 200 };
    },
    waitForLoadState: async (state: string) => {
      assert.equal(state, 'load');
      events.push('full profile load');
    },
    url: () => url,
    isClosed: () => false,
    locator: () => locator,
    frames: () => [frame],
    waitForFunction: async () => ({
      jsonValue: async () => ({
        kind: 'profile',
        name: `${investor.name}, PhD`,
      }),
      dispose: async () => {},
    }),
  };
  const context = { newPage: async () => page } as unknown as BrowserContext;
  const composer = await new LinkedInMessengerBrowser(
    context,
    new AbortController().signal,
  ).openComposer(investor);
  assert.equal(composer.kind, 'chat');
  assert.deepEqual(events, [
    'profile navigation',
    'full profile load',
    'messaging navigation',
  ]);
});

test('account guard errors retain their fatal type across composer diagnostics', async () => {
  const { LinkedInSessionError } = await import('../src/shared/errors.ts');
  const checkpoint = new LinkedInSessionError('Account checkpoint');
  const page = {
    on: () => {},
    removeListener: () => {},
    bringToFront: async () => {
      throw checkpoint;
    },
    isClosed: () => true,
  } as unknown as Page;
  const context = { newPage: async () => page } as unknown as BrowserContext;
  await assert.rejects(
    new LinkedInMessengerBrowser(
      context,
      new AbortController().signal,
    ).openComposer(investor),
    (error: unknown) => error === checkpoint,
  );
});

test('filling checks only the selected recipient and writes text without reading the draft', async () => {
  const fills: string[] = [];
  let selected = true;
  let url = `https://www.linkedin.com/in/${investor.slug}/`;
  const locator = {
    count: async () => 1,
    innerText: async () => 'Page',
    allTextContents: async () => [],
    isEnabled: async () => true,
    waitFor: async () => {},
    getAttribute: async () => '/messaging/thread/example/',
    first: () => locator,
    getByRole: () => locator,
    or: () => locator,
    and: () => locator,
    filter: () => locator,
  };
  const frame = {
    url: () => url,
    parentFrame: () => null,
    isDetached: () => false,
    evaluate: async () => (selected ? { kind: 'chat' } : false),
    page: () => page,
    locator: () => ({
      fill: async (text: string) => {
        fills.push(text);
      },
      evaluate: async () => {
        throw new Error('Must not read or validate draft text');
      },
    }),
  };
  const page = {
    on: () => {},
    removeListener: () => {},
    bringToFront: async () => {},
    goto: async (next: string) => {
      url = next;
      return { status: () => 200 };
    },
    waitForLoadState: async () => {},
    url: () => url,
    isClosed: () => false,
    locator: () => locator,
    frames: () => [frame],
    waitForFunction: async () => ({
      jsonValue: async () => ({ kind: 'profile', name: investor.name }),
      dispose: async () => {},
    }),
  };
  const context = { newPage: async () => page } as unknown as BrowserContext;
  const composer = await new LinkedInMessengerBrowser(
    context,
    new AbortController().signal,
  ).openComposer(investor);
  await composer.fill({ body: 'Saved funding pitch' });
  assert.deepEqual(fills, ['Saved funding pitch']);
  selected = false;
  await assert.rejects(
    composer.fill({ body: 'Another pitch' }),
    /selected message recipient changed/,
  );
  assert.deepEqual(fills, ['Saved funding pitch']);
});
