import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext, Locator, Page } from 'playwright';
import {
  ApplicationError,
  MessagingUnavailableError,
} from '../../shared/errors.ts';
import type {
  Investor,
  LinkedInMessenger,
  MessageComposer,
  MessageDraft,
} from '../../shared/types.ts';
import { assertLinkedInPage, profileSlug } from './page.ts';
import { inspectProfilePage } from './profile-page.ts';
import { inspectComposer, composerLayoutReport } from './composer-page.ts';
import { composerFailure } from './composer-errors.ts';
import { hasMessagePlaceholders } from '../../writing/llm.ts';

async function fieldText(field: Locator): Promise<string> {
  return field.evaluate((node) =>
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
      ? node.value
      : (node as HTMLElement).innerText,
  );
}
const normalized = (text: string) => text.replace(/\r\n/g, '\n');

export class LinkedInMessengerBrowser implements LinkedInMessenger {
  private readonly context: BrowserContext;
  private readonly signal: AbortSignal;
  private readonly diagnosticsDirectory: string | undefined;
  constructor(
    context: BrowserContext,
    signal: AbortSignal,
    diagnosticsDirectory?: string,
  ) {
    this.context = context;
    this.signal = signal;
    this.diagnosticsDirectory = diagnosticsDirectory;
  }

  async openComposer(recipient: Investor): Promise<MessageComposer> {
    this.signal.throwIfAborted();
    const page = await this.context.newPage();
    let stage = 'opening recipient profile';
    let action = 'not attempted';
    try {
      await page.bringToFront();
      const response = await page.goto(
        `https://www.linkedin.com/in/${encodeURIComponent(recipient.slug)}/`,
        { waitUntil: 'domcontentloaded' },
      );
      this.signal.throwIfAborted();
      await assertLinkedInPage(page);
      if (response && response.status() >= 400)
        throw new ApplicationError(
          `LinkedIn draft profile returned HTTP ${response.status()}. Queue row remains working.`,
        );
      stage = 'waiting for recipient profile';
      const profile = await page.waitForFunction(inspectProfilePage, {
        expectedName: recipient.name,
      });
      try {
        const state = await profile.jsonValue();
        if (
          !state ||
          state.kind !== 'profile' ||
          profileSlug(page.url()) !== recipient.slug ||
          state.name.replace(/\s+/g, ' ').trim().toLowerCase() !==
            recipient.name.replace(/\s+/g, ' ').trim().toLowerCase()
        )
          throw new ApplicationError(
            'Cannot verify the draft recipient profile. Queue row remains working.',
          );
      } finally {
        await profile.dispose();
      }
      stage = 'opening profile Message action';
      await this.openMessageAction(page, recipient, (value) => {
        action = value;
      });
      stage = 'waiting for message composer after clicking Message';
      const token = randomUUID();
      const input = { name: recipient.name, slug: recipient.slug, token };
      const handle = await page.waitForFunction(inspectComposer, input);
      let state;
      try {
        state = await handle.jsonValue();
      } finally {
        await handle.dispose();
      }
      this.signal.throwIfAborted();
      await assertLinkedInPage(page);
      if (!state || typeof state !== 'object')
        throw new ApplicationError(
          'Cannot verify the messaging composer. Queue row remains working.',
        );
      if (state.kind === 'unavailable')
        throw new MessagingUnavailableError(state.reason);
      const kind = state.kind;
      const body = page.locator(`[data-sws-body="${token}"]`);
      const subject = page.locator(`[data-sws-subject="${token}"]`);
      return {
        kind,
        fill: async (draft: MessageDraft) => {
          this.signal.throwIfAborted();
          if (
            !draft.body.trim() ||
            hasMessagePlaceholders(draft.body) ||
            (kind === 'inmail' &&
              (!draft.subject?.trim() ||
                draft.subject.length > 80 ||
                /[\r\n]/.test(draft.subject) ||
                hasMessagePlaceholders(draft.subject)))
          ) {
            throw new ApplicationError(
              'Draft text or InMail subject is invalid. Queue row remains working.',
            );
          }
          await assertLinkedInPage(page);
          const current = await page.evaluate(inspectComposer, input);
          if (!current || current.kind !== kind)
            throw new ApplicationError(
              'Draft recipient or composer changed. Queue row remains working.',
            );
          if (
            (await fieldText(body)).trim() ||
            (kind === 'inmail' && (await fieldText(subject)).trim())
          ) {
            throw new ApplicationError(
              'An existing nonempty draft was preserved. Review it in the browser; queue row remains working.',
            );
          }
          if (kind === 'inmail') {
            await subject.fill(draft.subject!);
            this.signal.throwIfAborted();
          }
          // fill changes field text only. Never submit, press Enter, or click Send.
          await body.fill(draft.body);
          this.signal.throwIfAborted();
          await assertLinkedInPage(page);
          const verified = await page.evaluate(inspectComposer, input);
          if (
            !verified ||
            verified.kind !== kind ||
            normalized(await fieldText(body)) !== normalized(draft.body) ||
            (kind === 'inmail' &&
              normalized(await fieldText(subject)) !==
                normalized(draft.subject!))
          ) {
            throw new ApplicationError(
              'Draft text or recipient could not be verified after filling. Queue row remains working.',
            );
          }
        },
      };
    } catch (error) {
      this.signal.throwIfAborted();
      if (error instanceof MessagingUnavailableError) {
        await page.close();
        throw error;
      }
      if (!page.isClosed()) await assertLinkedInPage(page);
      const diagnostic = await this.layoutDiagnostic(
        page,
        stage,
        action,
        recipient,
      );
      throw new ApplicationError(
        `${error instanceof ApplicationError ? error.message : composerFailure(error, stage, recipient)}${diagnostic}`,
      );
    }
  }

  private async layoutDiagnostic(
    page: Page,
    stage: string,
    action: string,
    recipient: Investor,
  ): Promise<string> {
    if (!this.diagnosticsDirectory || page.isClosed()) return '';
    try {
      const layout = await page.evaluate(composerLayoutReport, {
        name: recipient.name,
        slug: recipient.slug,
      });
      const report = { stage, action, ...layout };
      await mkdir(this.diagnosticsDirectory, { recursive: true, mode: 0o700 });
      const path = join(
        this.diagnosticsDirectory,
        `composer-layout-${Date.now()}-${process.pid}.json`,
      );
      await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
      return ` Layout report: ${path}.`;
    } catch {
      return ' A composer layout report could not be saved.';
    }
  }

  private async openMessageAction(
    page: Page,
    recipient: Investor,
    recordAction: (value: string) => void,
  ): Promise<void> {
    // Profile-owned controls only: exclude navigation and recommended profiles.
    const header = page.locator(
      'main .pv-top-card, main .profile-header, main [data-view-name*="profile-top-card"], [role="main"] .pv-top-card',
    );
    const scope =
      (await header.count()) === 1
        ? header
        : page.locator('main, [role="main"]');
    const escapedName = recipient.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const messageLabel = new RegExp(
      `^(?:message(?: (?:to )?${escapedName})?|send (?:a )?message(?: to ${escapedName})?|inmail)$`,
      'i',
    );
    const action = scope
      .getByRole('button', { name: messageLabel })
      .or(scope.getByRole('link', { name: messageLabel }))
      .and(
        page.locator(
          ':not(aside *, nav *, footer *, [role="complementary"] *)',
        ),
      )
      .filter({ visible: true });
    if ((await action.count()) === 1 && (await action.isEnabled())) {
      recordAction('clicking profile Message control');
      await action.click();
      recordAction('profile Message control clicked');
      return;
    }
    const more = scope
      .getByRole('button', { name: /^(?:more|more actions)$/i })
      .filter({ visible: true });
    if ((await more.count()) === 1) {
      recordAction('clicking profile More control');
      await more.click();
      recordAction('profile More control clicked');
      const menu = page
        .locator('[role="menu"], .artdeco-dropdown__content')
        .filter({ visible: true });
      const message = menu
        .getByRole('menuitem', { name: messageLabel })
        .or(menu.getByRole('button', { name: messageLabel }))
        .filter({ visible: true });
      if ((await message.count()) === 1 && (await message.isEnabled())) {
        recordAction('clicking Message menu item');
        await message.click();
        recordAction('Message menu item clicked');
        return;
      }
    }
    const notice = await page.evaluate(inspectComposer, {
      name: '',
      slug: '',
      token: '',
    });
    if (notice && notice.kind === 'unavailable')
      throw new MessagingUnavailableError(notice.reason);
    throw new ApplicationError(
      'No unambiguous profile Message action was found. Review the browser; queue row remains working.',
    );
  }
}
