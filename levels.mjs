/**
 * levels.mjs — passive record of how much affinity each level needs (levels.json).
 *
 * Whenever the server tells the game its level and nextLevelFavor (the overview, the affection info, or the socket
 * push when you level up), the pair is saved: "level 7 needs 65 to reach level 8". Nothing is guessed.
 * Each level is saved once, from the first answer seen; a different later value is reported, not overwritten.
 */
import fs from 'node:fs';

export class LevelLog {
  constructor(file, log = console.log) {
    this.file = file; this.log = log; this.map = {};
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.levels === 'object') this.map = j.levels; } catch { /* first run */ }
  }
  get count() { return Object.keys(this.map).length; }
  #save() {
    if (!this.file) return;
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ levels: this.map }, null, 2) + '\n'); fs.renameSync(tmp, this.file); }
    catch (e) { this.log('levels: could not save:', e.message); }
  }
  /** returns true when a new level was saved */
  record(level, nextLevelFavor, source) {
    const lv = Number(level), need = Number(nextLevelFavor);
    if (!Number.isInteger(lv) || lv < 1 || !Number.isInteger(need) || need <= 0) return false;
    const prev = this.map[lv];
    if (prev) {
      if (prev.nextLevelFavor !== need) this.log(`levels: level ${lv} was saved as ${prev.nextLevelFavor}, now ${need} (${source}) — the first value is kept`);
      return false;
    }
    this.map[lv] = { nextLevelFavor: need, source, seen: new Date().toISOString() };
    this.#save();
    this.log(`levels: level ${lv} needs ${need} to reach level ${lv + 1} (${source})`);
    return true;
  }
}

/**
 * Where the affinity-to-next-level number comes from when the server is not answering.
 * Order: a value recorded from the server (levels.json) > levels-table.json (screenshots, Steam guide, estimates).
 * Returns (level) => { nextLevelFavor, source } or null.
 */
export function levelNeeder(tableFile, recorded = () => ({})) {
  let table = {};
  try { table = JSON.parse(fs.readFileSync(tableFile, 'utf8')).levels || {}; } catch { /* no table: recorded values only */ }
  return level => {
    const r = recorded()[level];
    if (r && Number.isFinite(Number(r.nextLevelFavor))) return { nextLevelFavor: Number(r.nextLevelFavor), source: 'recorded' };
    const t = table[level];
    return t && Number.isFinite(Number(t.nextLevelFavor)) ? { nextLevelFavor: Number(t.nextLevelFavor), source: t.source || 'table' } : null;
  };
}

/**
 * Carry affinity over level-ups.
 * level / favor: the saved level and its progress; need: the saved nextLevelFavor for that level;
 * needOf(level) -> { nextLevelFavor } | null. Returns { level, levelFavor, nextLevelFavor, levelUps }.
 * If the table ends, progress stops one point short of the last known level.
 */
export function advanceLevel(level, favor, need, needOf) {
  let lv = level, f = favor, n = need, ups = 0;
  while (Number.isFinite(n) && n > 0 && f >= n) {
    const nx = needOf(lv + 1);
    if (!nx) return { level: lv, levelFavor: Math.max(0, n - 1), nextLevelFavor: n, levelUps: ups };
    f -= n; lv += 1; ups += 1;
    n = nx.nextLevelFavor;
  }
  return { level: lv, levelFavor: Math.max(0, f), nextLevelFavor: n, levelUps: ups };
}
