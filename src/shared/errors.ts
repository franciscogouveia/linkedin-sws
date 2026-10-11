export class ApplicationError extends Error {
  override name = 'ApplicationError';
}

export class MessagingUnavailableError extends ApplicationError {}

export class DraftVerificationError extends ApplicationError {}

export class SendOutcomeUnknownError extends ApplicationError {}

export class StorageError extends ApplicationError {}
export class LinkedInSessionError extends ApplicationError {}
