import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import {
  ApplicationError,
  LinkedInSessionError,
  DraftVerificationError,
  SendOutcomeUnknownError,
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
import { waitForComposer, visibleComposerFrames } from './composer-target.ts';
import { composerFailure } from './composer-errors.ts';
import { inspectSendState } from './send-page.ts';
import { confirmSend } from './send-confirmation.ts';

export class LinkedInMessengerBrowser implements LinkedInMessenger {
  private readonly context: BrowserContext;
  private readonly signal: AbortSignal;
  private readonly timeout: number;
  private readonly diagnosticsDirectory: string | undefined;
  constructor(
    context: BrowserContext,
    signal: AbortSignal,
    diagnosticsDirectory?: string,
    timeout = 30_000,
  ) {
    this.timeout = timeout;
    this.context = context;
    this.signal = signal;
    this.diagnosticsDirectory = diagnosticsDirectory;
  }

  async openComposer(recipient: Investor): Promise<MessageComposer> {
    this.signal.throwIfAborted();
    const page = await this.context.newPage();
    let stage = 'opening recipient profile';
    let action = 'not attempted';
    const popups: Page[] = [];
    const onPopup = (popup: Page) => {
      popups.push(popup);
    };
    page.on('popup', onPopup);
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
          `LinkedIn draft profile returned HTTP ${response.status()}.`,
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
          profileSlug(page.url()) !== recipient.slug
        )
          throw new ApplicationError(
            'Cannot verify the draft recipient profile.',
          );
      } finally {
        await profile.dispose();
      }
      stage = 'waiting for profile page load';
      await page.waitForLoadState('load');
      this.signal.throwIfAborted();
      stage = 'opening profile Message action';
      await this.openMessageAction(page, recipient, (value) => {
        action = value;
      });
      stage = 'waiting for message composer after opening Message';
      const token = randomUUID();
      const input = { name: recipient.name, slug: recipient.slug, token };
      const { frame: target, state } = await waitForComposer(
        () => [page, ...popups],
        input,
        this.signal,
        this.timeout,
      );
      const messagePage = target.page();
      this.signal.throwIfAborted();
      await assertLinkedInPage(messagePage);
      if (!state || typeof state !== 'object')
        throw new ApplicationError('Cannot verify the messaging composer.');
      const kind = state.kind;
      const body = target.locator(`[data-sws-body="${token}"]`);
      let prepared: MessageDraft | undefined;
      let sendAttempted = false;
      const subject = target.locator(`[data-sws-subject="${token}"]`);
      return {
        kind,
        fill: async (draft: MessageDraft) => {
          prepared = undefined;
          this.signal.throwIfAborted();
          await assertLinkedInPage(messagePage);
          if (!(await target.evaluate(inspectComposer, input)))
            throw new ApplicationError(
              'The selected message recipient changed.',
            );
          if (kind === 'inmail' && draft.subject !== undefined) {
            await subject.fill(draft.subject);
            this.signal.throwIfAborted();
          }
          await body.fill(draft.body);
          this.signal.throwIfAborted();
          prepared = { ...draft };
        },
        send: async (beforeClick: () => void) => {
          this.signal.throwIfAborted();
          if (!prepared || sendAttempted)
            throw new DraftVerificationError(
              'No unsent draft is available for sending.',
            );
          await assertLinkedInPage(messagePage);
          if (!(await target.evaluate(inspectComposer, input)))
            throw new ApplicationError(
              'The selected message recipient changed.',
            );
          const root = target.locator(`[data-sws-composer="${token}"]`);
          const send = root
            .getByRole('button', {
              name: /^(?:send|send message|send inmail)$/i,
            })
            .filter({ visible: true })
            .first();
          await send.waitFor({ state: 'visible' });
          const before = await target.evaluate(inspectSendState, {
            token,
          });
          this.signal.throwIfAborted();
          // SQLite commits the uncertainty marker before this irreversible click.
          beforeClick();
          sendAttempted = true;
          try {
            await send.click();
            await confirmSend(
              before,
              async () => {
                await assertLinkedInPage(messagePage);
                // Refresh the recipient-owned root if InMail became a chat thread.
                const current = await target.evaluate(inspectComposer, input);
                const snapshot = await target.evaluate(inspectSendState, {
                  token,
                });
                return current
                  ? snapshot
                  : { ...snapshot, messageCount: 0, cleared: false };
              },
              this.signal,
              this.timeout,
            );
            prepared = undefined;
          } catch (error) {
            this.signal.throwIfAborted();
            if (error instanceof ApplicationError) throw error;
            throw new SendOutcomeUnknownError(
              'Send was attempted but its outcome could not be verified. Check the conversation manually.',
            );
          }
        },
      };
    } catch (error) {
      this.signal.throwIfAborted();
      if (error instanceof LinkedInSessionError) throw error;
      if (!page.isClosed()) await assertLinkedInPage(page);
      const diagnostic = await this.layoutDiagnostic(
        page,
        stage,
        action,
        recipient,
        popups,
      );
      throw new ApplicationError(
        `${error instanceof ApplicationError ? `${error.message} Stage: ${stage}.` : composerFailure(error, stage, recipient)}${diagnostic}`,
      );
    } finally {
      page.removeListener('popup', onPopup);
    }
  }

  private async layoutDiagnostic(
    page: Page,
    stage: string,
    action: string,
    recipient: Investor,
    popups: Page[],
  ): Promise<string> {
    if (!this.diagnosticsDirectory || page.isClosed()) return '';
    try {
      const layout = await page.evaluate(composerLayoutReport, {
        name: recipient.name,
        slug: recipient.slug,
      });
      const frameReports = [];
      for (const frame of await visibleComposerFrames([page, ...popups])) {
        try {
          frameReports.push({
            location: frame === frame.page().mainFrame() ? 'page' : 'frame',
            popup: frame.page() !== page,
            ...(await frame.evaluate(composerLayoutReport, {
              name: recipient.name,
              slug: recipient.slug,
            })),
          });
        } catch {
          frameReports.push({ unreadable: true });
        }
      }
      const report = {
        stage,
        action,
        ...layout,
        popupTabs: popups.filter((tab) => !tab.isClosed()).length,
        frameReports,
      };
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
      await action.waitFor({ state: 'visible' });
      // Follow a normal LinkedIn messaging anchor directly. Some profile layouts
      // leave its SPA click handler inert even though the link is actionable.
      const href = await action.getAttribute('href');
      if (href) {
        const url = new URL(href, page.url());
        if (
          ['linkedin.com', 'www.linkedin.com'].includes(url.hostname) &&
          url.protocol === 'https:' &&
          url.pathname.startsWith('/messaging/')
        ) {
          recordAction('following profile LinkedIn messaging link');
          const response = await page.goto(url.href, {
            waitUntil: 'domcontentloaded',
          });
          if (response && response.status() >= 400)
            throw new ApplicationError(
              `LinkedIn messaging returned HTTP ${response.status()}.`,
            );
          recordAction('profile LinkedIn messaging link followed');
          return;
        }
      }
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
    throw new ApplicationError(
      'No profile Message action was found. Review the browser.',
    );
  }
}
