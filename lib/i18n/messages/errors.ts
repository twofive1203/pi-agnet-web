import type { MessageTree } from "../types";

/** Stable error codes → user-facing copy. Prefer mapping by `code`, not raw server text. */
export const errorsZh = {
  oauth: {
    cpaNotObject: "CPA JSON 必须是对象",
    cpaMissingAccess: "CPA JSON 缺少 access_token",
    cpaMissingRefresh: "CPA JSON 缺少 refresh_token",
    cpaMissingExpires: "CPA JSON 缺少有效的 expired/expires 时间",
    sub2apiNotObject: "SUB2API JSON 必须是对象",
    sub2apiAccountsEmpty: "SUB2API JSON accounts 不能为空",
    sub2apiAccountNotObject: "SUB2API JSON 账号必须是对象",
    sub2apiMissingAccess: "SUB2API JSON 缺少 credentials.access_token",
    sub2apiMissingRefresh: "SUB2API JSON 缺少 credentials.refresh_token 字段",
    sub2apiMissingExpires: "SUB2API JSON 缺少有效的 expires_at/expires 时间",
  },
  grok: {
    notLoggedIn:
      "Grok 未登录。请先在 模型 → xAI 或 Grok CLI 完成 OAuth 登录，或设置 GROK_CLI_OAUTH_TOKEN 环境变量。",
  },
  terminalEnv: {
    noJson: "模型没有返回 JSON 对象",
    rootNotObject: "模型返回 JSON 根节点不是对象",
    noEnv: "模型没有解析出有效环境变量",
  },
  chat: {
    authFailed: "模型认证失败。请打开「模型」重新登录或更新 API Key。",
    quotaExceeded: "当前账号额度不足或请求过快。请查看额度、切换账号/模型，或稍后重试。",
    networkFailed: "无法连接模型服务。请检查代理和网络配置。",
    modelNotFound: "当前模型不可用。请重新发现模型或切换到其他模型。",
    emptyResponse: "模型未返回有效内容。可重试；技术详情见下方。",
    providerFailed: "模型请求失败。请查看技术详情后重试或切换模型。",
  },
} as const satisfies MessageTree;

export const errorsEn = {
  oauth: {
    cpaNotObject: "CPA JSON must be an object",
    cpaMissingAccess: "CPA JSON is missing access_token",
    cpaMissingRefresh: "CPA JSON is missing refresh_token",
    cpaMissingExpires: "CPA JSON is missing a valid expired/expires timestamp",
    sub2apiNotObject: "SUB2API JSON must be an object",
    sub2apiAccountsEmpty: "SUB2API JSON accounts must not be empty",
    sub2apiAccountNotObject: "SUB2API JSON account must be an object",
    sub2apiMissingAccess: "SUB2API JSON is missing credentials.access_token",
    sub2apiMissingRefresh: "SUB2API JSON is missing credentials.refresh_token",
    sub2apiMissingExpires: "SUB2API JSON is missing a valid expires_at/expires timestamp",
  },
  grok: {
    notLoggedIn:
      "Grok is not logged in. Complete OAuth in Models → xAI or Grok CLI, or set GROK_CLI_OAUTH_TOKEN.",
  },
  terminalEnv: {
    noJson: "The model did not return a JSON object",
    rootNotObject: "The model JSON root is not an object",
    noEnv: "The model did not produce any valid environment variables",
  },
  chat: {
    authFailed: "Model authentication failed. Open Models to re-login or update the API key.",
    quotaExceeded: "Account quota is exhausted or requests are too frequent. Check quota, switch account/model, or retry later.",
    networkFailed: "Could not reach the model service. Check proxy and network settings.",
    modelNotFound: "The selected model is unavailable. Rediscover models or switch to another one.",
    emptyResponse: "The model returned no usable content. Retry; see technical details below.",
    providerFailed: "The model request failed. Review technical details, then retry or switch models.",
  },
} as const satisfies MessageTree;
