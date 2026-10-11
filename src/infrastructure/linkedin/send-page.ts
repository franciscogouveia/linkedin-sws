/** Runs inside the browser; returns counts/flags without message text. */
export function inspectSendState(input: { token: string }) {
  const visible = (node: Element) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  };
  const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
  const root = document.querySelector(`[data-sws-composer="${input.token}"]`);
  const body = document.querySelector(`[data-sws-body="${input.token}"]`);
  const bodyText =
    body instanceof HTMLTextAreaElement || body instanceof HTMLInputElement
      ? body.value
      : (body as HTMLElement | null)?.innerText;
  const notices = [
    ...document.querySelectorAll(
      '[role="alert"], [role="status"], .artdeco-toast-item',
    ),
  ].filter(visible);
  return {
    messageCount: root
      ? [
          ...root.querySelectorAll(
            '.msg-s-event-listitem__body, .msg-s-message-group__text, .msg-s-message__body, [data-message-body]',
          ),
        ].filter((node) => visible(node) && !node.closest('[contenteditable]'))
          .length
      : 0,
    cleared: bodyText !== undefined && normalize(bodyText) === '',
    successNotices: notices.filter((node) =>
      /^(?:your )?(?:message|inmail) (?:was |has been )?sent(?: successfully)?[.!]?$/i.test(
        normalize((node as HTMLElement).innerText),
      ),
    ).length,
    rejected: notices.some((node) =>
      /(?:couldn.t|could not|unable to|failed to) send|message (?:was not|not) sent|send failed|try (?:sending )?again/i.test(
        (node as HTMLElement).innerText,
      ),
    ),
  };
}
