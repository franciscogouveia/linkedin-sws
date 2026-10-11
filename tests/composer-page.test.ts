import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  inspectComposer,
  composerLayoutReport,
} from '../src/infrastructure/linkedin/composer-page.ts';
import { investor } from './helpers.ts';

// Minimal DOM stand-ins exercise the serialized browser function without Chromium.
// Browser fixtures separately cover the real HTML selectors and editor filling.
function inspect(
  options: {
    name?: string;
    selector?: string;
    editorLabel?: string;
    subject?: boolean;
    excludedName?: boolean;
    linkSlug?: string;
    headerLink?: boolean;
    text?: string;
    report?: boolean;
  } = {},
) {
  const attributes = new Map<string, string>();
  const element = (text = '', label = '') => ({
    textContent: text,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    getAttribute: (key: string) =>
      key === 'aria-label' ? label : (attributes.get(key) ?? null),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
    closest: (_selector: string): object | null => null,
  });
  const name = element(options.name ?? investor.name);
  name.closest = () => (options.excludedName ? {} : null);
  const body = element('', options.editorLabel ?? 'Write a message');
  const subject = element('', 'Subject');
  const link = {
    ...element(),
    href: `https://www.linkedin.com/in/${options.linkSlug}/`,
  };
  link.closest = (selector: string) =>
    selector.startsWith('header,') && options.headerLink !== false ? {} : null;
  const root = {
    ...element(options.text ?? `${investor.name} Chat history. InMail`),
    querySelector: (selector: string) =>
      selector.includes('contenteditable') ? body : null,
    querySelectorAll: (selector: string) => {
      if (selector.includes('subject')) return options.subject ? [subject] : [];
      if (selector.includes('contenteditable')) return [body];
      if (selector.includes('a[href')) return options.linkSlug ? [link] : [];
      if (selector.includes(options.selector ?? 'h2')) return [name];
      return [];
    },
  };
  const document = {
    querySelector: () => root,
    querySelectorAll: (selector: string) => {
      if (selector.includes('data-sws-')) return [];
      if (
        selector.includes('[role="dialog"]') ||
        selector.includes('.msg-thread')
      )
        return [root];
      return [];
    },
  };
  const context = {
    document,
    location: { pathname: '/messaging/thread/example/' },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  };
  return runInNewContext(
    `(${(options.report ? composerLayoutReport : inspectComposer).toString()})(input)`,
    {
      ...context,
      input: { name: investor.name, slug: investor.slug, token: 'test-token' },
    },
  ) as
    | {
        kind?: string;
        composerCandidates?: {
          recipientNameMatches: number;
          inmailEditorLabels: number;
        }[];
      }
    | false;
}

test('regular chat is recognized despite an InMail action or old InMail text', () => {
  const result = inspect({
    text: `${investor.name} InMail Chat history.`,
    selector: 'h2',
  });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
});

test('message-center recipient title verifies a chat without a profile link', () => {
  const result = inspect({ selector: '.msg-entity-lockup__entity-title' });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
  assert.equal(
    inspect({
      selector: '.msg-entity-lockup__entity-title',
      name: 'Another Recipient',
    }),
    false,
  );
});

test('recipient names in history or conversation lists cannot verify the editor', () => {
  assert.equal(inspect({ excludedName: true }), false);
  assert.equal(inspect({ linkSlug: 'wrong-recipient' }), false);
});

test('editor labels do not gate filling; only a subject field identifies InMail', () => {
  const chat = inspect({ editorLabel: 'Write an InMail' });
  assert.ok(chat);
  assert.equal(chat.kind, 'chat');
  const result = inspect({ editorLabel: 'Write an InMail', subject: true });
  assert.ok(result);
  assert.equal(result.kind, 'inmail');
});

test('diagnostics report recipient matches for message-center containers without saving names', () => {
  const result = inspect({
    selector: '.msg-entity-lockup__entity-title',
    report: true,
  });
  assert.ok(result);
  assert.equal(result.composerCandidates?.[0]?.recipientNameMatches, 1);
  assert.equal(result.composerCandidates?.[0]?.inmailEditorLabels, 0);
  assert.ok(!JSON.stringify(result).includes(investor.name));
});

test('unrelated profile links do not block an exact active-recipient name match', () => {
  const result = inspect({ linkSlug: 'unrelated-person', headerLink: false });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
});

test('a wrong recipient header link cannot be overridden by a matching name', () => {
  assert.equal(
    inspect({ linkSlug: 'wrong-recipient', headerLink: true }),
    false,
  );
});

test('plain semantic header text identifies the recipient without a LinkedIn-specific class', () => {
  const result = inspect({ selector: 'header span' });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
});
