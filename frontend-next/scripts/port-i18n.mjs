// One-shot script: port legacy frontend/src/i18n.js translations into
// frontend-next/src/locales/{de,en}.json. Run from repo root:
//   node frontend-next/scripts/port-i18n.mjs
//
// Strategy:
//   * Stub `localStorage` and `document` so we can dynamic-import the legacy module.
//   * Read its internal `translations` object via a small re-export shim file we write next to it.
//   * Flatten `'a.b.c': 'value'` keys into nested objects.
//   * Convert `{var}` placeholders → `{{var}}` (i18next syntax).
//   * Merge into existing locale JSON, with legacy values being authoritative
//     for shared keys (so naming stays consistent across the two UIs).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const legacyI18nPath = resolve(repoRoot, 'frontend/src/i18n.js');
const localesDir = resolve(__dirname, '../src/locales');

// Stub browser globals before importing legacy module.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document = { documentElement: { lang: 'de' } };
try { Object.defineProperty(globalThis, 'navigator', { value: { language: 'de' }, configurable: true }); } catch { /* ignore */ }

// The legacy module keeps `translations` as a private const. Read source and
// extract the object literal directly with a regex on the top-level
// `const translations = { ... };` block.
const src = readFileSync(legacyI18nPath, 'utf8');
const match = src.match(/const translations = (\{[\s\S]*?\n\});\s*\n\s*function detectLang/);
if (!match) {
  console.error('Could not locate translations object in legacy i18n.js');
  process.exit(1);
}
// Use Function constructor to evaluate the object literal in isolated scope.
const translations = new Function(`return (${match[1]});`)();

if (!translations.de || !translations.en) {
  console.error('Expected de + en in extracted translations');
  process.exit(1);
}

function convertPlaceholders(value) {
  if (typeof value !== 'string') return value;
  // Replace {name} → {{name}} but skip already-doubled patterns and JSON-ish numbers.
  return value.replace(/\{(\w+)\}/g, '{{$1}}');
}

function setNested(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof node[key] !== 'object' || node[key] === null || Array.isArray(node[key])) {
      node[key] = {};
    }
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

function flattenToNested(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    setNested(out, k, convertPlaceholders(v));
  }
  return out;
}

function deepMerge(base, override) {
  // Override wins; recurse on nested objects.
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  if (typeof override !== 'object' || override === null || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return {}; }
}

for (const lang of ['de', 'en']) {
  const file = resolve(localesDir, `${lang}.json`);
  const existing = loadJson(file);
  const ported = flattenToNested(translations[lang]);
  // Merge: legacy translations win on conflict (port is authoritative),
  // existing keys (only present in next-only namespaces) are kept.
  const merged = deepMerge(existing, ported);
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  const flatCount = Object.keys(translations[lang]).length;
  console.log(`[port-i18n] ${lang}: merged ${flatCount} keys → ${file}`);
}

console.log('[port-i18n] done. Use ' + pathToFileURL(localesDir).pathname + ' to inspect output.');
