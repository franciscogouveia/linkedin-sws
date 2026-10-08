import type { Investor } from './types.ts';

export interface SearchPageState {
  kind: 'results' | 'empty' | 'blocked';
  results: Investor[];
}

// Playwright executes this function in the page. Keep it self-contained: it cannot
// reference imported helpers or constants in the Node process.
export function inspectSearchPage(): SearchPageState | false {
  if (
    /\/(?:login|uas\/login|authwall|checkpoint|challenge)(?:\/|$)/i.test(
      location.pathname,
    )
  ) {
    return { kind: 'blocked', results: [] };
  }
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  if (!main) return false;
  const notices = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="dialog"], .artdeco-inline-feedback, .challenge',
    ),
  ];
  if (
    notices.some((notice) =>
      /your account (?:has been|is) (?:temporarily |permanently )?restricted|we.ve restricted your account|automated activity|unusual activity|security verification/i.test(
        notice.innerText,
      ),
    )
  ) {
    return { kind: 'blocked', results: [] };
  }

  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const cleanName = (text: string) =>
    normalize(text)
      .replace(/^View (.+?)(?:'s|’s) profile(?: picture)?$/i, '$1')
      .replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?).*$/, '')
      .trim();
  const isName = (text: string) =>
    !!text &&
    !/^(?:LinkedIn Member|View (?:.* )?profile|(?:Connect|Follow|Message|Pending|More)|\d+ mutual connections?)$/i.test(
      text,
    );
  const slugOf = (anchor: HTMLAnchorElement) => {
    try {
      const url = new URL(anchor.href);
      if (!['www.linkedin.com', 'linkedin.com'].includes(url.hostname)) return;
      const match = /^\/in\/([^/]+)\/?$/.exec(url.pathname);
      const slug = match?.[1] ? decodeURIComponent(match[1]) : undefined;
      return slug && /^[\p{L}\p{N}_-]+$/u.test(slug) ? slug : undefined;
    } catch {
      return;
    }
  };
  const nameOf = (anchor: HTMLElement) => {
    const nameElement = anchor.querySelector<HTMLElement>(
      '[data-anonymize="person-name"], h2, h3, [role="heading"], span[aria-hidden="true"]',
    );
    const text = nameElement?.innerText || anchor.innerText;
    const visible = cleanName(
      text.split('\n').find((line) => line.trim()) ?? '',
    );
    if (isName(visible)) return visible;
    const accessible = cleanName(anchor.getAttribute('aria-label') ?? '');
    return isName(accessible) ? accessible : '';
  };
  const metadataLines = (card: HTMLElement, name: string) =>
    [...new Set(card.innerText.split('\n').map(normalize))].filter(
      (line) =>
        line &&
        cleanName(line) !== name &&
        !/^(?:[•·]?\s*(?:1st|2nd|3rd\+?)(?: degree(?: connection)?)?|Connect|Follow|Message|Pending|More|Premium|Verified|View (?:.* )?profile|\d+ (?:mutual )?connections?)$/i.test(
          line,
        ),
    );

  const results: Investor[] = [];
  const seen = new Set<string>();
  const visitedCards = new Set<HTMLElement>();
  for (const anchor of main.querySelectorAll<HTMLAnchorElement>(
    'a[href*="/in/"]',
  )) {
    if (
      !anchor.getClientRects().length ||
      anchor.closest('aside, nav, header, footer, [role="complementary"]')
    )
      continue;
    const slug = slugOf(anchor);
    if (!slug || seen.has(slug)) continue;

    let card = anchor.closest<HTMLElement>(
      '.reusable-search__result-container, [data-view-name="search-entity-result-universal-template"], [role="listitem"], li, article',
    );
    if (card && !main.contains(card)) card = null;
    if (!card) {
      // Find a bounded block containing this profile and additional card text.
      // Never fall back to an entire result list or main element.
      const name = nameOf(anchor);
      if (!name) continue;
      for (
        let parent = anchor.parentElement;
        parent && parent !== main;
        parent = parent.parentElement
      ) {
        if (!/^(DIV|SECTION)$/.test(parent.tagName)) continue;
        const identities = new Set(
          [...parent.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')]
            .map(slugOf)
            .filter(Boolean),
        );
        if (identities.size > 1) break;
        if (
          identities.size === 1 &&
          parent.innerText.length <= 6_000 &&
          metadataLines(parent, name).length
        ) {
          card = parent;
          break;
        }
      }
    }
    if (!card || visitedCards.has(card)) continue;
    const title =
      card.querySelector<HTMLAnchorElement>('.entity-result__title-text a') ??
      [...card.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')].find(
        (link) => slugOf(link) === slug && nameOf(link),
      );
    if (!title) continue;
    const titleSlug = slugOf(title);
    const name = nameOf(title);
    if (!titleSlug || !name || seen.has(titleSlug)) continue;
    const role =
      normalize(
        card.querySelector<HTMLElement>(
          '.entity-result__primary-subtitle, [data-anonymize="job-title"]',
        )?.innerText ?? '',
      ) ||
      metadataLines(card, name)[0] ||
      '';
    if (!role) continue; // Wait for the headline instead of queuing a loading skeleton.
    visitedCards.add(card);
    seen.add(titleSlug);
    results.push({ name, role, slug: titleSlug });
  }
  if (results.length) return { kind: 'results', results };
  if (
    /no results found|no matching results|try (?:different|another) keywords/i.test(
      main.innerText,
    )
  ) {
    return { kind: 'empty', results: [] };
  }
  return false;
}

export function searchLayoutReport() {
  const main = document.querySelector('main, [role="main"]');
  const describe = (element: Element) => ({
    tag: element.tagName.toLowerCase(),
    class: (element.getAttribute('class') ?? '').slice(0, 250),
    role: element.getAttribute('role'),
    view: element.getAttribute('data-view-name'),
  });
  const links = [
    ...(main?.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]') ?? []),
  ];
  return {
    path: location.pathname.replace(/\/in\/[^/]+/g, '/in/<profile>'),
    mainFound: !!main,
    profileLinkCount: links.length,
    visibleProfileLinkCount: links.filter(
      (link) => link.getClientRects().length,
    ).length,
    listItemCount:
      main?.querySelectorAll('li, [role="listitem"], article').length ?? 0,
    samples: links.slice(0, 10).map((link) => {
      const ancestors = [];
      for (
        let node: Element | null = link;
        node && node !== main && ancestors.length < 8;
        node = node.parentElement
      ) {
        ancestors.push(describe(node));
      }
      return {
        hasVisibleText: !!link.innerText.trim(),
        hasAccessibleLabel: !!link.getAttribute('aria-label'),
        ancestors,
      };
    }),
  };
}
