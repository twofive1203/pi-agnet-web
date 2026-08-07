import type { MessageTree } from "../types";

export const accessZh = {
  title: "解锁蜗牛派",
  subtitle: "输入访问密钥以继续",
  accessKeyLabel: "访问密钥",
  accessKeyPlaceholder: "粘贴访问密钥",
  unlock: "解锁",
  unlocking: "正在验证…",
  invalidKey: "访问密钥无效，请重试。",
  rateLimited: "尝试次数过多，请稍后再试。",
  unavailable: "认证服务暂不可用，请检查服务器日志。",
  networkError: "网络错误，请重试。",
  httpWarningTitle: "明文传输风险",
  httpWarningBody:
    "当前通过 HTTP 访问。访问密钥与登录会话不会被加密，不适合直接暴露到公网。请优先使用 HTTPS 反向代理。",
  logout: "退出登录",
  loggingOut: "正在退出…",
} as const satisfies MessageTree;

export const accessEn = {
  title: "Unlock Snail Pi",
  subtitle: "Enter the access key to continue",
  accessKeyLabel: "Access key",
  accessKeyPlaceholder: "Paste access key",
  unlock: "Unlock",
  unlocking: "Verifying…",
  invalidKey: "Invalid access key. Try again.",
  rateLimited: "Too many attempts. Please wait and try again.",
  unavailable: "Authentication is unavailable. Check server logs.",
  networkError: "Network error. Please retry.",
  httpWarningTitle: "Unencrypted transport",
  httpWarningBody:
    "You are using HTTP. The access key and login session are not encrypted and must not be exposed on the public internet. Prefer an HTTPS reverse proxy.",
  logout: "Log out",
  loggingOut: "Logging out…",
} as const satisfies MessageTree;
