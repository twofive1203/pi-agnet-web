import { ensureControlSessionResponse, jsonError, withAutomationLocal } from "@/lib/automation-api";

export const dynamic = "force-dynamic";

/** Issue HttpOnly SameSite=Strict Automation control session cookie. */
export async function POST(req: Request) {
  try {
    withAutomationLocal(req);
    return ensureControlSessionResponse();
  } catch (error) {
    return jsonError(error);
  }
}
