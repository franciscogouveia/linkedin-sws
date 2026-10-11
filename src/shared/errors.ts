export class ApplicationError extends Error {
  override name = 'ApplicationError';
}

export class MessagingUnavailableError extends ApplicationError {}
