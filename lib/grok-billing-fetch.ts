export class GrokBillingPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokBillingPayloadError";
  }
}

export interface GrokBillingPayloads {
  weeklyResponse: Response;
  weeklyPayload: unknown | null;
}

/** Fetch weekly xAI billing (`format=credits`). Monthly billing is no longer supported. */
export async function fetchGrokBillingPayloads(
  baseUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<GrokBillingPayloads> {
  const weeklyResponse = await fetch(`${baseUrl}/billing?format=credits`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!weeklyResponse.ok) {
    return { weeklyResponse, weeklyPayload: null };
  }

  let weeklyPayload: unknown;
  try {
    weeklyPayload = await weeklyResponse.json() as unknown;
  } catch {
    throw new GrokBillingPayloadError("Weekly billing response is not valid JSON");
  }
  return { weeklyResponse, weeklyPayload };
}
