/**
 * Compare zh/en leaf keys under lib/i18n/messages and exit non-zero on mismatch.
 *
 * Usage: npx tsx scripts/check-i18n-keys.ts
 */
import { enMessages, zhMessages } from "../lib/i18n/messages";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") keys.push(path);
    else if (value && typeof value === "object") keys.push(...flatten(value as Tree, path));
  }
  return keys.sort();
}

const zh = new Set(flatten(zhMessages as Tree));
const en = new Set(flatten(enMessages as Tree));
const onlyZh = [...zh].filter((key) => !en.has(key));
const onlyEn = [...en].filter((key) => !zh.has(key));

console.log(`zh keys: ${zh.size}`);
console.log(`en keys: ${en.size}`);
console.log(`only in zh: ${onlyZh.length}`);
for (const key of onlyZh) console.log(`  ${key}`);
console.log(`only in en: ${onlyEn.length}`);
for (const key of onlyEn) console.log(`  ${key}`);

if (onlyZh.length > 0 || onlyEn.length > 0) {
  process.exitCode = 1;
}
