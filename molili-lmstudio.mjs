#!/usr/bin/env node
/**
 * molili-lmstudio v3 — local chat, history and account for Molili.
 *
 * Molili.exe is a Tauri app (Rust + WebView2). Its web front end talks to http://api.molili.net/molili/...
 * This script attaches to WebView2 over the Chrome DevTools Protocol and sits in front of that API:
 *   chat / dialog list / dialog latest / suggestions  -> handled locally (LM Studio + chat-history.jsonl)
 *   login / user info / settings                      -> real server while it is reachable (and mirrored into
 *                                                        account.json), your saved local account when it is not
 *   everything else                                   -> forwarded to the real server and recorded in ./capture
 *                                                        (so the answers can be recreated if the server goes away)
 *
 * Needs Node 22+ (built-in WebSocket/fetch). No npm packages.
 *
 * Files next to this script:
 *   persona.txt           your character sheet (optional; see persona.example.txt)
 *   chat-history.jsonl    the saved conversation
 *   account.json          the saved local account (see account.mjs for the layout)
 *   capture/              recorded server responses, one file per endpoint (tokens are blanked)
 *
 * Settings: molili.config.json next to this file (every setting is described inside it; see README.md).
 * Env vars: LMSTUDIO_URL, LMSTUDIO_MODEL, TEMPERATURE, MAX_TURNS, CDP_PORT, PERSONA_FILE, HISTORY_FILE,
 *           STREAM (0 = send each reply in one piece), DEBUG (1 = verbose),
 *           LOGIN_MODE (auto [default] | local | cloud; local = everything from files, the server is never contacted),
 *           DIARY (auto = daily diary in local mode | 1 | 0), DIARY_FILE, DIARY_BACKFILL, LOCAL_BLOCK_NET (0 = allow other hosts in local mode),
 *           ACCOUNT_FILE, GATEWAY (0 = only chat/history are local),
 *           RECORD (0 = don't record server responses), CAPTURE_DIR, CLOUD_BASE, CLOUD_TIMEOUT_MS,
 *           OFFLINE_STUB (1 = answer unknown endpoints with an empty success when the server is down)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Account } from './account.mjs';
import { Capture, Assets, crawl, normBody, replayableEndpoint, CRAWL_VERSION } from './capture.mjs';
import { LocalDiary, localDate, daysAgo, dayRange, chatDigest, diaryMessages, cleanDiary } from './diary.mjs';
import { writeStub, fallbackStub } from './localapi.mjs';
import { Companion } from './companion.mjs';
import { LevelLog } from './levels.mjs';
import { followUpEnabled, buildSuggestMessages, parseSuggestions } from './suggest.mjs';
import { loadConfig, CONFIG_FILE } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// settings come only from molili.config.json; a missing setting uses the built-in default
const CFG = loadConfig(HERE);
const CONFIG_PROBLEMS = CFG.problems;
const SOURCE = new Map();   // where each setting came from, for the console
const env = (k, d) => {
  if (CFG.values.has(k)) { SOURCE.set(k, CONFIG_FILE); return CFG.values.get(k); }
  SOURCE.set(k, 'default'); return d;
};
const LM_URL = env('LMSTUDIO_URL', 'http://localhost:1234/v1/chat/completions');
const LM_MODEL = env('LMSTUDIO_MODEL', '');
const CDP_PORT = Number(env('CDP_PORT', 9222));
const MAX_TURNS = Number(env('MAX_TURNS', 30));
const TEMPERATURE = Number(env('TEMPERATURE', 0.8));
const STREAM = env('STREAM', '1') !== '0';
const DEBUG = env('DEBUG', '0') === '1';
const PERSONA_FILE = env('PERSONA_FILE', path.join(HERE, 'persona.txt'));
const HISTORY_FILE = env('HISTORY_FILE', path.join(HERE, 'chat-history.jsonl')); // '' = memory only
const ACCOUNT_FILE = env('ACCOUNT_FILE', path.join(HERE, 'account.json'));
const COMPANION_FILE = env('COMPANION_FILE', path.join(HERE, 'companion.json'));
const LEVELS_FILE = env('LEVELS_FILE', path.join(HERE, 'levels.json'));        // '' = memory only
const MODES = ['auto', 'local', 'cloud'];
const MODE_RAW = String(env('LOGIN_MODE', '')).trim();
const MODE_ENV = MODE_RAW.toLowerCase().replace(/^["']|["']$/g, '');   // tolerate "local " / "local" typos
let LOGIN_MODE = MODES.includes(MODE_ENV) ? MODE_ENV : 'auto';
let MODE_SOURCE = MODES.includes(MODE_ENV) ? `LOGIN_MODE (${SOURCE.get('LOGIN_MODE')})` : 'default';
const DIARY_ORDER_RAW = String(env('DIARY_ORDER', 'asc')).trim().toLowerCase();
const DIARY_ORDER = DIARY_ORDER_RAW === 'desc' ? 'desc' : 'asc';   // asc = oldest first (the server's own order); desc = newest first
const GATEWAY = env('GATEWAY', '1') !== '0';
const RECORD = env('RECORD', '1') !== '0';
const CAPTURE_DIR = env('CAPTURE_DIR', path.join(HERE, 'capture'));
const CLOUD_BASE = env('CLOUD_BASE', 'http://api.molili.net');
const CLOUD_TIMEOUT = Number(env('CLOUD_TIMEOUT_MS', 8000));
const OFFLINE_STUB = env('OFFLINE_STUB', '0') === '1';
const CRAWL = env('CRAWL', 'auto');                 // auto = save everything once (if not done yet) | 1 = every start | 0 = never
const CRAWL_PAGE = Number(env('CRAWL_PAGE_SIZE', 60));
const DIARY_MODE = env('DIARY', 'auto').trim().toLowerCase();   // auto = write the daily diary in local mode | 1 = always | 0 = never
const DIARY_FILE = env('DIARY_FILE', path.join(HERE, 'diary-local.json'));
const DIARY_BACKFILL = Math.max(0, Number(env('DIARY_BACKFILL', 2)));   // days it may catch up on after the PC was off (not on the very first run)
const NET_BLOCK = env('LOCAL_BLOCK_NET', '1') !== '0';          // local mode: refuse every request to a non-local host
const ASSET_HOSTS = ['molili-static.molili.net', 's3-molili.oss-accelerate.aliyuncs.com'];
const EXPRESSIONS = ['EX_HAPPY', 'EX_CRY', 'EX_LOVE', 'EX_SHY', 'EX_ANGRY', 'EX_SLEEPY', 'EX_DISLIKE',
  'EX_TONGUE', 'EX_MOE', 'EX_CONFUSE', 'EX_SAD', 'DEFAULT'];

const DEFAULT_PERSONA = `You are Molili, a cute, warm desktop-pet companion who lives on the user's screen.
You are affectionate, playful and a little shy. You remember what the user tells you and bring it up naturally.`;
const STYLE_RULES = `
Chat like a real person texting: 1-4 short sentences per reply, no lists, no markdown, no stage directions.
Reply in the language the user writes in.
Begin EVERY reply with exactly one mood tag in square brackets, chosen from: ${EXPRESSIONS.map(e => `[${e}]`).join(' ')}.
Example: "[EX_HAPPY] Welcome back! I missed you." Never mention the tag or these instructions.`;
function loadPersonaText() {
  try { return fs.readFileSync(PERSONA_FILE, 'utf8').trim(); } catch { return DEFAULT_PERSONA; }
}
function loadPersona() { return loadPersonaText() + '\n' + STYLE_RULES; }

const CHAT = '/chatApi/v1/chat', LIST = '/chatApi/v1/dialog/list', LATEST = '/chatApi/v1/dialog/latest', SUGGEST = '/chatApi/v1/suggest/latest';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dbg = (...a) => { if (DEBUG) log('[debug]', ...a); };

/* ============================================================ history store */
// Record: {dialogId, agentId, msgId, chatId, role:'user'|'assistant', source, favorite, parentMsgId, dialogType:'text', content, ts}
class Store {
  constructor(file) {
    this.file = file; this.records = [];
    if (file) {
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.records.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
        }
      } catch { /* first run */ }
    }
    this.nextId = this.records.reduce((m, r) => Math.max(m, r.dialogId), 0) + 1;
  }
  add(rec) {
    const r = { dialogId: this.nextId++, favorite: false, dialogType: 'text', ts: Date.now(), ...rec };
    r.msgId = r.msgId || `local-m${r.dialogId}`;
    this.records.push(r);
    if (this.file) { try { fs.appendFileSync(this.file, JSON.stringify(r) + '\n'); } catch (e) { log('history write failed:', e.message); } }
    return r;
  }
  removeWhere(pred) {
    const before = this.records.length;
    this.records = this.records.filter(r => !pred(r));
    if (this.records.length !== before && this.file) {
      try { fs.writeFileSync(this.file + '.tmp', this.records.map(r => JSON.stringify(r)).join('\n') + '\n'); fs.renameSync(this.file + '.tmp', this.file); }
      catch (e) { log('history rewrite failed:', e.message); }
    }
  }
  forAgent(agentId) { return agentId ? this.records.filter(r => !r.agentId || r.agentId === agentId) : this.records; }
  /** dialog/list: `limit` records on one side of `afterId`, oldest first */
  page(agentId, { afterId, afterIdCompare = 'lt', limit = 20 }) {
    const all = this.forAgent(agentId);
    const hasAnchor = afterId !== undefined && afterId !== null && afterId !== '';
    const a = Number(afterId);
    let sel;
    if (afterIdCompare === 'gt') sel = (hasAnchor ? all.filter(r => r.dialogId > a) : all).slice(0, limit);
    else sel = (hasAnchor ? all.filter(r => r.dialogId < a) : all).slice(-limit);
    const older = sel.length ? all.some(r => r.dialogId < sel[0].dialogId) : false;
    const newer = sel.length ? all.some(r => r.dialogId > sel[sel.length - 1].dialogId) : false;
    return {
      dataList: sel, firstId: sel[0]?.dialogId ?? null, lastId: sel[sel.length - 1]?.dialogId ?? null,
      hasMore: afterIdCompare === 'gt' ? newer : older,
    };
  }
  /** dialog/latest: the assistant replies of the most recent turn (or of the turn `msgId` belongs to) */
  latest(agentId, msgId) {
    const all = this.forAgent(agentId);
    let parent = msgId;
    if (!parent || !all.some(r => r.parentMsgId === parent)) {
      const lastUser = [...all].reverse().find(r => r.role === 'user');
      parent = lastUser?.msgId;
    }
    return all.filter(r => r.role === 'assistant' && r.parentMsgId === parent);
  }
  /** LLM context: last MAX_TURNS user turns, consecutive assistant sentences merged into one message */
  context(agentId) {
    const msgs = [];
    for (const r of this.forAgent(agentId)) {
      if (r.role !== 'user' && r.role !== 'assistant') continue;
      const last = msgs[msgs.length - 1];
      if (last && last.role === r.role) last.content += (r.role === 'assistant' ? ' ' : '\n') + r.content;
      else msgs.push({ role: r.role, content: r.content });
    }
    let users = 0, cut = 0;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && ++users > MAX_TURNS) { cut = i + 1; break; }
    const out = msgs.slice(cut);
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }
}
const store = new Store(HISTORY_FILE);

/* ====================================================== streaming text tools */
/** removes <think>...</think> from a token stream */
class ThinkFilter {
  constructor() { this.pending = ''; this.inThink = false; }
  push(t) {
    this.pending += t; let out = '';
    for (;;) {
      if (this.inThink) {
        const i = this.pending.indexOf('</think>');
        if (i < 0) { this.pending = this.pending.slice(-8); break; }
        this.pending = this.pending.slice(i + 8); this.inThink = false; continue;
      }
      const i = this.pending.indexOf('<think>');
      if (i >= 0) { out += this.pending.slice(0, i); this.pending = this.pending.slice(i + 7); this.inThink = true; continue; }
      let k = Math.min(6, this.pending.length);
      while (k > 0 && !'<think>'.startsWith(this.pending.slice(-k))) k--;
      out += this.pending.slice(0, this.pending.length - k); this.pending = this.pending.slice(this.pending.length - k); break;
    }
    return out;
  }
  end() { const o = this.inThink ? '' : this.pending; this.pending = ''; return o; }
}
/** pulls a leading [EX_*] mood tag off the stream */
class TagParser {
  constructor() { this.buf = ''; this.done = false; }
  push(t) { // -> {emotion?, text}
    if (this.done) return { text: t };
    this.buf += t;
    const s = this.buf.replace(/^\s+/, '');
    if (!s) return { text: '' };
    if (s[0] !== '[') { this.done = true; this.buf = ''; return { text: s }; }
    const close = s.indexOf(']');
    if (close < 0) { if (s.length <= 24) return { text: '' }; this.done = true; this.buf = ''; return { text: s }; }
    this.done = true; this.buf = '';
    const tag = s.slice(1, close).trim().toUpperCase();
    const rest = s.slice(close + 1).replace(/^\s+/, '');
    return EXPRESSIONS.includes(tag) ? { emotion: tag, text: rest } : { text: s };
  }
  end() { const s = this.buf.trim(); this.buf = ''; this.done = true; return s; }
}
/** cuts a text stream into sentence-sized chunks (won't split after "Mr.", "Dr.", "J.", "e.g." ...) */
class Splitter {
  constructor() { this.buf = ''; }
  static END = /[。！？…]+["')\]”」』]*|[.!?]+["')\]”」』]*(?=\s)|\n/g;
  static ABBR = /(?:^|[\s("'“])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|[A-Z]|e\.g|i\.e)\.$/;
  push(t) {
    this.buf += t; const out = [];
    for (let skip = 0; ;) {
      Splitter.END.lastIndex = skip;
      const m = Splitter.END.exec(this.buf);
      if (!m) break;
      const end = m.index + m[0].length;
      if (m[0].startsWith('.') && Splitter.ABBR.test(this.buf.slice(0, m.index + 1))) { skip = end; continue; }
      const s = this.buf.slice(0, end).trim();
      this.buf = this.buf.slice(end); skip = 0;
      if (s) out.push(s);
    }
    return out;
  }
  end() { const s = this.buf.trim(); this.buf = ''; return s ? [s] : []; }
}

/* ============================================================= LM Studio */
async function* lmTokens(messages, signal) {
  const res = await fetch(LM_URL, {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(LM_MODEL ? { model: LM_MODEL } : {}), messages, temperature: TEMPERATURE, stream: true }),
  });
  if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') return;
      let tok = ''; try { tok = JSON.parse(data).choices?.[0]?.delta?.content ?? ''; } catch { /* keepalive */ }
      if (tok) yield tok;
    }
  }
}

/* ======================================================= chat -> SSE events */
// Molili's SSE parser does not trim after ':' — "event: x" would never match. Keep NO space.
const sse = (event, obj) => `event:${event}\ndata:${JSON.stringify(obj)}\n\n`;

/** Runs one chat turn. `emit(string)` receives SSE text as soon as it is ready. */
async function chatTurn(body, emit, signal) {
  const agentId = body.agentId || '';
  const retry = body.userAction === 'retry';
  let userText = (body.message || '').trim();
  let chatId = body.chatId || `local-c${Date.now()}`;
  let userRec = null;

  if (retry) { // regenerate: drop this turn's replies, reuse its user message
    store.removeWhere(r => r.role === 'assistant' && r.chatId === chatId);
    userRec = [...store.forAgent(agentId)].reverse().find(r => r.role === 'user' && r.chatId === chatId)
      || [...store.forAgent(agentId)].reverse().find(r => r.role === 'user');
    if (userRec) { userText = userRec.content; chatId = userRec.chatId; }
  }
  if (!userText) { emit(sse('conversation.chat.completed', {})); return; }

  // context = saved history (+ this message if it is new)
  const base = store.context(agentId);
  const context = retry ? base : [...base, { role: 'user', content: userText }];
  const messages = [{ role: 'system', content: loadPersona() }, ...context];

  let committed = false;
  const commitUser = () => {
    if (committed) return; committed = true;
    if (!userRec) userRec = store.add({ agentId, chatId, role: 'user', source: 'user', content: userText });
  };
  const sendSentence = s => {
    commitUser();
    const rec = store.add({ agentId, chatId, role: 'assistant', source: 'chat', parentMsgId: userRec.msgId, content: s });
    emit(sse('conversation.message.delta', {
      chatId, id: rec.msgId, key: rec.dialogId, parentMsgId: userRec.msgId, content: s, contentType: 'text', dialogId: rec.dialogId,
    }));
  };

  const think = new ThinkFilter(), tag = new TagParser(), split = new Splitter();
  let emotion = null, spoken = '';
  const feedBody = text => { for (const s of split.push(text)) { sendSentence(s); spoken += s + ' '; } };
  const feedTag = text => {
    const r = tag.push(text);
    if (r.emotion && !emotion) {
      emotion = r.emotion;
      emit(sse('conversation.agent.emotion', { chatId, id: `local-e${Date.now()}`, key: `emo-${Date.now()}`, content: emotion }));
    }
    if (r.text) feedBody(r.text);
  };
  try {
    for await (const tok of lmTokens(messages, signal)) { const t = think.push(tok); if (t) feedTag(t); }
    const t = think.end(); if (t) feedTag(t);
    const rest = tag.end(); if (rest) feedBody(rest);
    for (const s of split.end()) { sendSentence(s); spoken += s + ' '; }
    if (!spoken.trim()) sendSentence('…');
    log(`${retry ? '(retry) ' : ''}user: ${userText.slice(0, 50)}  ->  ${emotion || '-'} ${spoken.trim().slice(0, 80)}`);
  } catch (e) {
    if (signal?.aborted) { log('chat aborted by the app'); return; }
    log('LM Studio error:', e.message);
    emit(sse('conversation.message.delta', {
      chatId, id: `local-err${Date.now()}`, key: `err-${Date.now()}`, contentType: 'text',
      content: `(Can't reach LM Studio at ${LM_URL} — is the server running with a model loaded?)`,
    }));
  }
  emit(sse('conversation.message.completed', []));
  emit(sse('conversation.chat.completed', {}));
}

/* ============================================================ smart replies */
// The game asks for follow-up lines after a reply. They come from LM Studio, and only when the game's
// smart-reply switch (enableFollowUp) is on. The last answer is kept, since the game asks again for the same reply.
const suggestCache = new Map();   // agentId -> { key, list }
async function suggestReplies(agentId) {
  if (!followUpEnabled(account.state.settings?.configs)) return [];
  const context = store.context(agentId);
  const last = context[context.length - 1];
  if (!last || last.role !== 'assistant') return [];      // suggestions follow a reply
  const key = `${context.length}|${last.content}`;
  const hit = suggestCache.get(agentId);
  if (hit && hit.key === key) return hit.list;
  const messages = buildSuggestMessages(context, { name: characterName() });
  const think = new ThinkFilter(); let raw = '';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    for await (const tok of lmTokens(messages, ac.signal)) { const t = think.push(tok); if (t) raw += t; }
    const t = think.end(); if (t) raw += t;
  } finally { clearTimeout(timer); }
  const list = parseSuggestions(raw);
  suggestCache.set(agentId, { key, list });
  log(`smart replies: ${list.length ? list.map(x => `"${x}"`).join(', ') : 'none'}`);
  return list;
}

/* =========================================================== JSON endpoints */
const wire = r => ({
  dialogId: r.dialogId, msgId: r.msgId, chatId: r.chatId, role: r.role, source: r.source, favorite: !!r.favorite,
  parentMsgId: r.parentMsgId, dialogType: r.dialogType || 'text', content: r.content, supportTts: false,
});
function jsonEndpoint(pathname, body) {
  const agentId = body.agentId || '';
  if (pathname.endsWith(LIST)) {
    const p = store.page(agentId, body);
    return { data: { ...p, dataList: p.dataList.map(wire) } };
  }
  if (pathname.endsWith(LATEST)) return { data: store.latest(agentId, body.msgId).map(wire) };
  return { data: [] }; // SUGGEST
}
const envelope = data => JSON.stringify({ success: true, code: 0, errCode: null, errMessage: null, ...data });

/* ===================================================== who may talk to us */
// The gateway listens on 127.0.0.1 only, but any web page in your browser could still try that port.
// So every request must (1) carry a per-run secret that only this script adds, and (2) come from Molili's own origin.
const SECRET = crypto.randomBytes(16).toString('hex');
const ALLOWED_ORIGINS = new Set(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost', 'http://localhost:1420',
  ...env('ALLOW_ORIGINS', '').split(',').map(x => x.trim()).filter(Boolean)]);
const originOk = o => !o || ALLOWED_ORIGINS.has(o);
const cors = origin => (originOk(origin) && origin ? {
  'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin',
} : { Vary: 'Origin' });
const corsList = origin => Object.entries(cors(origin)).map(([name, value]) => ({ name, value }));
const authorized = req => req.headers['x-molili-local'] === SECRET && originOk(req.headers.origin);

/* ================================================================ recorder */
const DIARY = 'diaryApi/v1/pageQuery';

/** Older captures kept the newest answer of endpoints such as getUserAsset only in the overview file.
 *  Turn each of those into a replayable request, once, before the capture is loaded. */
function importOverviewSamples() {
  let n = 0;
  let files = []; try { files = fs.readdirSync(CAPTURE_DIR); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('crawl-')) continue;
    let doc; try { doc = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, f), 'utf8')); } catch { continue; }
    const ep = doc.endpoint;
    if (!ep || !replayableEndpoint(ep)) continue;
    const dir = path.join(CAPTURE_DIR, 'requests', ep.replace(/[^A-Za-z0-9._-]+/g, '__'));
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) continue;
    const last = (doc.samples || []).at(-1);
    if (!last || last.status !== 200 || typeof last.response !== 'object') continue;
    const key = crypto.createHash('sha1').update(normBody(last.request ?? {})).digest('hex').slice(0, 16);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify({ endpoint: ep, body: last.request ?? {}, status: 200, response: last.response, savedAt: last.ts }, null, 1));
    n++;
  }
  return n;
}
const imported = importOverviewSamples();
const capture = new Capture(CAPTURE_DIR, log, RECORD);
const assets = new Assets(CAPTURE_DIR, log, ASSET_HOSTS);
const seenHeaders = {};                  // the app's own token/deviceid/language, for the crawl
function record(ep, method, reqBody, status, text, ctype) {
  capture.record(ep, method, reqBody, status, text, ctype, replayableEndpoint(ep));
}

const diary = new LocalDiary(DIARY_FILE, log);

/** every diary record: the saved server entries + the ones written locally, in the order set by DIARY_ORDER (asc = oldest first, the server's order; desc = newest first) */
const byDate = (x, y) => String(x.createTime ?? '').localeCompare(String(y.createTime ?? ''));
function allDiaryRecords() {
  const uniq = new Map();
  for (const e of capture.mem.get(DIARY)?.values() ?? []) for (const r of e.response?.data?.records ?? []) uniq.set(r.id ?? r.diaryId ?? JSON.stringify(r), r);
  for (const r of diary.records()) uniq.set(`local-${r.createTime}`, r);
  return [...uniq.values()].sort(DIARY_ORDER === 'desc' ? (x, y) => byDate(y, x) : byDate);
}
/** the newest n entries, whatever DIARY_ORDER says (used for the diary writer's "recent" context) */
const recentDiaryRecords = n => [...allDiaryRecords()].sort((x, y) => byDate(y, x)).slice(0, n);
/** diary pages are served from ALL diary records, so any page size the app asks for works */
function diaryReplay(body) {
  const all = allDiaryRecords();
  if (!all.length) return null;
  const size = Math.max(1, Number(body.pageSize) || 10), idx = Math.max(0, Number(body.pageIndex) || 0);
  return { success: true, code: 0, errCode: null, errMessage: null, data: {
    records: all.slice(idx * size, (idx + 1) * size), total: all.length, size, current: idx, pages: Math.ceil(all.length / size) } };
}
/** a page of a saved list, whatever page size the app asks for: all saved pages of the same query, merged and re-sliced */
const PAGE_KEYS = new Set(['pageIndex', 'pageSize', 'offset']);
const groupKey = b => normBody(Object.fromEntries(Object.entries(b || {}).filter(([k]) => !PAGE_KEYS.has(k))));
function pagedReplay(ep, body) {
  const want = groupKey(body);
  const group = [...(capture.mem.get(ep)?.values() ?? [])].filter(e => Array.isArray(e.response?.data?.records) && groupKey(e.body) === want);
  if (!group.length) return null;
  const base = group.some(e => Number(e.body?.pageIndex) === 0) ? 0 : 1;
  group.sort((a, b) => (Number(a.body?.pageIndex) || 0) - (Number(b.body?.pageIndex) || 0));
  const uniq = new Map();
  for (const e of group) for (const r of e.response.data.records) uniq.set(r.id ?? r.itemCode ?? r.mailId ?? JSON.stringify(r), r);
  const all = [...uniq.values()];
  const size = Math.max(1, Number(body.pageSize) || 20), idx = Math.max(base, Number(body.pageIndex) || base), start = (idx - base) * size;
  return { success: true, code: 0, errCode: null, errMessage: null, data: {
    records: all.slice(start, start + size), total: all.length, size, current: idx, pages: Math.ceil(all.length / size), empty: !all.length, notEmpty: !!all.length } };
}
/** the profile card counts diary entries; keep that number in step with the entries that exist locally */
function patchSaved(ep, response) {
  if (ep === 'userInfoApi/v1/getUserAsset') return companion.patchAsset(response);   // balances plus what offline tasks earned
  if (ep === 'favorApi/v1/info') return companion.patchFavor(response, true);   // the Affection numbers
  if (ep !== 'agentApi/v1/overview' || !response?.data) return response;
  const out = companion.patchFavor(response, false);   // level and affinity progress (the top of the Main Panel and Overview)
  out.data.diaryCount = Math.max(Number(out.data.diaryCount) || 0, allDiaryRecords().length);
  return out;
}
/**
 * The answer for a request without the server: {status, json, how} or null.
 * order: success stubs for pings -> diary -> exact saved copy -> merged saved pages -> empty list / "not available".
 */
function answerFromFiles(ep, body) {
  const comp = companion.answer(ep, body); if (comp) return { status: comp.status, json: comp.json, how: comp.how };
  const w = writeStub(ep); if (w) return { ...w, how: 'local stub' };
  if (ep === DIARY) { const j = diaryReplay(body); if (j) return { status: 200, json: j, how: 'diary (saved + local)' }; }
  const hit = capture.lookup(ep, body);
  if (hit) return { status: 200, json: patchSaved(ep, hit.response), how: 'from saved capture' };
  const paged = pagedReplay(ep, body); if (paged) return { status: 200, json: paged, how: 'from saved capture (merged pages)' };
  const f = fallbackStub(ep); if (f) return { ...f, how: 'local stub' };
  return null;
}

/* ---------------------------------------------------------------- the daily diary */
const characterName = () => capture.newest('agentApi/v1/overview')?.response?.data?.name || '';
async function generateDiary(date) {
  const yesterday = daysAgo(1, dayRange(date)[0] + 12 * 3600e3);
  const { text: digest } = chatDigest(store.records, yesterday);
  const u = account.state.userInfo || {};
  const messages = diaryMessages({ persona: loadPersonaText(), characterName: characterName(), userName: u.username || u.nickname || '',
    date, digest, yesterday, recent: recentDiaryRecords(2).map(r => r.content) });
  const think = new ThinkFilter(); let out = '';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10 * 60_000);
  try {
    for await (const tok of lmTokens(messages, ac.signal)) { const t = think.push(tok); if (t) out += t; }
    const t = think.end(); if (t) out += t;
  } finally { clearTimeout(timer); }
  return cleanDiary(out);
}
const diaryOn = () => DIARY_MODE === '1' || (DIARY_MODE === 'auto' && LOGIN_MODE === 'local');
let diaryBusy = false, diaryLastWarn = 0;
/** writes today's entry (and, after the PC was off, up to DIARY_BACKFILL missed days) when it is not there yet */
async function diaryTick() {
  if (!diaryOn() || diaryBusy) return;
  // today, plus the days AFTER the newest entry that were missed (the PC was off); never days before it, never more than DIARY_BACKFILL
  const days = []; for (let i = diary.count ? DIARY_BACKFILL : 0; i >= 0; i--) days.push(daysAgo(i));
  const missing = days.filter(d => !diary.has(d) && (!diary.latest || d > diary.latest));
  if (!missing.length) return;
  diaryBusy = true;
  try {
    for (const day of missing) {
      log(`diary: writing the entry for ${day} ...`);
      const text = await generateDiary(day);
      diary.add(day, text);
      log(`diary: wrote the entry for ${day} (${text.length} characters) — it is on the diary page now`);
    }
  } catch (e) {
    if (Date.now() - diaryLastWarn > 30 * 60_000) { diaryLastWarn = Date.now(); log(`diary: could not write it yet (${e.message}) — will try again in a few minutes`); }
  } finally { diaryBusy = false; }
}

let crawlState = 'idle';                 // idle -> running -> done
async function maybeCrawl() {
  if (LOGIN_MODE === 'local' || crawlState !== 'idle' || CRAWL === '0' || !seenHeaders.token || Date.now() < cloudDownUntil) return;   // local mode never contacts the server
  if (CRAWL === 'auto') {   // once, unless the last run was by an older version that saved less
    const rf = path.join(CAPTURE_DIR, 'crawl-report.json');
    let v = 0; try { v = JSON.parse(fs.readFileSync(rf, 'utf8')).version || 1; } catch { v = fs.existsSync(rf) ? 1 : 0; }
    if (v >= CRAWL_VERSION) { crawlState = 'done'; return; }
  }
  crawlState = 'running';
  try {
    // LOGIN_MODE=local: the saved account is never overwritten from the server (the crawl still saves its answers to capture/)
    const mirror = LOGIN_MODE === 'local' ? null : (p, b, st, j) => account.mirror(p, b, st, j);
    await crawl({ base: CLOUD_BASE, seen: seenHeaders, capture, assets, mirror, log,
      diaryPageSize: CRAWL_PAGE, extraUrls: [] });
  } catch (e) { log('crawl stopped:', e.message); }
  finally { crawlState = 'done'; }
}

/* ================================================================ gateway */
const account = new Account(ACCOUNT_FILE, log);
const levels = new LevelLog(LEVELS_FILE, log);                          // how much affinity each level needs, as the server reports it
const companion = new Companion(COMPANION_FILE, log);   // the Accompany timer (local mode, and while the server is down)
// "loginMode": "local" inside account.json works when LOGIN_MODE is not set in molili.config.json
if (!MODES.includes(MODE_ENV) && MODES.includes(String(account.state.loginMode ?? '').trim().toLowerCase())) {
  LOGIN_MODE = String(account.state.loginMode).trim().toLowerCase(); MODE_SOURCE = 'account.json "loginMode"';
}
const STRIP_REQ = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-molili-local']);
const STRIP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const DOWN_STATUS = new Set([502, 503, 504, 521, 522, 523, 524, 530]);
let cloudDownUntil = 0, cloudWasDown = false;
const markDown = why => {
  cloudDownUntil = Date.now() + 30_000;
  if (!cloudWasDown) log(`cloud unreachable (${why}) — using local data where available; will retry in 30 s`);
  cloudWasDown = true;
};
const markUp = () => { if (cloudWasDown) log('cloud reachable again'); cloudWasDown = false; cloudDownUntil = 0; };
/** First start with no account.json: take the profile and settings from the capture, so the same account comes back. */
function seedAccountFromCapture() {
  if (account.exists) return false;
  const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, f), 'utf8')); } catch { return null; } };
  const profile = rd('userInfoApi__v1__getUserInfo.json')?.samples?.at(-1)?.response?.data;
  const cfg = rd('userSettingsApi__v1__getSettingsConfig.json')?.samples?.at(-1)?.response?.data;
  if (!profile || typeof profile !== 'object') return false;
  account.state.userInfo = { ...profile };
  if (cfg && typeof cfg.configs === 'object') account.state.settings = { ...cfg };
  account.state.session = { loggedIn: true, method: 'capture', lastLoginAt: new Date().toISOString() };
  account.state.meta.source = 'capture';
  account.save();
  log(`account: created from the capture — ${profile.username ?? profile.userId}, same settings and items`);
  return true;
}
const seenEndpoints = new Set();
const noteEndpoint = (ep, how) => { if (!seenEndpoints.has(ep + how)) { seenEndpoints.add(ep + how); log(`api ${ep} -> ${how}`); } };

async function cloudFetch(req, urlPath, raw) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!STRIP_REQ.has(k)) headers[k] = v;
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), CLOUD_TIMEOUT);
  try {
    const r = await fetch(CLOUD_BASE + urlPath, {
      method: req.method, headers, signal: ac.signal, redirect: 'manual',
      body: ['GET', 'HEAD'].includes(req.method) || !raw.length ? undefined : raw,
    });
    return { r, buf: Buffer.from(await r.arrayBuffer()) };
  } finally { clearTimeout(timer); }
}

async function gateway(req, res, raw) {
  const origin = req.headers.origin;
  for (const k of ['token', 'deviceid', 'accept-language']) if (req.headers[k]) seenHeaders[k] = req.headers[k];
  const urlPath = req.url.slice(3);                       // strip "/gw"
  const pathname = urlPath.split('?')[0];
  const ep = Account.ep(pathname);
  let body = {}; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* not json */ }
  const sendJson = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) }); res.end(JSON.stringify(obj));
  };
  const local = how => {
    const out = account.handle(pathname, body);
    noteEndpoint(ep, how); dbg(ep, JSON.stringify(body).slice(0, 200), '->', out.status, JSON.stringify(out.json).slice(0, 300));
    sendJson(out.status, out.json);
  };
  const mine = account.owns(pathname);

  if (mine && LOGIN_MODE === 'local') return local('local');

  if (LOGIN_MODE !== 'local') {                          // local mode: the server is never contacted, everything comes from the files
    if (Date.now() >= cloudDownUntil) {
      try {
        const { r, buf } = await cloudFetch(req, urlPath, raw);
        if (mine && DOWN_STATUS.has(r.status) && LOGIN_MODE === 'auto') { markDown(`HTTP ${r.status}`); }
        else {
          markUp();
          const text = buf.toString('utf8');
          const ctype = r.headers.get('content-type') || '';
          const headers = {};
          for (const [k, v] of r.headers) if (!STRIP_RES.has(k) && !k.startsWith('access-control-')) headers[k] = v;
          res.writeHead(r.status, { ...headers, 'Content-Length': buf.length, ...cors(origin) }); res.end(buf);
          noteEndpoint(ep, `cloud ${r.status}`);
          record(ep, req.method, body, r.status, text, ctype);
          let parsed = null; try { parsed = JSON.parse(text); } catch { /* ignore */ }
          if (r.status === 200 && (ep === 'agentApi/v1/overview' || ep === 'favorApi/v1/info')) levels.record(parsed?.data?.level, parsed?.data?.nextLevelFavor, ep === 'agentApi/v1/overview' ? 'overview' : 'affection');
          const note = mine ? account.mirror(pathname, body, r.status, parsed) : null;
          if (note) log(`account.json updated from the server (${note})`);
          if (r.status === 200) maybeCrawl().catch(e => log('crawl error:', e.message));
          return;
        }
      } catch (e) { markDown(e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message)); }
    }
    if (LOGIN_MODE === 'cloud') return sendJson(502, { success: false, errCode: 'CLOUD_UNREACHABLE', errMessage: 'Server unreachable', data: null });
  }
  if (mine) return local('local (server down)');
  const answer = answerFromFiles(ep, body);
  if (answer) { noteEndpoint(ep, answer.how); dbg(ep, JSON.stringify(body).slice(0, 200), '->', answer.status, answer.how); return sendJson(answer.status, answer.json); }
  noteEndpoint(ep, OFFLINE_STUB ? 'offline stub' : (LOGIN_MODE === 'local' ? 'unavailable (local mode: nothing saved for this)' : 'unavailable (server down, no local version yet)'));
  if (OFFLINE_STUB) return sendJson(200, { success: true, code: 0, errCode: null, errMessage: null, data: null });
  return sendJson(503, { success: false, errCode: 'OFFLINE', errMessage: 'Server unavailable (local mode)', data: null });
}

/* ============================================ local server (chat stream + gateway) */
let localPort = 0;
function startLocalServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const origin = req.headers.origin;
      if (req.method === 'OPTIONS') { res.writeHead(204, cors(origin)); return res.end(); }
      if (!authorized(req)) { res.writeHead(403); return res.end('forbidden'); }
      const chunks = []; req.on('data', d => chunks.push(d));
      req.on('end', async () => {
        const raw = Buffer.concat(chunks);
        try {
          if (req.url === '/chat') {
            let body = {}; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { /* ignore */ }
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors(origin) });
            const ac = new AbortController();
            res.on('close', () => { if (!res.writableEnded) ac.abort(); });
            await chatTurn(body, s => res.write(s), ac.signal);
            res.end();
          } else if (req.url.startsWith('/gw/')) await gateway(req, res, raw);
          else { res.writeHead(404); res.end(); }
        } catch (e) { log('local server error:', e.message); try { res.writeHead(500); } catch { /* sent */ } res.end(); }
      });
    });
    srv.listen(0, '127.0.0.1', () => { localPort = srv.address().port; dbg(`local server on 127.0.0.1:${localPort}`); resolve(); });
  });
}

/* ============================================================ CDP plumbing */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = [];
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
    this.closed = new Promise(res => { this.ws.onclose = res; });
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) this.handlers.forEach(h => h(msg));
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(h) { this.handlers.push(h); }
}

async function onPaused(cdp, ev) {
  const { sessionId, params: p } = ev;
  const { requestId, request } = p;
  const ok = (cmd, args) => cdp.send(cmd, { requestId, ...args }, sessionId).catch(e => log(`${cmd} failed:`, e.message));
  let u; try { u = new URL(request.url); } catch { return ok('Fetch.continueRequest'); }
  const pathname = u.pathname;
  const mine = [CHAT, LIST, LATEST, SUGGEST].some(x => pathname.endsWith(x));
  const origin = request.headers?.Origin || request.headers?.origin;

  if (!/^https?:$/.test(u.protocol)) return ok('Fetch.continueRequest');
  if (u.hostname !== 'api.molili.net') return onOtherHost(ok, request, u);      // pictures, and in local mode every other host

  if (request.method === 'OPTIONS') return ok('Fetch.fulfillRequest', { responseCode: 204, responseHeaders: corsList(origin) });

  // rewrite to our local server; the browser keeps the original body, we add the per-run secret
  const viaLocal = route => ok('Fetch.continueRequest', {
    url: `http://127.0.0.1:${localPort}${route}`,
    headers: [...Object.entries(request.headers || {}).map(([name, value]) => ({ name, value })), { name: 'x-molili-local', value: SECRET }],
  });

  if (mine) {
    let body = {}; try { body = JSON.parse(request.postData || '{}'); } catch { /* ignore */ }
    if (pathname.endsWith(CHAT)) {
      if (STREAM && localPort) return viaLocal('/chat');
      let text = '';
      await chatTurn(body, s => (text += s), undefined).catch(e => log('chat error:', e.message));
      return ok('Fetch.fulfillRequest', {
        responseCode: 200, body: Buffer.from(text, 'utf8').toString('base64'),
        responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream; charset=utf-8' }, ...corsList(origin)],
      });
    }
    let out;
    if (pathname.endsWith(SUGGEST)) {
      const list = await suggestReplies(body.agentId || '').catch(e => { log('smart replies: LM Studio error —', e.message); return []; });
      out = envelope({ data: list });
    } else out = envelope(jsonEndpoint(pathname, body));
    dbg(pathname.split('/').slice(-2).join('/'), JSON.stringify(body), '->', out.slice(0, 300));
    return ok('Fetch.fulfillRequest', {
      responseCode: 200, body: Buffer.from(out, 'utf8').toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, ...corsList(origin)],
    });
  }
  if ((GATEWAY || LOGIN_MODE === 'local') && localPort) return viaLocal('/gw' + u.pathname + u.search);
  return ok('Fetch.continueRequest');
}

/** pictures from Molili's storage hosts, and (local mode) every other host */
const loggedHosts = new Set();
const isLocalHost = h => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '::1';
function onOtherHost(ok, request, u) {
  const acao = { name: 'Access-Control-Allow-Origin', value: '*' };
  if (assets.wanted(request.url)) {
    if (request.method === 'OPTIONS') return ok('Fetch.fulfillRequest', { responseCode: 204, responseHeaders: [acao, { name: 'Access-Control-Allow-Headers', value: '*' }] });
    const a = (LOGIN_MODE === 'local' || Date.now() < cloudDownUntil) ? assets.lookup(request.url) : null;
    if (a) {
      return ok('Fetch.fulfillRequest', { responseCode: 200, body: fs.readFileSync(a.file).toString('base64'),
        responseHeaders: [{ name: 'Content-Type', value: a.type || 'application/octet-stream' }, acao, { name: 'Cache-Control', value: 'max-age=3600' }] });
    }
    if (LOGIN_MODE === 'local') {   // never fall through to the network
      const k = Assets.key(request.url);
      if (!loggedHosts.has(k)) { loggedHosts.add(k); log(`local mode: picture not saved — ${k}`); }
      return ok('Fetch.fulfillRequest', { responseCode: 404, responseHeaders: [acao] });
    }
    return ok('Fetch.continueRequest');
  }
  if (LOGIN_MODE === 'local' && NET_BLOCK && !isLocalHost(u.hostname)) {
    if (!loggedHosts.has(u.host)) { loggedHosts.add(u.host); log(`local mode: blocked a request to ${u.host} (nothing leaves your computer; LOCAL_BLOCK_NET=0 turns this off)`); }
    return ok('Fetch.failRequest', { errorReason: 'BlockedByClient' });
  }
  return ok('Fetch.continueRequest');
}

/** runs in the game page: passes the level numbers of each socket push to the mod (the game still gets them) */
const LEVEL_HOOK = `(() => { if (window.__moliliLevelHook) return; window.__moliliLevelHook = true;
  const log = console.log;
  console.log = function (...a) {
    try { if (a[0] === 'socket_number_msg' && a[1] && typeof a[1] === 'object' && typeof window.moliliLevelSeen === 'function')
      window.moliliLevelSeen(JSON.stringify({ level: a[1].level, nextLevelFavor: a[1].nextLevelFavor })); } catch (e) { /* never break the game */ }
    return log.apply(this, a);
  };
})();`;

async function attach(cdp, info, sessionId) {
  if (info.type !== 'page') return;
  const patterns = (LOGIN_MODE === 'local' && NET_BLOCK) ? ['*']          // local mode: see every request so none can reach the internet
    : ['http://api.molili.net/*', 'https://api.molili.net/*', ...ASSET_HOSTS.flatMap(h => [`http://${h}/*`, `https://${h}/*`])];
  await cdp.send('Fetch.enable', { patterns: patterns.map(urlPattern => ({ urlPattern, requestStage: 'Request' })) }, sessionId);
  try {
    await cdp.send('Runtime.addBinding', { name: 'moliliLevelSeen' }, sessionId);
    await cdp.send('Runtime.evaluate', { expression: LEVEL_HOOK }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LEVEL_HOOK }, sessionId);
  } catch (e) { log('level hook not installed:', e.message); }
  log('hooked window:', info.url.slice(0, 70) || info.title || '(untitled)');
}

async function run() {
  log(CFG.file ? `settings: ${CONFIG_FILE} loaded` : `settings: no ${CONFIG_FILE} — built-in defaults (create one next to this script to change them)`);
  for (const p of CONFIG_PROBLEMS) log(`WARNING: ${p}`);
  if (DIARY_ORDER_RAW !== DIARY_ORDER) log(`WARNING: DIARY_ORDER="${DIARY_ORDER_RAW}" must be "asc" or "desc" — using "asc"`);
  log(`diary: entries shown ${DIARY_ORDER === 'desc' ? 'newest first (desc)' : 'oldest first (asc, as the server sends them)'} (${SOURCE.get('DIARY_ORDER')})`);
  await startLocalServer();
  if (imported) log(`capture: converted ${imported} saved answer(s) so they can be replayed offline`);
  seedAccountFromCapture();
  log(`history: ${HISTORY_FILE || '(memory only)'} — ${store.records.length} saved messages`);
  log(`levels: ${levels.count} level threshold(s) recorded in ${path.basename(LEVELS_FILE)}`);
  log(`persona: ${fs.existsSync(PERSONA_FILE) ? PERSONA_FILE : '(built-in default — create persona.txt to customize)'}`);
  log(`account: ${ACCOUNT_FILE ? (account.exists ? ACCOUNT_FILE : '(no account.json yet — it is created from the server or at first local login)') : '(memory only)'}`
    + ` — profile ${account.hasProfile ? 'saved' : 'none'}, session ${account.state.session.loggedIn ? 'logged in' : 'logged out'}, mode ${LOGIN_MODE} (from ${MODE_SOURCE})`);
  if (MODE_RAW && !MODES.includes(MODE_ENV)) log(`WARNING: LOGIN_MODE="${MODE_RAW}" is not one of auto, local, cloud — ignored`);
  if (LOGIN_MODE === 'local') log('account: LOCAL mode — account.json is never overwritten from the server');
  else if (account.state.autoSync !== false) log('account: account.json WILL be updated from the server while it is reachable (set LOGIN_MODE=local, or "autoSync": false in account.json, to stop that)');
  const SEED_FILE = env('SEED_FILE', path.join(HERE, 'store.json'));
  if (!account.hasProfile && fs.existsSync(SEED_FILE)) {
    try {
      const name = account.seedFromStore(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
      if (name !== null) log(`account: imported profile "${name}" and settings from ${path.basename(SEED_FILE)} (the login token is not copied)`);
    } catch (e) { log(`account: could not import ${path.basename(SEED_FILE)}: ${e.message}`); }
  }
  log(`gateway: ${GATEWAY || LOGIN_MODE === 'local' ? 'on' : 'off'}, recording ${RECORD && LOGIN_MODE !== 'local' ? 'to ' + CAPTURE_DIR : 'off'}`
    + ` — ${capture.requestCount} saved requests, ${assets.count} saved files, crawl ${LOGIN_MODE === 'local' ? 'off' : CRAWL}`);
  if (LOGIN_MODE === 'local') {
    log(`local mode: every answer comes from your files (capture/, account.json, chat-history.jsonl${diaryOn() ? ', diary-local.json' : ''}); the server is never contacted`
      + (NET_BLOCK ? ' and requests to other hosts are blocked' : ''));
    if (!GATEWAY) log('local mode: GATEWAY=0 is ignored (the gateway is needed to keep the server out)');
  }
  log(LOGIN_MODE === 'local' || CRAWL === '0' ? 'crawl: off' : 'crawl: will save the diary, store and panels once the game is logged in and the server answers');
  log(diaryOn() ? `diary: daily entry ON — ${diary.count} written locally (${DIARY_FILE}); today's is written once LM Studio answers`
    : `diary: daily entry off (${DIARY_MODE === '0' ? 'DIARY=0' : 'it is written in local mode, or with DIARY=1'})`);
  let version;
  for (let i = 0; ; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; }
    catch { if (i === 0) log(`waiting for Molili's WebView2 on port ${CDP_PORT} ...`); await new Promise(r => setTimeout(r, 1000)); }
  }
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.ready;
  cdp.on(msg => {
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      attach(cdp, targetInfo, sessionId).catch(e => log('attach error:', e.message));
      cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    } else if (msg.method === 'Runtime.bindingCalled' && msg.params?.name === 'moliliLevelSeen') {
      try { const p = JSON.parse(msg.params.payload); levels.record(p.level, p.nextLevelFavor, 'socket'); } catch { /* not a level push */ }
    } else if (msg.method === 'Fetch.requestPaused') {
      onPaused(cdp, msg).catch(e => log('handler error:', e.message));
    }
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos.filter(t => t.type === 'page')) cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
  log(`ready. Chat -> ${LM_URL}  (${STREAM ? 'streaming' : 'non-streaming'})`);
  setTimeout(() => diaryTick().catch(e => log('diary error:', e.message)), Number(env('DIARY_DELAY_MS', 15000)));
  setInterval(() => diaryTick().catch(e => log('diary error:', e.message)), 5 * 60_000);   // also catches the day changing while the game stays open
  await cdp.closed;
  log('Molili closed — exiting.');
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
