/**
 * diary.mjs — the local daily diary.
 *
 *   diary-local.json   { version, entries: [{ date:"YYYY-MM-DD", createTime, content, favorIncrease, itemList }] }
 *
 * One entry per calendar day (your computer's date). The text is written by your local model in the character's voice:
 * what she did in her free time, plus what you two talked about the day before. The file is plain JSON you can edit
 * while Molili is closed (delete a day's entry to have it written again). Saves are atomic, with a .bak copy.
 * The entries are shown by the game's own diary page in the same format as the server's records.
 */
import fs from 'node:fs';
import path from 'node:path';

const pad = n => String(n).padStart(2, '0');
/** local calendar date of a timestamp, "YYYY-MM-DD" */
export const localDate = (ms = Date.now()) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** the local date `n` days before `ms` (DST-safe: moves the calendar, not 24 h blocks) */
export const daysAgo = (n, ms = Date.now()) => { const d = new Date(ms); d.setDate(d.getDate() - n); return localDate(d.getTime()); };
/** [start, end) in ms of a local calendar day */
export function dayRange(date) {
  const [y, m, d] = date.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}
const isoNoMs = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class LocalDiary {
  constructor(file, log = console.log) {
    this.file = file; this.log = log; this.entries = [];
    if (!file || !fs.existsSync(file)) return;   // no file = start fresh; a leftover .bak is NOT restored (deleting the file means "start over")
    for (const f of [file, file + '.bak']) {
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        this.entries = (Array.isArray(j.entries) ? j.entries : []).filter(e => e && typeof e.content === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date));
        if (f !== file) log(`diary: ${path.basename(file)} was unreadable — restored from ${path.basename(f)}`);
        return;
      } catch (e) {
        if (f === file) { try { fs.renameSync(f, `${file}.corrupt-${Date.now()}`); log(`diary: ${path.basename(f)} is damaged (${e.message}); kept a copy and started a new one`); } catch { /* ignore */ } }
      }
    }
  }
  get count() { return this.entries.length; }
  has(date) { return this.entries.some(e => e.date === date); }
  /** the newest day that has an entry, or null */
  get latest() { return this.entries.length ? this.entries[this.entries.length - 1].date : null; }
  /** add the entry for `date`; createTime is "now" for today, 21:00 local for an earlier day */
  add(date, content) {
    const [y, m, d] = date.split('-').map(Number);
    const created = date === localDate() ? Date.now() : new Date(y, m - 1, d, 21, 0, 0).getTime();
    const e = { date, createTime: isoNoMs(created), content, favorIncrease: 0, itemList: [] };
    this.entries = this.entries.filter(x => x.date !== date).concat(e).sort((a, b) => a.date.localeCompare(b.date));
    this.#save();
    return e;
  }
  #save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 2) + '\n');
      if (fs.existsSync(this.file)) { try { fs.copyFileSync(this.file, this.file + '.bak'); } catch { /* ignore */ } }
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('diary: could not save:', e.message); }
  }
  /** the entries as the server's diary records (what the game's diary page reads) */
  records() { return this.entries.map(({ createTime, content, favorIncrease, itemList }) => ({ createTime, content, favorIncrease: favorIncrease ?? 0, itemList: itemList ?? [] })); }
}

/** "You: ... / Me: ..." for the chat of one day (history records have role, content, ts) */
export function chatDigest(records, date, { maxChars = 5000, maxMsg = 280 } = {}) {
  const [a, b] = dayRange(date);
  const lines = [];
  for (const r of records) {
    if ((r.role !== 'user' && r.role !== 'assistant') || !(r.ts >= a && r.ts < b)) continue;
    const who = r.role === 'user' ? 'You' : 'Me', text = String(r.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const last = lines[lines.length - 1];
    if (last && last.who === who) last.text += ' ' + text; else lines.push({ who, text });
  }
  let out = lines.map(l => `${l.who}: ${l.text.length > maxMsg ? l.text.slice(0, maxMsg) + '…' : l.text}`);
  let total = out.join('\n').length;
  while (total > maxChars && out.length > 4) { const i = Math.floor(out.length / 2); total -= out[i].length + 1; out.splice(i, 1); out[i - 1] += ' […]'; } // drop the middle, keep start and end
  return { text: out.join('\n'), turns: lines.length };
}

/** chat messages for the model */
export function diaryMessages({ persona, characterName, userName, date, digest, yesterday, recent }) {
  const label = new Date(...date.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const you = userName || 'the person you chat with';
  const sys = `${persona}

You are now writing your private diary${characterName ? ` (your name is ${characterName})` : ''}, in your own voice, in the first person.
Write the entry for ${label}. ${userName ? userName : 'The person you chat with'} may read it later.
Rules:
- 120 to 220 words, 3 to 5 short paragraphs of plain text. No title, no date line, no markdown, no lists, no mood tags in square brackets.
- Say what you did in your free time today: invent two or three small, concrete, in-character things (a hobby, a little adventure, a chore, a daydream, a snack, the weather). Keep them consistent with your world and with your earlier entries. No big story-changing events.
- If a conversation from yesterday is given, say what you two really talked about: the actual topics, moods and promises, in your own words. Never invent anything about that conversation and do not quote it at length.
- If there was no conversation yesterday, say you missed ${you} or wondered what they were up to.
- Write in the same language as your earlier entries or the conversation; English if there is neither.
Reply with the diary text only.`;
  const earlier = recent.length
    ? 'Your earlier diary entries, newest first (for voice and continuity only; do not repeat them):\n' + recent.map(t => `---\n${t.length > 700 ? t.slice(0, 700) + '…' : t}`).join('\n') + '\n\n'
    : '';
  const chat = digest ? `Yesterday's conversation (${yesterday}); "You" is ${you}, "Me" is you:\n${digest}` : `There was no conversation yesterday (${yesterday}).`;
  return [{ role: 'system', content: sys }, { role: 'user', content: `${earlier}${chat}\n\nNow write the diary entry for ${label}.` }];
}

/** tidy the model's answer; throws when it is not a usable entry */
export function cleanDiary(raw) {
  let t = String(raw ?? '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```\w*\n?|\n?```\s*$/g, '').replace(/\[(?:EX_[A-Z_]+|DEFAULT)\]/g, '');
  t = t.replace(/\*\*|__/g, '').replace(/^#{1,6}\s+/gm, '').replace(/^\s*(?:date|dear diary)\s*[:,].*\n/i, '').trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  if (t.length < 200) throw new Error(`the model's diary text was too short (${t.length} characters)`);
  return t.length > 3000 ? t.slice(0, 3000).replace(/\s+\S*$/, '…') : t;
}
