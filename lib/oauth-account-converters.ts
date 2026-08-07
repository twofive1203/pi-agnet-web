import { ERROR_CODES, codedError } from "@/lib/i18n/error-codes";
export type OAuthAccountImportMode = "raw" | "cpa" | "sub2api";
export type ConvertibleAccountImportMode = Exclude<OAuthAccountImportMode, "raw">;
export type OAuthAccountCredentialImport = Record<string, unknown> | Record<string, unknown>[];

export interface AccountJsonConverter {
  mode: ConvertibleAccountImportMode;
  label: string;
  sourcePlaceholder: string;
  convert: (credential: unknown) => OAuthAccountCredentialImport;
}

export const RAW_ACCOUNT_JSON_EXAMPLE = `{
  "type": "oauth",
  "access": "eyJ...",
  "refresh": "...",
  "expires": 1780000000000,
  "accountId": "optional-chatgpt-account-id"
}`;

export const CPA_ACCOUNT_JSON_EXAMPLE = `{
  "type": "codex",
  "email": "user@example.com",
  "account_id": "chatgpt-account-id",
  "access_token": "eyJ...",
  "refresh_token": "...",
  "expired": "2026-06-08T10:00:00Z"
}`;

export const SUB2API_ACCOUNT_JSON_EXAMPLE = `{
  "exported_at": "2026-06-26T02:58:49.320Z",
  "accounts": [
    {
      "name": "user@example.com",
      "platform": "openai",
      "type": "oauth",
      "expires_at": 1783070963,
      "credentials": {
        "access_token": "eyJ...",
        "refresh_token": "",
        "chatgpt_account_id": "chatgpt-account-id",
        "email": "user@example.com",
        "expires_at": "2026-07-03T09:29:23.000Z",
        "plan_type": "plus"
      }
    }
  ]
}`;

export function isOAuthAccountImportMode(value: unknown): value is OAuthAccountImportMode {
  return value === "raw" || value === "cpa" || value === "sub2api";
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function normalizeExpiresMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value > 1e11 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.trunc(numeric > 1e11 ? numeric : numeric * 1000);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function validateRawOAuthCredential(credential: unknown): string | null {
  if (!isJsonRecord(credential)) return "最终 JSON 必须是对象";
  if (credential.type !== "oauth") return "最终 JSON 的 type 必须是 oauth";
  if (typeof credential.access !== "string" || !credential.access.trim()) return "最终 JSON 缺少 access";
  if (typeof credential.refresh !== "string") return "最终 JSON 缺少 refresh 字段";
  if (typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) return "最终 JSON 的 expires 必须是数字毫秒时间戳";
  return null;
}

export function validateRawOAuthCredentialImport(credential: unknown): string | null {
  if (Array.isArray(credential)) {
    if (credential.length === 0) return "最终 JSON 账号数组不能为空";
    for (let index = 0; index < credential.length; index += 1) {
      const validationError = validateRawOAuthCredential(credential[index]);
      if (validationError) return `最终 JSON 第 ${index + 1} 个账号无效：${validationError}`;
    }
    return null;
  }
  return validateRawOAuthCredential(credential);
}

export function normalizeRawOAuthCredentialImport(credential: unknown): Record<string, unknown>[] {
  const validationError = validateRawOAuthCredentialImport(credential);
  if (validationError) throw new Error(validationError);
  return (Array.isArray(credential) ? credential : [credential]) as Record<string, unknown>[];
}

function assignOptionalStringFields(raw: Record<string, unknown>, credential: Record<string, unknown>, fields: readonly (readonly [string, string])[]): void {
  for (const [sourceKey, targetKey] of fields) {
    const value = firstNonEmptyString(credential[sourceKey]);
    if (value) raw[targetKey] = value;
  }
}

function assignOptionalStringFieldFromSources(raw: Record<string, unknown>, targetKey: string, ...values: unknown[]): void {
  const value = firstNonEmptyString(...values);
  if (value) raw[targetKey] = value;
}

export function convertCpaCredentialToRaw(credential: unknown): Record<string, unknown> {
  if (!isJsonRecord(credential)) throw codedError(ERROR_CODES.oauthCpaNotObject, "CPA JSON must be an object");

  const access = firstNonEmptyString(credential.access_token, credential.accessToken);
  const refresh = firstNonEmptyString(credential.refresh_token, credential.refreshToken);
  const expires = normalizeExpiresMs(credential.expired ?? credential.expires ?? credential.expires_at ?? credential.expiresAt);
  if (!access) throw codedError(ERROR_CODES.oauthCpaMissingAccess, "CPA JSON is missing access_token");
  if (!refresh) throw codedError(ERROR_CODES.oauthCpaMissingRefresh, "CPA JSON is missing refresh_token");
  if (expires === undefined) throw codedError(ERROR_CODES.oauthCpaMissingExpires, "CPA JSON is missing a valid expired/expires timestamp");

  const raw: Record<string, unknown> = {
    type: "oauth",
    access,
    refresh,
    expires,
  };

  const accountId = firstNonEmptyString(credential.account_id, credential.chatgpt_account_id, credential.accountId);
  if (accountId) raw.accountId = accountId;

  assignOptionalStringFields(raw, credential, [
    ["id_token", "id_token"],
    ["session_token", "session_token"],
    ["email", "email"],
    ["plan_type", "plan_type"],
    ["chatgpt_plan_type", "chatgpt_plan_type"],
  ]);

  return raw;
}

function convertSub2apiAccountToRaw(account: unknown, index?: number): Record<string, unknown> {
  const label = index === undefined ? "SUB2API JSON" : `SUB2API JSON account #${index + 1}`;
  if (!isJsonRecord(account)) throw codedError(ERROR_CODES.oauthSub2apiAccountNotObject, `${label} must be an object`);

  const credentials = isJsonRecord(account.credentials) ? account.credentials : account;
  const extra = isJsonRecord(account.extra) ? account.extra : undefined;
  const access = firstNonEmptyString(credentials.access_token, credentials.accessToken, credentials.access);
  const refresh = firstString(credentials.refresh_token, credentials.refreshToken, credentials.refresh);
  const expires = normalizeExpiresMs(credentials.expires_at ?? credentials.expiresAt ?? credentials.expires ?? account.expires_at ?? account.expiresAt ?? account.expires);
  if (!access) throw codedError(ERROR_CODES.oauthSub2apiMissingAccess, `${label} is missing credentials.access_token`);
  if (refresh === undefined) throw codedError(ERROR_CODES.oauthSub2apiMissingRefresh, `${label} is missing credentials.refresh_token`);
  if (expires === undefined) throw codedError(ERROR_CODES.oauthSub2apiMissingExpires, `${label} is missing a valid expires_at/expires timestamp`);

  const raw: Record<string, unknown> = {
    type: "oauth",
    access,
    refresh,
    expires,
  };

  assignOptionalStringFieldFromSources(raw, "accountId", credentials.chatgpt_account_id, credentials.account_id, credentials.accountId, account.account_id, account.accountId);
  assignOptionalStringFieldFromSources(raw, "email", credentials.email, extra?.email, account.name);
  assignOptionalStringFieldFromSources(raw, "plan_type", credentials.plan_type, credentials.chatgpt_plan_type);
  assignOptionalStringFieldFromSources(raw, "chatgpt_plan_type", credentials.chatgpt_plan_type, credentials.plan_type);
  assignOptionalStringFieldFromSources(raw, "chatgpt_user_id", credentials.chatgpt_user_id);
  assignOptionalStringFieldFromSources(raw, "id_token", credentials.id_token);
  assignOptionalStringFieldFromSources(raw, "session_token", credentials.session_token);

  return raw;
}

export function convertSub2apiCredentialToRaw(credential: unknown): OAuthAccountCredentialImport {
  if (!isJsonRecord(credential)) throw codedError(ERROR_CODES.oauthSub2apiNotObject, "SUB2API JSON must be an object");

  if (Array.isArray(credential.accounts)) {
    if (credential.accounts.length === 0) throw codedError(ERROR_CODES.oauthSub2apiAccountsEmpty, "SUB2API JSON accounts must not be empty");
    return credential.accounts.map((account, index) => convertSub2apiAccountToRaw(account, index));
  }

  return convertSub2apiAccountToRaw(credential);
}

export const ACCOUNT_JSON_CONVERTERS: Record<ConvertibleAccountImportMode, AccountJsonConverter> = {
  cpa: {
    mode: "cpa",
    label: "CPA 格式",
    sourcePlaceholder: CPA_ACCOUNT_JSON_EXAMPLE,
    convert: convertCpaCredentialToRaw,
  },
  sub2api: {
    mode: "sub2api",
    label: "SUB2API 格式",
    sourcePlaceholder: SUB2API_ACCOUNT_JSON_EXAMPLE,
    convert: convertSub2apiCredentialToRaw,
  },
};

export function convertOAuthAccountCredential(mode: OAuthAccountImportMode, credential: unknown): Record<string, unknown>[] {
  if (mode === "raw") return normalizeRawOAuthCredentialImport(credential);
  return normalizeRawOAuthCredentialImport(ACCOUNT_JSON_CONVERTERS[mode].convert(credential));
}
