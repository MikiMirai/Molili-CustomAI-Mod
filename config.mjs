/**
 * config.mjs — reads molili.config.json (next to molili-lmstudio.mjs).
 *
 * Every setting lives in this file (molili.config.json). Keys are the setting names (LMSTUDIO_URL, TEMPERATURE, DIARY_ORDER, ...).
 * A setting that is not in the file uses its built-in default. Environment variables are not read.
 * Booleans can be written as true/false or 1/0. Paths can be relative to the folder of molili-lmstudio.mjs.
 * Lines whose key starts with "_" are descriptions for you and are ignored.
 *
 * Problems (unknown key, wrong type, unreadable file) never stop the mod: they are returned as messages
 * and printed at startup, and the bad value is ignored.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'molili.config.json';

const NUMBER = new Set(['CDP_PORT', 'MAX_TURNS', 'TEMPERATURE', 'CRAWL_PAGE_SIZE', 'DIARY_BACKFILL', 'DIARY_DELAY_MS', 'CLOUD_TIMEOUT_MS']);
const BOOLEAN = new Set(['STREAM', 'DEBUG', 'RECORD', 'GATEWAY', 'OFFLINE_STUB', 'LOCAL_BLOCK_NET']);
const PATH = new Set(['PERSONA_FILE', 'HISTORY_FILE', 'ACCOUNT_FILE', 'COMPANION_FILE', 'CAPTURE_DIR', 'DIARY_FILE', 'SEED_FILE']);
const STRING = new Set(['LOGIN_MODE', 'LMSTUDIO_URL', 'LMSTUDIO_MODEL', 'CRAWL', 'DIARY', 'DIARY_ORDER', 'CLOUD_BASE', 'ALLOW_ORIGINS']);
export const KNOWN_KEYS = new Set([...NUMBER, ...BOOLEAN, ...PATH, ...STRING]);

/**
 * @returns {{ values: Map<string,string>, file: string|null, problems: string[] }}
 *   values: the file's settings as the strings the rest of the mod reads (booleans become '1'/'0')
 */
export function loadConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  const out = { values: new Map(), file: null, problems: [] };
  if (!fs.existsSync(file)) return out;
  out.file = file;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { out.problems.push(`${CONFIG_FILE} could not be read (${e.message}) — using the built-in settings`); return out; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.problems.push(`${CONFIG_FILE} must be a JSON object { "KEY": value } — using the built-in settings`); return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;                       // "_note": "..." lines are allowed for you
    if (!KNOWN_KEYS.has(key)) { out.problems.push(`${CONFIG_FILE}: unknown setting "${key}" — ignored (check the spelling)`); continue; }
    if (value === null || value === undefined) continue;
    if (NUMBER.has(key)) {
      const n = Number(value);
      if (typeof value === 'boolean' || value === '' || !Number.isFinite(n)) { out.problems.push(`${CONFIG_FILE}: "${key}" must be a number — ignored`); continue; }
      out.values.set(key, String(n));
    } else if (BOOLEAN.has(key)) {
      const v = value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' ? '1'
        : value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false' ? '0' : null;
      if (v === null) { out.problems.push(`${CONFIG_FILE}: "${key}" must be true or false — ignored`); continue; }
      out.values.set(key, v);
    } else if (PATH.has(key)) {
      if (typeof value !== 'string' || !value.trim()) { out.problems.push(`${CONFIG_FILE}: "${key}" must be a path in quotes — ignored`); continue; }
      out.values.set(key, path.resolve(dir, value.trim()));
    } else {
      if (typeof value !== 'string' && typeof value !== 'number') { out.problems.push(`${CONFIG_FILE}: "${key}" must be text — ignored`); continue; }
      out.values.set(key, String(value));
    }
  }
  return out;
}
