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
    const main = document.querySelector('main');
    if (main) roots.push(main);
  }
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
        reason: 'LinkedIn messaging unavailable or requires an upgrade/credits',
      };
    }
  }
  const matches: { root: Element; body: Element; subject?: Element }[] = [];
  for (const root of roots) {
    const links = [...root.querySelectorAll('a[href*="/in/"]')].filter(visible);
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
        'h1, h2, h3, [role="heading"], .msg-overlay-bubble-header__title, .msg-conversation-listitem__participant-names, .msg-thread__link-to-profile, [data-recipient-name]',
      ),
    ].filter(visible);
    if (
      links.length
        ? !matchingSlug
        : !names.some(
            (node) =>
              normalize(node.textContent ?? '') === normalize(input.name),
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
    if (/\binmail\b/i.test(textOf(root)) && subjects.length !== 1) continue;
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
  if (unique.length !== 1) return false;
  const match = unique[0]!;
  match.body.setAttribute('data-sws-body', input.token);
  match.subject?.setAttribute('data-sws-subject', input.token);
  return { kind: match.subject ? ('inmail' as const) : ('chat' as const) };
  function textOf(element: Element) {
    return element.textContent ?? '';
  }
}
