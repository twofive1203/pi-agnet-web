export const EMPTY_COMPLETED_RETRY_ERROR =
  "Provider returned an empty completed response after tool results; please retry your request";

export function isEmptyCompletedRetryError(message: string | undefined): boolean {
  return message === EMPTY_COMPLETED_RETRY_ERROR;
}
