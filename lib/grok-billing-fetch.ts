export class GrokBillingPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokBillingPayloadError";
  }
}

export interface GrokBillingPayloads {
  monthlyResponse: Response;
  monthlyPayload: unknown | null;
  weeklyPayload: unknown | null;
}

/** Start monthly and optional weekly billing together under independent deadlines. */
export async function fetchGrokBillingPayloads(
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<GrokBillingPayloads> {
  const weeklyAbort = new AbortController();
  const weeklyTimeoutMs = Math.min(timeoutMs, 2_000);
  const weeklyPromise = fetch(`${baseUrl}/billing?format=credits`, {
    method: "GET",
    headers,
    signal: AbortSignal.any([weeklyAbort.signal, AbortSignal.timeout(weeklyTimeoutMs)]),
  }).then(async (response) => response.ok ? await response.json() as unknown : null)
    .catch(() => null);

  try {
    const monthlyResponse = await fetch(`${baseUrl}/billing`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!monthlyResponse.ok) {
      weeklyAbort.abort();
      return { monthlyResponse, monthlyPayload: null, weeklyPayload: null };
    }
    let monthlyPayload: unknown;
    try {
      monthlyPayload = await monthlyResponse.json() as unknown;
    } catch {
      weeklyAbort.abort();
      throw new GrokBillingPayloadError("Monthly billing response is not valid JSON");
    }
    // Optional weekly data must not extend a successful monthly request. Include
    // it only when it already settled while monthly was in flight, then cancel.
    const weeklyPayload = await Promise.race([weeklyPromise, Promise.resolve(null)]);
    weeklyAbort.abort();
    return { monthlyResponse, monthlyPayload, weeklyPayload };
  } catch (error) {
    weeklyAbort.abort();
    throw error;
  }
}
