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
            : 'waiting for message composer after clicking Message';
      await assert.rejects(
        new LinkedInMessengerBrowser(
          context,
          new AbortController().signal,
          directory,
        ).openComposer(investor),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(expected));
          assert.match(error.message, /TimeoutError/);
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
