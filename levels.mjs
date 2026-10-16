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
