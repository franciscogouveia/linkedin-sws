import { LinkedInSessionError, StorageError } from './errors.ts';

export function rethrowFatal(error: unknown, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (error instanceof StorageError || error instanceof LinkedInSessionError)
    throw error;
}
export function failureReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Unexpected operation failure.';
}
