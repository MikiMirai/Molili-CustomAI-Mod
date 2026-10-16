// favorites.mjs — the game's Favorites (collected messages).
// Three sources, in this order:
//   1. the server's list while the server is reachable (passed through; the favorites made here are added on top of page 1)
//   2. the server's copy saved in capture/ (offline, local mode)
//   3. favorites made here while the server was down (favorites.json)
// Favorites made here are never sent to the server. Favorites from the server can only be changed while it is reachable.
import fs from 'node:fs';

const ok = data => ({ status: 200, json: { success: true, code: 0, errCode: null, errMessage: null, data } });
const notHere = () => ({ status: 400, json: { success: false, code: 400, errCode: 'SERVER_ONLY', errMessage: 'This favorite is on the server. It can be changed when the server is reachable.', data: null } });
const PAGE_MAX = 50;
const byNewest = (a, b) => String(b.createTime ?? '').localeCompare(String(a.createTime ?? ''));

export class Favorites {
  /**
   * wire(record): the game's message shape; find(msgId): the saved message record;
   * saved(): the server's favorites saved in capture/ (records as the server sends them)
   */
  constructor(file, log, { wire, find, saved = () => [] }) {
    this.file = file; this.log = log; this.wire = wire; this.find = find; this.saved = saved; this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')).items || []; } catch { /* first run */ }
  }
  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ items: this.items }, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
    catch (e) { this.log('favorites: could not save —', e.message); }
  }
  /** the favorite that holds this message (made here or saved from the server), or undefined */
  favoriteOf(msgId) {
    if (!msgId) return undefined;
    return this.items.find(i => i.msgIds.includes(msgId))
      || this.saved().find(f => (f.dialogs || []).some(d => d.msgId === msgId));
  }

  answer(ep, body = {}) {
    if (ep.endsWith('favoriteApi/v1/add')) return this.add(body.msgIds || []);
    if (ep.endsWith('favoriteApi/v1/remove') || ep.endsWith('favoriteApi/v1/cancelTop') || ep.endsWith('favoriteApi/v1/top')) {
      const hit = this.match(body);
      if (!hit) return ok(null);
      if (!this.items.includes(hit)) return notHere();
      if (ep.endsWith('favoriteApi/v1/remove')) this.items = this.items.filter(i => i !== hit);
      else hit.topped = ep.endsWith('favoriteApi/v1/top');
      this.save(); return ok(null);
    }
    if (ep.endsWith('favoriteApi/v1/list')) return this.list(body);
    return null;
  }

  match(body) {
    const all = [...this.items, ...this.saved()];
    if (body.favoriteId) { const i = all.find(x => x.favoriteId === body.favoriteId); if (i) return i; }
    return (body.msgIds || []).map(id => this.favoriteOf(id)).find(Boolean);
  }

  add(msgIds) {
    const recs = msgIds.map(id => this.find(id)).filter(Boolean);
    if (!recs.length) return ok(null);                  // the message is not saved here: nothing to collect
    if (this.favoriteOf(recs[0].msgId)) return ok(null); // already collected
    const title = String(recs[0].content || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Favorite';
    this.items.push({
      favoriteId: `local-f${Date.now()}`, title, topped: false, createTime: new Date().toISOString(),
      msgIds: recs.map(r => r.msgId), dialogs: recs.map(r => this.wire(r)),
    });
    this.save(); this.log(`favorites: collected "${title}"`);
    return ok(null);
  }

  /** every favorite this copy knows: made here first, then the saved server ones it does not repeat */
  all() {
    const here = this.items;
    const ids = new Set(here.map(i => i.favoriteId));
    return [...here, ...this.saved().filter(f => !ids.has(f.favoriteId))].sort(byNewest);
  }

  list(body) {
    const size = Math.min(Math.max(Number(body.pageSize) || 10, 1), PAGE_MAX);
    const current = Math.max(Number(body.pageIndex) || 1, 1);
    const sorted = this.all();
    const records = sorted.slice((current - 1) * size, current * size);
    return ok({ records, total: sorted.length, size, current, pages: Math.ceil(sorted.length / size), empty: records.length === 0, notEmpty: records.length > 0 });
  }

  /** the server's page, with the favorites made here shown first on page 1 (page numbers and the rest stay the server's) */
  mergeCloud(body, parsed) {
    const data = parsed?.data;
    if (!data || !Array.isArray(data.records) || !this.items.length) return null;
    const ids = new Set(data.records.map(r => r.favoriteId));
    const here = this.items.filter(i => !ids.has(i.favoriteId)).sort(byNewest);
    if (!here.length) return null;
    const page = Math.max(1, Number(body.pageIndex) || 1);
    return { ...parsed, data: { ...data, total: (Number(data.total) || 0) + here.length,
      records: page === 1 ? [...here, ...data.records] : data.records } };
  }
}
