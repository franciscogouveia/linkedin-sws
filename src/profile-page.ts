export interface ProfilePageState {
  kind: 'profile' | 'missing' | 'blocked';
  name: string;
  text: string;
}

// Runs in the browser. Do not reference Node helpers or imported values here.
export function inspectProfilePage(options: {
  expectedName: string;
}): ProfilePageState | false {
  const empty = { name: '', text: '' };
  if (
    /\/(?:login|uas\/login|authwall|checkpoint|challenge)(?:\/|$)/i.test(
      location.pathname,
    )
  ) {
    return { kind: 'blocked', ...empty };
  }
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
    return { kind: 'blocked', ...empty };
  }
  const scope =
    document.querySelector<HTMLElement>('main, [role="main"]') ?? document.body;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const cleanName = (text: string) =>
    normalize(text.split('\n').find((line) => line.trim()) ?? '')
      .replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?).*$/, '')
      .trim();
  const excluded = 'aside, nav, footer, [role="complementary"]';
  const visible = (element: HTMLElement) =>
    !!element.getClientRects().length && !element.closest(excluded);
  const sectionLabel = (element: HTMLElement) => {
    const text = normalize(element.innerText).toLowerCase();
    const match =
      /^(about|experience|activity|featured|education|services|licenses|skills|interests|recommendations|people you may know|people also viewed|more profiles)(?:\s|$)/.exec(
        text,
      );
    return match?.[1];
  };
  const isName = (element: HTMLElement) => {
    const text = cleanName(element.innerText);
    return (
      visible(element) &&
      !!text &&
      text.length <= 200 &&
      !sectionLabel(element) &&
      !/^(?:LinkedIn|Profile|Search results|This (?:page|profile) does(?:n.t| not) exist|Profile not found|Your account.*restricted)$/i.test(
        text,
      )
    );
  };
  const expected = normalize(options.expectedName).toLowerCase();
  const strong = [
    ...scope.querySelectorAll<HTMLElement>(
      'h1, [role="heading"][aria-level="1"], .text-heading-xlarge, [data-anonymize="person-name"]',
    ),
  ].filter(isName);
  const headings = [
    ...scope.querySelectorAll<HTMLElement>('h2, h3, [role="heading"]'),
  ].filter(isName);
  let nameElement =
    [...strong, ...headings].find(
      (element) =>
        expected && cleanName(element.innerText).toLowerCase() === expected,
    ) ?? strong[0];
  if (!nameElement && expected) {
    nameElement = [...scope.querySelectorAll<HTMLElement>('p, span, div')].find(
      (element) =>
        visible(element) &&
        normalize(element.innerText).toLowerCase() === expected,
    );
  }
  if (!nameElement && !expected) nameElement = headings[0];
  if (!nameElement) {
    if (
      /this (?:page|profile) does(?:n.t| not) exist|profile not found/i.test(
        scope.innerText,
      )
    )
      return { kind: 'missing', ...empty };
    return false;
  }
  const name = cleanName(nameElement.innerText);
  const headingSelector = 'h1, h2, h3, [role="heading"]';
  const chunks: string[] = [];
  const meaningful = (text: string) =>
    text
      .split('\n')
      .map(normalize)
      .some(
        (line) =>
          line &&
          cleanName(line) !== name &&
          !/^(?:[•·]?\s*(?:1st|2nd|3rd\+?)(?: degree(?: connection)?)?|Connect|Follow|Message|Pending|More|Premium|Verified|Contact info|Show all|Show more|See more|(?:About|Experience)(?:\s+(?:About|Experience))?)$/i.test(
            line,
          ),
      );
  let top: HTMLElement | undefined;
  for (
    let node = nameElement.parentElement;
    node && node !== scope;
    node = node.parentElement
  ) {
    if (
      node.matches(excluded) ||
      node.querySelector('aside, nav, [role="complementary"]')
    )
      break;
    if (
      [...node.querySelectorAll<HTMLElement>(headingSelector)].some((heading) =>
        sectionLabel(heading),
      )
    )
      break;
    if (node.innerText.length > 12_000) break;
    if (meaningful(node.innerText)) top = node;
  }
  if (top) chunks.push(top.innerText.trim());
  else {
    // A heading directly inside main still has bounded adjacent header content.
    const lines = [name];
    for (
      let node = nameElement.nextElementSibling;
      node && lines.length < 5;
      node = node.nextElementSibling
    ) {
      if (!(node instanceof HTMLElement) || node.matches(excluded)) break;
      if (
        sectionLabel(node) ||
        [...node.querySelectorAll<HTMLElement>(headingSelector)].some(
          (heading) => sectionLabel(heading),
        )
      )
        break;
      if (node.innerText.length > 3_000) break;
      lines.push(node.innerText.trim());
    }
    chunks.push(lines.join('\n'));
  }

  const selected = new Set<HTMLElement>();
  for (const heading of scope.querySelectorAll<HTMLElement>(headingSelector)) {
    const label = sectionLabel(heading);
    if (!visible(heading) || (label !== 'about' && label !== 'experience'))
      continue;
    let block: HTMLElement | undefined;
    for (
      let node = heading.parentElement;
      node && node !== scope;
      node = node.parentElement
    ) {
      if (
        node.matches(excluded) ||
        node.querySelector('aside, nav, [role="complementary"]')
      )
        break;
      if (
        [...node.querySelectorAll<HTMLElement>(headingSelector)].some(
          (other) => sectionLabel(other) && sectionLabel(other) !== label,
        )
      )
        break;
      if (node.innerText.length > 60_000) break;
      if (normalize(node.innerText) !== normalize(heading.innerText))
        block = node;
    }
    if (block) selected.add(block);
  }
  for (const block of selected) chunks.push(block.innerText.trim());
  const text = [...new Set(chunks)].filter(Boolean).join('\n\n');
  if (!meaningful(text)) return false;
  return { kind: 'profile', name, text };
}

export function profileLayoutReport(options: { expectedName: string }) {
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  const scope = main ?? document.body;
  const describe = (element: Element) => ({
    tag: element.tagName.toLowerCase(),
    class: (element.getAttribute('class') ?? '').slice(0, 250),
    role: element.getAttribute('role'),
    level: element.getAttribute('aria-level'),
    view: element.getAttribute('data-view-name'),
  });
  const normalize = (text: string) =>
    text.replace(/\s+/g, ' ').trim().toLowerCase();
  const expected = normalize(options.expectedName);
  const headings = [
    ...scope.querySelectorAll<HTMLElement>(
      'h1, h2, h3, [role="heading"], .text-heading-xlarge, [data-anonymize="person-name"]',
    ),
  ];
  return {
    path: location.pathname.replace(/\/in\/[^/]+/g, '/in/<profile>'),
    mainFound: !!main,
    headingCount: headings.length,
    visibleHeadingCount: headings.filter(
      (heading) => heading.getClientRects().length,
    ).length,
    expectedNameFound:
      !!expected &&
      [...scope.querySelectorAll<HTMLElement>('h1, h2, h3, p, span, div')].some(
        (element) => normalize(element.innerText) === expected,
      ),
    iframeCount: document.querySelectorAll('iframe').length,
    samples: headings.slice(0, 15).map((heading) => {
      const ancestors = [];
      for (
        let node: Element | null = heading;
        node && node !== scope && ancestors.length < 8;
        node = node.parentElement
      )
        ancestors.push(describe(node));
      return { textLength: heading.innerText.length, ancestors };
    }),
  };
}
