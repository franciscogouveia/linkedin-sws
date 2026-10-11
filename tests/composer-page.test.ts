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
    renderedName?: string;
    plainName?: boolean;
    mainOnly?: boolean;
    titleOutsideWrapper?: boolean;
    selector?: string;
    editorLabel?: string;
    subject?: boolean;
    bodyCount?: number;
    subjectCount?: number;
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
  const name = {
    ...element(options.name ?? investor.name),
    innerText: options.renderedName,
  };
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
    tagName: options.mainOnly ? 'MAIN' : 'DIV',
    ...element(options.text ?? `${investor.name} Chat history. InMail`),
    querySelector: (selector: string) =>
      selector.includes('contenteditable') ? body : null,
    querySelectorAll: (selector: string) => {
      if (selector.includes('subject'))
        return Array.from(
          { length: options.subjectCount ?? (options.subject ? 1 : 0) },
          () => subject,
        );
      if (selector.includes('contenteditable'))
        return Array.from({ length: options.bodyCount ?? 1 }, () => body);
      if (selector.includes('a[href')) return options.linkSlug ? [link] : [];
      if (selector === 'a, button, span, p, div')
        return options.plainName && !options.titleOutsideWrapper ? [name] : [];
      if (!options.plainName && selector.includes(options.selector ?? 'h2'))
        return [name];
      return [];
    },
  };
  if (options.titleOutsideWrapper) {
    const pane = {
      ...root,
      parentElement: null,
      querySelectorAll: (selector: string) =>
        selector === 'a, button, span, p, div'
          ? [name]
          : selector.includes('contenteditable')
            ? [body]
            : [],
    };
    Object.assign(body, { parentElement: pane });
  }
  const document = {
    querySelector: () => root,
    querySelectorAll: (selector: string) => {
      if (selector.includes('data-sws-')) return [];
      if (selector === '[contenteditable="true"], textarea')
        return options.titleOutsideWrapper ? [body] : [];
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
          paneNameMatches: number;
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

test('recipient verification reads rendered text instead of hidden accessibility text', () => {
  const result = inspect({
    name: `${investor.name}Hidden accessibility detail`,
    renderedName: investor.name,
  });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
});

test('known connection and status annotations do not change recipient identity', () => {
  for (const suffix of [
    ' • 1st',
    '\nStatus is online',
    '\nPremium',
    'Status is reachable',
    ' • 2nd degree connection',
  ]) {
    const result = inspect({ name: investor.name + suffix });
    assert.ok(result, suffix);
    assert.equal(result.kind, 'chat');
  }
  for (const suffix of ['ton', ' Junior', ' and Another Recipient'])
    assert.equal(inspect({ name: investor.name + suffix }), false);
});

test('diagnostics use the same visible-name matching as composer verification', () => {
  const result = inspect({
    name: investor.name + 'Status is online',
    report: true,
  });
  assert.ok(result);
  assert.equal(result.composerCandidates?.[0]?.recipientNameMatches, 1);
});

test('ordinary text in the active pane verifies the recipient without a heading class', () => {
  const result = inspect({ plainName: true });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
  const diagnostic = inspect({ plainName: true, report: true });
  assert.ok(diagnostic);
  assert.equal(diagnostic.composerCandidates?.[0]?.recipientNameMatches, 0);
  assert.equal(diagnostic.composerCandidates?.[0]?.paneNameMatches, 1);
});

test('plain-text fallback excludes history, other names, and the broad message center', () => {
  assert.equal(inspect({ plainName: true, excludedName: true }), false);
  assert.equal(inspect({ plainName: true, name: 'Other Recipient' }), false);
  assert.equal(inspect({ plainName: true, mainOnly: true }), false);
});

test('a verified recipient uses the first editor and subject without layout-count validation', () => {
  const result = inspect({ bodyCount: 2, subjectCount: 2 });
  assert.ok(result);
  assert.equal(result.kind, 'inmail');
});

test('recipient text outside a named conversation wrapper is found through editor ancestors', () => {
  const result = inspect({ plainName: true, titleOutsideWrapper: true });
  assert.ok(result);
  assert.equal(result.kind, 'chat');
});
