/** Runs inside the browser. It identifies only a visible, recipient-owned composer. */
export function inspectComposer(input: {
  name: string;
  slug: string;
  token: string;
}) {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  };
  const normalize = (text: string) =>
    text.replace(/\s+/g, ' ').trim().toLowerCase();
  const roots = [
    ...document.querySelectorAll(
      '[role="dialog"], .msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread',
    ),
  ].filter(visible);
  if (location.pathname.startsWith('/messaging/')) {
    const main = document.querySelector('main, [role="main"]');
    if (main && visible(main)) roots.push(main);
  }
  const matches: { root: Element; body: Element; subject?: Element }[] = [];
  for (const root of roots) {
    // Links in the generated draft or conversation history do not identify the
    // recipient. Prefer the conversation header when its profile link exists.
    const outsideMessage = (node: Element) =>
      !node.closest(
        '[contenteditable], textarea, .msg-s-message-list, .msg-s-event-listitem, .msg-s-message-group, aside, nav, [role="complementary"], .msg-conversations-container__conversations-list, .msg-conversation-list, .msg-conversation-listitem',
      );
    const profileLinks = [...root.querySelectorAll('a[href*="/in/"]')].filter(
      (node) => visible(node) && outsideMessage(node),
    );
    // Only recipient/header links constrain identity. Other profile links in the
    // pane must not reject an exact active-recipient name match.
    const links = profileLinks.filter((node) =>
      node.closest(
        'header, h1, h2, h3, [role="heading"], .msg-overlay-bubble-header, .msg-thread__top-card, .msg-thread__link-to-profile, .msg-thread__heading, .msg-entity-lockup',
      ),
    );
    const matchingSlug =
      links.length > 0 &&
      links.every((link) => {
        try {
          const url = new URL((link as HTMLAnchorElement).href);
          return (
            ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) &&
            decodeURIComponent(url.pathname).replace(/\/$/, '') ===
              `/in/${input.slug}`
          );
        } catch {
          return false;
        }
      });
    const names = [
      ...root.querySelectorAll(
        'h1, h2, h3, [role="heading"], header a, header button, header span, .msg-overlay-bubble-header__title, .msg-thread__link-to-profile, .msg-thread__heading, .msg-thread__topic, .msg-entity-lockup__entity-title, .msg-entity-lockup__entity-title > span, .msg-form__recipient, .msg-connections-typeahead__recipient, [data-recipient-name]',
      ),
    ].filter((node) => visible(node) && outsideMessage(node));
    if (
      links.length
        ? !matchingSlug
        : !names.some(
            (node) =>
              normalize(node.textContent ?? '') === normalize(input.name) ||
              normalize(node.getAttribute('aria-label') ?? '') ===
                normalize(input.name),
          )
    )
      continue;
    const subjects = [
      ...root.querySelectorAll(
        'input[name*="subject" i], input[placeholder*="subject" i], input[aria-label*="subject" i], textarea[name*="subject" i], textarea[placeholder*="subject" i]',
      ),
    ].filter(visible);
    const bodies = [
      ...root.querySelectorAll('[contenteditable="true"], textarea'),
    ].filter(
      (node) =>
        visible(node) &&
        !subjects.includes(node) &&
        !/search|recipient|subject/i.test(
          node.getAttribute('aria-label') ?? '',
        ),
    );
    if (subjects.length > 1 || bodies.length !== 1) continue;
    // A subject field identifies InMail. UI labels and container text are hints,
    // not extra gates: one recipient-owned editor is enough to prepare a draft.
    matches.push({
      root,
      body: bodies[0]!,
      ...(subjects[0] ? { subject: subjects[0] } : {}),
    });
  }
  // Nested dialog/container roots may identify the same editor; deduplicate those.
  const unique = matches.filter(
    (match, index) =>
      matches.findIndex((other) => other.body === match.body) === index,
  );
  if (!unique.length) {
    const blocked =
      /(?:upgrade|premium|purchase|buy).{0,80}(?:inmail|message)|(?:inmail|messag(?:e|ing)).{0,80}(?:upgrade|premium required|not available|unavailable|cannot|can't|not allowed)|out of inmail credits|(?:cannot|can't|unable to|not allowed to) (?:send (?:a )?(?:message|inmail)|message)/i;
    for (const root of roots) {
      const text = root.textContent ?? '';
      if (
        blocked.test(text) &&
        !root.querySelector('[contenteditable="true"], textarea')
      ) {
        return {
          kind: 'unavailable' as const,
          reason:
            'LinkedIn messaging unavailable or requires an upgrade/credits',
        };
      }
    }
    return false;
  }
  if (unique.length !== 1) return false;
  const match = unique[0]!;
  // React can replace the editor or move from InMail to a conversation thread.
  // Remove stale markers so field/button locators keep one recipient-owned target.
  for (const [attribute, selected] of [
    ['data-sws-composer', match.root],
    ['data-sws-body', match.body],
    ['data-sws-subject', match.subject],
  ] as const) {
    for (const node of document.querySelectorAll(`[${attribute}]`)) {
      if (node.getAttribute(attribute) === input.token && node !== selected)
        node.removeAttribute(attribute);
    }
  }
  match.root.setAttribute('data-sws-composer', input.token);
  match.body.setAttribute('data-sws-body', input.token);
  match.subject?.setAttribute('data-sws-subject', input.token);
  return { kind: match.subject ? ('inmail' as const) : ('chat' as const) };
}

/** Structure and known UI labels only; never saves profile or message text. */
export function composerLayoutReport(input: { name: string; slug: string }) {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  };
  const count = (selector: string) =>
    [...document.querySelectorAll(selector)].filter(visible).length;
  const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')];
  const controls = [
    ...document.querySelectorAll(
      'main button, main a, [role="main"] button, [role="main"] a, main [role="button"], [role="main"] [role="button"]',
    ),
  ].filter(
    (node) =>
      visible(node) &&
      !node.closest('aside, nav, footer, [role="complementary"]'),
  );
  const label = (node: Element) =>
    (node.getAttribute('aria-label') || node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  const normalize = (text: string) =>
    text.replace(/\s+/g, ' ').trim().toLowerCase();
  return {
    pageKind: location.pathname.startsWith('/in/')
      ? 'profile'
      : location.pathname.startsWith('/messaging/')
        ? 'messaging'
        : 'other',
    dialogs: dialogs.length,
    visibleDialogs: dialogs.filter(visible).length,
    conversationContainers: count(
      '.msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread',
    ),
    editableFields: count('[contenteditable="true"], textarea'),
    textInputs: count(
      'input[type="text"], input:not([type]), [role="textbox"]',
    ),
    subjectFields: count(
      'input[placeholder*="subject" i], input[aria-label*="subject" i], input[name*="subject" i]',
    ),
    frames: document.querySelectorAll('iframe').length,
    profileMessageControls: controls
      .filter((node) =>
        /^(?:message|send (?:a )?message|inmail)(?:\s|$)/i.test(label(node)),
      )
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role'),
        disabled:
          node.hasAttribute('disabled') ||
          node.getAttribute('aria-disabled') === 'true',
        labelKind: /^send /i.test(label(node))
          ? 'send-message'
          : /^inmail/i.test(label(node))
            ? 'inmail'
            : 'message',
        mentionsRecipient: normalize(label(node)).includes(
          normalize(input.name),
        ),
        linkKind:
          node instanceof HTMLAnchorElement
            ? (() => {
                try {
                  const url = new URL(node.href);
                  return ['linkedin.com', 'www.linkedin.com'].includes(
                    url.hostname,
                  ) && url.pathname.startsWith('/messaging/')
                    ? 'linkedin-messaging'
                    : 'other';
                } catch {
                  return 'other';
                }
              })()
            : null,
      })),
    // Report all candidate containers, including the full message center.
    composerCandidates: [
      ...document.querySelectorAll(
        '[role="dialog"], .msg-overlay-conversation-bubble, .msg-convo-wrapper, .msg-thread, main, [role="main"]',
      ),
    ]
      .filter(visible)
      .map((root) => {
        const outsideMessage = (node: Element) =>
          !node.closest(
            '[contenteditable], textarea, .msg-s-message-list, .msg-s-event-listitem, .msg-s-message-group, aside, nav, [role="complementary"], .msg-conversations-container__conversations-list, .msg-conversation-list, .msg-conversation-listitem',
          );
        const names = [
          ...root.querySelectorAll(
            'h1, h2, h3, [role="heading"], header a, header button, header span, .msg-overlay-bubble-header__title, .msg-thread__link-to-profile, .msg-thread__heading, .msg-thread__topic, .msg-entity-lockup__entity-title, .msg-entity-lockup__entity-title > span, .msg-form__recipient, .msg-connections-typeahead__recipient, [data-recipient-name]',
          ),
        ].filter((node) => visible(node) && outsideMessage(node));
        const links = [...root.querySelectorAll('a[href*="/in/"]')].filter(
          (node) => visible(node) && outsideMessage(node),
        );
        const fields = [
          ...root.querySelectorAll('[contenteditable="true"], textarea'),
        ].filter(visible);
        return {
          recipientNameCandidates: names.length,
          recipientNameMatches: names.filter(
            (node) =>
              normalize(node.textContent ?? '') === normalize(input.name) ||
              normalize(node.getAttribute('aria-label') ?? '') ===
                normalize(input.name),
          ).length,
          recipientProfileLinks: links.length,
          recipientSlugMatches: links.filter((node) => {
            try {
              const url = new URL((node as HTMLAnchorElement).href);
              return (
                ['www.linkedin.com', 'linkedin.com'].includes(url.hostname) &&
                decodeURIComponent(url.pathname).replace(/\/$/, '') ===
                  `/in/${input.slug}`
              );
            } catch {
              return false;
            }
          }).length,
          editableFields: fields.length,
          inmailEditorLabels: fields.filter((node) =>
            /\binmail\b/i.test(
              [
                node.getAttribute('aria-label'),
                node.getAttribute('placeholder'),
                node.getAttribute('data-placeholder'),
              ].join(' '),
            ),
          ).length,
          subjectFields: [
            ...root.querySelectorAll(
              'input[name*="subject" i], input[placeholder*="subject" i], input[aria-label*="subject" i], textarea[name*="subject" i], textarea[placeholder*="subject" i]',
            ),
          ].filter(visible).length,
        };
      }),
    composerRecipientLinks: dialogs.filter(visible).filter((root) =>
      [...root.querySelectorAll('a[href*="/in/"]')].some((node) => {
        try {
          return (
            decodeURIComponent(
              new URL((node as HTMLAnchorElement).href).pathname,
            ).replace(/\/$/, '') === `/in/${input.slug}`
          );
        } catch {
          return false;
        }
      }),
    ).length,
  };
}
