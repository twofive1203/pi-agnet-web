/** Stable machine codes for user-visible errors that should be localized in the UI. */
export const ERROR_CODES = {
  oauthCpaNotObject: "oauth.cpa_not_object",
  oauthCpaMissingAccess: "oauth.cpa_missing_access",
  oauthCpaMissingRefresh: "oauth.cpa_missing_refresh",
  oauthCpaMissingExpires: "oauth.cpa_missing_expires",
  oauthSub2apiNotObject: "oauth.sub2api_not_object",
  oauthSub2apiAccountsEmpty: "oauth.sub2api_accounts_empty",
  oauthSub2apiAccountNotObject: "oauth.sub2api_account_not_object",
  oauthSub2apiMissingAccess: "oauth.sub2api_missing_access",
  oauthSub2apiMissingRefresh: "oauth.sub2api_missing_refresh",
  oauthSub2apiMissingExpires: "oauth.sub2api_missing_expires",
  grokNotLoggedIn: "grok.not_logged_in",
  terminalEnvNoJson: "terminal_env.no_json",
  terminalEnvRootNotObject: "terminal_env.root_not_object",
  terminalEnvNoEnv: "terminal_env.no_env",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const CODE_TO_MESSAGE_KEY: Record<ErrorCode, string> = {
  [ERROR_CODES.oauthCpaNotObject]: "errors.oauth.cpaNotObject",
  [ERROR_CODES.oauthCpaMissingAccess]: "errors.oauth.cpaMissingAccess",
  [ERROR_CODES.oauthCpaMissingRefresh]: "errors.oauth.cpaMissingRefresh",
  [ERROR_CODES.oauthCpaMissingExpires]: "errors.oauth.cpaMissingExpires",
  [ERROR_CODES.oauthSub2apiNotObject]: "errors.oauth.sub2apiNotObject",
  [ERROR_CODES.oauthSub2apiAccountsEmpty]: "errors.oauth.sub2apiAccountsEmpty",
  [ERROR_CODES.oauthSub2apiAccountNotObject]: "errors.oauth.sub2apiAccountNotObject",
  [ERROR_CODES.oauthSub2apiMissingAccess]: "errors.oauth.sub2apiMissingAccess",
  [ERROR_CODES.oauthSub2apiMissingRefresh]: "errors.oauth.sub2apiMissingRefresh",
  [ERROR_CODES.oauthSub2apiMissingExpires]: "errors.oauth.sub2apiMissingExpires",
  [ERROR_CODES.grokNotLoggedIn]: "errors.grok.notLoggedIn",
  [ERROR_CODES.terminalEnvNoJson]: "errors.terminalEnv.noJson",
  [ERROR_CODES.terminalEnvRootNotObject]: "errors.terminalEnv.rootNotObject",
  [ERROR_CODES.terminalEnvNoEnv]: "errors.terminalEnv.noEnv",
};

/** English machine message paired with a stable code (safe for logs / API bodies). */
export function codedError(code: ErrorCode, englishMessage: string): Error & { code: ErrorCode } {
  const err = new Error(englishMessage) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && value in CODE_TO_MESSAGE_KEY;
}

/**
 * Resolve a user-visible error string.
 * Prefer `code` when present; otherwise return the raw message/fallback.
 */
export function localizeError(
  t: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string,
  input: { code?: unknown; message?: unknown; fallback?: string } | string | null | undefined,
): string {
  if (input == null) return "";
  if (typeof input === "string") {
    // Legacy Chinese messages still in flight from older servers.
    const legacy = LEGACY_MESSAGE_TO_CODE[input];
    if (legacy) return t(CODE_TO_MESSAGE_KEY[legacy]);
    return input;
  }
  if (isErrorCode(input.code)) return t(CODE_TO_MESSAGE_KEY[input.code]);
  if (typeof input.message === "string" && input.message) {
    const legacy = LEGACY_MESSAGE_TO_CODE[input.message];
    if (legacy) return t(CODE_TO_MESSAGE_KEY[legacy]);
    return input.message;
  }
  return input.fallback ?? "";
}

const LEGACY_MESSAGE_TO_CODE: Record<string, ErrorCode> = {
  "CPA JSON 必须是对象": ERROR_CODES.oauthCpaNotObject,
  "CPA JSON 缺少 access_token": ERROR_CODES.oauthCpaMissingAccess,
  "CPA JSON 缺少 refresh_token": ERROR_CODES.oauthCpaMissingRefresh,
  "CPA JSON 缺少有效的 expired/expires 时间": ERROR_CODES.oauthCpaMissingExpires,
  "SUB2API JSON 必须是对象": ERROR_CODES.oauthSub2apiNotObject,
  "SUB2API JSON accounts 不能为空": ERROR_CODES.oauthSub2apiAccountsEmpty,
  "Grok 未登录。请先在 Models → xAI 或 Grok CLI 完成 OAuth 登录，或设置 GROK_CLI_OAUTH_TOKEN 环境变量。":
    ERROR_CODES.grokNotLoggedIn,
  "模型没有返回 JSON 对象": ERROR_CODES.terminalEnvNoJson,
  "模型返回 JSON 根节点不是对象": ERROR_CODES.terminalEnvRootNotObject,
  "模型没有解析出有效环境变量": ERROR_CODES.terminalEnvNoEnv,
};
