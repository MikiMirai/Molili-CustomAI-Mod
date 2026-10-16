// favorites.mjs — the game's Favorites (collected messages), kept in favorites.json so they work offline.
// Calls handled: favoriteApi/v1/add, remove, top, cancelTop, list. The game identifies a favorite by its messages
// (msgIds) when it removes one, so removal works from either favoriteId or msgIds.
import fs from 'node:fs';

const ok = data => ({ status: 200, json: { success: true, code: 0, errCode: null, errMessage: null, data } });
const PAGE_MAX = 50;

export class Favorites {
  /** wire(record) gives the game's message shape; find(msgId) returns the saved message record or undefined */
  constructor(file, log, { wire, find }) {
    this.file = file; this.log = log; this.wire = wire; this.find = find; this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')).items || []; } catch { /* first run */ }
  }
  save() {
    if (!this.file) return;
    try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ items: this.items }, null, 2)); fs.renameSync(this.file + '.tmp', this.file); }
    catch (e) { this.log('favorites: could not save —', e.message); }
  }
  /** the favorite that holds this message, or undefined */
  favoriteOf(msgId) { return msgId ? this.items.find(i => i.msgIds.includes(msgId)) : undefined; }

  answer(ep, body = {}) {
    if (ep.endsWith('favoriteApi/v1/add')) return this.add(body.msgIds || []);
    if (ep.endsWith('favoriteApi/v1/remove') || ep.endsWith('favoriteApi/v1/cancelTop') || ep.endsWith('favoriteApi/v1/top')) {
      const item = this.match(body);
      if (!item) return ok(null);
      if (ep.endsWith('favoriteApi/v1/remove')) this.items = this.items.filter(i => i !== item);
      else item.topped = ep.endsWith('favoriteApi/v1/top');
      this.save(); return ok(null);
    }
    if (ep.endsWith('favoriteApi/v1/list')) return this.list(body);
    return null;
  }

  match(body) {
    if (body.favoriteId) { const i = this.items.find(x => x.favoriteId === body.favoriteId); if (i) return i; }
    return (body.msgIds || []).map(id => this.favoriteOf(id)).find(Boolean);
  }

  add(msgIds) {
    const recs = msgIds.map(id => this.find(id)).filter(Boolean);
    if (!recs.length) return ok(null);                 // the message is not saved here: nothing to collect
    if (this.favoriteOf(recs[0].msgId)) return ok(null); // already collected
    const first = recs[0];
    const title = String(first.content || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Favorite';
    this.items.push({
      favoriteId: `local-f${Date.now()}`, title, topped: false, createTime: new Date().toISOString(),
      msgIds: recs.map(r => r.msgId), dialogs: recs.map(r => this.wire(r)),
    });
    this.save(); this.log(`favorites: collected "${title}"`);
    return ok(null);
  }

  list(body) {
    const size = Math.min(Math.max(Number(body.pageSize) || 10, 1), PAGE_MAX);
    const current = Math.max(Number(body.pageIndex) || 1, 1);
    const sorted = [...this.items].sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
    const records = sorted.slice((current - 1) * size, current * size);
    return ok({ records, total: sorted.length, size, current, pages: Math.ceil(sorted.length / size), empty: records.length === 0, notEmpty: records.length > 0 });
  }
}
