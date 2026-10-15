/**
 * capture.mjs — keep a local copy of what Molili's server says, so the diary and the store can be shown without it.
 *
 *   capture/<endpoint>.json                 newest 3 samples per endpoint (human-readable overview)
 *   capture/requests/<endpoint>/<hash>.json every distinct request ever seen + its answer (used for offline replay)
 *   capture/assets/<hash>.<ext> + index.json  pictures / sounds / language files the answers point to
 *   capture/crawl-report.json               what the last "save everything" run found
 *
 * Tokens and login codes are blanked. The files still contain your own data, so don't post them publicly.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const safe = s => s.replace(/[^A-Za-z0-9._-]+/g, '__');

/** the app's own request signature: MD5(timestamp + body + nonce + client secret), upper-case */
export const signRequest = (ts, body, nonce) => md5(`${ts}${body}${nonce}I9ozgeGiXaeSlEPY`).toUpperCase();
const NONCE_CHARS = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
const nonce = (n = 21) => Array.from(crypto.randomBytes(n), b => NONCE_CHARS[b & 63]).join('');

const REDACT = /^(token|refreshToken|accessToken|sign|secret|password|authorization|cookie)$/i;
export function scrub(v, ep = '') {
  if (Array.isArray(v)) return v.map(x => scrub(x, ep));
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = REDACT.test(k) || (k === 'code' && ep.endsWith('loginByCode')) ? '<redacted>' : scrub(x, ep);
    return o;
  }
  return v;
}
/** request body -> stable string. Ignores timestamp and agentId (it can differ between the server and a local account). */
export function normBody(b) {
  const strip = o => Array.isArray(o) ? o.map(strip)
    : isObj(o) ? Object.fromEntries(Object.keys(o).sort().filter(k => k !== 'timestamp' && k !== 'agentId').map(k => [k, strip(o[k])])) : o;
  return JSON.stringify(strip(isObj(b) || Array.isArray(b) ? b : {}));
}

/* ================================================================== Capture */
export class Capture {
  constructor(dir, log, enabled = true) {
    this.dir = dir; this.log = log; this.enabled = enabled;
    this.mem = new Map();                      // endpoint -> Map(key -> {status, body, response})
    this.#loadAll();                           // always load: RECORD=0 stops saving, not replaying
  }
  #reqDir(ep) { return path.join(this.dir, 'requests', safe(ep)); }
  #loadAll() {
    const root = path.join(this.dir, 'requests');
    if (!fs.existsSync(root)) return;
    for (const d of fs.readdirSync(root)) {
      for (const f of fs.readdirSync(path.join(root, d))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8'));
          if (!this.mem.has(j.endpoint)) this.mem.set(j.endpoint, new Map());
          this.mem.get(j.endpoint).set(f.replace(/\.json$/, ''), j);
        } catch { /* skip damaged file */ }
      }
    }
  }
  get requestCount() { let n = 0; for (const m of this.mem.values()) n += m.size; return n; }
  get endpointCount() { return this.mem.size; }

  /** store one answer. `replayable` = false for login/profile endpoints (kept only as the short overview). */
  record(ep, method, reqBody, status, text, ctype, replayable = true) {
    if (!this.enabled) return;
    try {
      let res = text;
      if (/json/i.test(ctype || '') || /^\s*[\[{]/.test(text)) { try { res = scrub(JSON.parse(text), ep); } catch { /* keep text */ } }
      if (typeof res === 'string' && res.length > 200_000) res = `<${res.length} chars not stored>`;
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, safe(ep) + '.json');
      let doc = { endpoint: ep, method, count: 0, samples: [] };
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
      doc.count = (doc.count || 0) + 1; doc.lastSeen = new Date().toISOString();
      doc.samples = [...(doc.samples || []), { ts: doc.lastSeen, status, request: scrub(reqBody, ep), response: res }].slice(-3);
      this.#write(file, doc);
      if (replayable && status === 200 && isObj(res)) {
        const key = sha1(normBody(reqBody)).slice(0, 16);
        const entry = { endpoint: ep, body: scrub(reqBody, ep), status, response: res, savedAt: doc.lastSeen };
        fs.mkdirSync(this.#reqDir(ep), { recursive: true });
        this.#write(path.join(this.#reqDir(ep), key + '.json'), entry);
        if (!this.mem.has(ep)) this.mem.set(ep, new Map());
        this.mem.get(ep).set(key, entry);
      }
    } catch (e) { this.log('capture: could not save:', e.message); }
  }
  #write(file, obj) { fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 1)); fs.renameSync(file + '.tmp', file); }

  /** exact match on the normalised request body */
  lookup(ep, body) { return this.mem.get(ep)?.get(sha1(normBody(body)).slice(0, 16)) || null; }
  /** newest saved answer for an endpoint, whatever the request was */
  newest(ep) {
    const m = this.mem.get(ep); if (!m) return null;
    return [...m.values()].sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))[0] || null;
  }
  has(ep) { return this.mem.has(ep); }
}

/** endpoints whose answers are never replayed offline: login, the profile itself, and the settings (owned by account.json) */
export const replayableEndpoint = ep => !(/^(loginApi|userSettingsApi)\//.test(ep) || ep === 'userInfoApi/v1/getUserInfo');

/* =================================================================== Assets */
const EXT_BY_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'application/json': '.json' };
export class Assets {
  constructor(dir, log, hosts) {
    this.dir = path.join(dir, 'assets'); this.log = log; this.hosts = hosts; this.index = {};
    try { this.index = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); } catch { /* none yet */ }
  }
  get count() { return Object.keys(this.index).length; }
  static key(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch { return null; } }
  /** is this URL one we should keep a copy of? (a Molili / cloud-storage file, never the API itself) */
  wanted(u) {
    let x; try { x = new URL(u); } catch { return false; }
    if (!/^https?:$/.test(x.protocol) || x.hostname === 'api.molili.net') return false;
    return this.hosts.some(h => x.host === h || x.host.endsWith('.' + h) || x.hostname === h || x.hostname.endsWith('.' + h));
  }
  /** local copy for a URL, or null */
  lookup(u) {
    const e = this.index[Assets.key(u)]; if (!e) return null;
    const file = path.join(this.dir, e.file);
    return fs.existsSync(file) ? { file, type: e.type } : null;
  }
  static urlsIn(v, out = new Set()) {
    if (typeof v === 'string') { for (const m of v.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) out.add(m[0]); }
    else if (Array.isArray(v)) v.forEach(x => Assets.urlsIn(x, out));
    else if (isObj(v)) Object.values(v).forEach(x => Assets.urlsIn(x, out));
    return out;
  }
  #save() { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, 'index.json.tmp'), JSON.stringify(this.index, null, 1)); fs.renameSync(path.join(this.dir, 'index.json.tmp'), path.join(this.dir, 'index.json')); }
  /** download one URL (skips what we already have). returns 'new' | 'have' | 'failed' */
  async fetchOne(u) {
    const key = Assets.key(u); if (!key) return 'failed';
    if (this.lookup(u)) return 'have';
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 30_000);
      const r = await fetch(u, { signal: ac.signal }).finally(() => clearTimeout(t));
      if (!r.ok) return 'failed';
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 60 * 1024 * 1024) return 'failed';
      const type = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      const ext = path.extname(new URL(u).pathname) || EXT_BY_TYPE[type] || '';
      const file = sha1(key).slice(0, 16) + ext;
      fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, file), buf);
      this.index[key] = { file, type, size: buf.length, url: key }; this.#save();
      return 'new';
    } catch { return 'failed'; }
  }
  async fetchMany(urls, onProgress) {
    const res = { new: 0, have: 0, failed: 0, failedUrls: [] }; let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++]; const r = await this.fetchOne(u); res[r]++; if (r === 'failed') res.failedUrls.push(u);
        onProgress?.(i, urls.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return res;
  }
}

/* ==================================================================== Crawl */
/**
 * One-time "save everything" run: pages through the whole diary and every store category with the same requests the
 * game itself makes (same signature, your own login), then downloads the pictures they point to.
 * Gentle: one request at a time, with a short pause.
 */
export const CRAWL_VERSION = 2;   // 2 = also saves the backpack, favor, skills, mail, favorites and task panels
export async function crawl({ base, seen, capture, assets, mirror, log, diaryPageSize = 60, extraUrls = [], delayMs = 250 }) {
  const t0 = Date.now(); const report = { version: CRAWL_VERSION, startedAt: new Date(t0).toISOString(), diary: { pages: 0, entries: 0 }, store: { categories: 0, pages: 0, items: 0 }, extras: {}, errors: [] };
  const hdr = { 'content-type': 'application/json', origin: 'http://tauri.localhost', appname: 'Molili' };
  for (const k of ['token', 'deviceid', 'accept-language']) if (seen[k]) hdr[k] = seen[k];
  let failStreak = 0; const diarySeen = new Set();   // the server repeats entries across pages: count each once
  const post = async (ep, bodyObj, method = 'POST') => {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = Math.floor(Date.now() / 1000), n = nonce();
    const headers = { ...hdr, timestamp: String(ts), nonce: n, sign: signRequest(ts, body, n) };
    if (bodyObj === undefined || method === 'GET') delete headers['content-type'];
    await sleep(delayMs);
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15_000);
      const r = await fetch(`${base}/molili/${ep}`, { method, headers, body: method === 'GET' || !body ? undefined : body, signal: ac.signal }).finally(() => clearTimeout(t));
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
      if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} (login expired?)`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      failStreak = 0;
      const replayable = replayableEndpoint(ep);
      capture.record(ep, method, bodyObj ?? {}, r.status, text, 'application/json', replayable);
      mirror?.(`/molili/${ep}`, bodyObj ?? {}, r.status, json);
      return json;
    } catch (e) {
      report.errors.push(`${ep}: ${e.message}`); log(`crawl: ${ep} failed (${e.message})`);
      if (++failStreak >= 3) throw new Error('too many failures in a row — stopping');
      return null;
    }
  };
  try {
    log('crawl: started (diary, store, backpack, favor, skills, mail, favorites, pictures) — keep the game open until it says finished');
    const settings = await post('userSettingsApi/v1/getSettingsConfig', { timestamp: Date.now() });
    await post('userInfoApi/v1/getUserInfo', { timestamp: Date.now() });
    await post('userInfoApi/v1/getUserAsset', undefined, 'GET');   // balances: energy, stardust, ether film
    const agentId = settings?.data?.configs?.agentId?.propVal;
    if (!agentId) throw new Error('could not read the agent id from the server');

    // --- diary: pageIndex 0,1,2,... until a page comes back empty (covers both 0- and 1-based paging)
    for (let page = 0; page < 500; page++) {
      const j = await post('diaryApi/v1/pageQuery', { pageIndex: page, pageSize: diaryPageSize, agentId, needTotalCount: true, orderDirection: 'DESC', orderBy: 'date' });
      const recs = j?.data?.records;
      if (!Array.isArray(recs)) break;
      report.diary.pages++; for (const r of recs) diarySeen.add(JSON.stringify(r)); report.diary.entries = diarySeen.size;
      log(`crawl: diary page ${page} (${recs.length} entries)`);
      if (recs.length === 0 && page > 0) break;
      if (recs.length === 0 && page === 0) continue;
    }
    // --- store: every category, pages of 9 until a short page
    const cats = (await post('storeApi/v1/categoryList'))?.data;
    if (Array.isArray(cats)) {
      for (const c of cats) {
        report.store.categories++;
        for (let w = 1; w < 200; w++) {
          const j = await post('storeApi/v1/item/pageQuery', { agentId, category: c.id, pageSize: 9, pageIndex: w, orderBy: '', orderDirection: '', groupBy: '', needTotalCount: true, offset: (w - 1) * 9 });
          const recs = j?.data?.records; if (!Array.isArray(recs)) break;
          report.store.pages++; report.store.items += recs.length;
          if (recs.length < 9) break;
        }
        log(`crawl: store category "${c.name ?? c.id}" done`);
      }
    }

    // --- the other panels, with the server's real answers, so backpack / favor / skills / mail / favorites / tasks work offline too.
    // Each one is optional: a failure here never stops the rest.
    const extra = async (name, fn) => {
      failStreak = 0;
      try { report.extras[name] = await fn(); log(`crawl: ${name} saved`); }
      catch (e) { report.errors.push(`${name}: ${e.message}`); log(`crawl: ${name} skipped (${e.message})`); }
    };
    const pages = async (ep, mk, size) => {
      let n = 0;
      for (let w = 1; w < 200; w++) { const j = await post(ep, mk(w)); const recs = j?.data?.records; if (!Array.isArray(recs)) break; n += recs.length; if (recs.length < size) break; }
      return n;
    };
    await extra('skills', async () => { await post('skillApi/v1/all'); return 1; });
    await extra('favor', async () => { await post('favorApi/v1/info', { agentId }); await post('favorApi/v1/levelInfo', { agentId }); return 1; });
    await extra('tasks', async () => { await post('userCompanionTaskApi/v1/query', { agentId }); await post('userCompanionTaskApi/v1/list', { agentId }); return 1; });
    await extra('mail', () => pages('userMailApi/v1/list', w => ({ pageIndex: w, pageSize: 20 }), 20));
    await extra('favorites', () => pages('favoriteApi/v1/list', w => ({ pageSize: 20, pageIndex: w, agentId }), 20));
    await extra('backpack', async () => {
      const bc = (await post('backPackApi/v1/categoryList'))?.data; let n = 0;
      if (Array.isArray(bc)) for (const c of bc) n += await pages('backPackApi/v1/items', w => ({ agentId, category: c.id, pageSize: 9, pageIndex: w, orderBy: '', orderDirection: '', groupBy: '', needTotalCount: true, offset: (w - 1) * 9 }), 9);
      return n;
    });
  } catch (e) { report.errors.push(String(e.message)); log('crawl: stopped —', e.message); }

  // --- pictures and files referenced by anything we saved (+ language files, + the background picture)
  const urls = new Set(extraUrls.filter(u => assets.wanted(u)));
  for (const m of capture.mem.values()) for (const e of m.values()) Assets.urlsIn(e.response, urls);
  for (const u of [...urls]) if (!assets.wanted(u)) urls.delete(u);
  log(`crawl: downloading ${urls.size} files ...`);
  let lastLog = 0;
  const dl = await assets.fetchMany([...urls], (i, n) => { if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`crawl: files ${i}/${n}`); } });
  report.assets = { found: urls.size, new: dl.new, alreadyHad: dl.have, failed: dl.failed, failedUrls: dl.failedUrls.slice(0, 50) };
  report.finishedAt = new Date().toISOString(); report.seconds = Math.round((Date.now() - t0) / 1000);
  try { fs.mkdirSync(capture.dir, { recursive: true }); fs.writeFileSync(path.join(capture.dir, 'crawl-report.json'), JSON.stringify(report, null, 1)); } catch { /* ignore */ }
  log(`crawl: finished — diary ${report.diary.entries} entries / ${report.diary.pages} pages, store ${report.store.items} items in ${report.store.categories} categories, files ${dl.new} new + ${dl.have} already saved, ${dl.failed} failed (${report.seconds}s)`);
  return report;
}
