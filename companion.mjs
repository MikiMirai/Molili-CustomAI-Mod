/**
 * companion.mjs — the Accompany timer (a "companion task") for local mode.
 *
 * Shapes follow the server's recorded answers:
 *   create  { agentId, companionStatus: REST|WORK|STUDY, secondsRemaining (the chosen length), timerType } -> success, no data
 *   cal     { agentId, secondsAccumulated, secondsRemaining }  (about once a minute)                        -> success, no data
 *   end     { agentId }                                                                                    -> success, no data
 *   query   { agentId }  -> data { companionStatus, secondsRemaining, secondsAccumulated, taskStatus: "ING" }
 *
 * Rewards (from the game's own numbers): a task earns floor(rate x seconds / 3600) per type, with a daily cap.
 *   WORK  60 stardust/hour, 120 a day   -> added to your stardust balance (shown in getUserAsset)
 *   STUDY 10 affinity/hour, 20 a day   -> counted in companion.json (affinity is not shown offline yet)
 *   REST  60 energy/hour, 120 a day     -> not credited locally (energy is not used offline)
 * The day starts at 04:00 local time (the game's "Daily Reset at 4:00").
 *
 * At zero the task finishes by itself (taskStatus "END"), as the game shows it. Our guess: the answer to query after
 * end is taskStatus "END". Spending stardust in the store still needs the server.
 * The end time is a clock time, so a task keeps counting down while the mod is closed.
 */
import fs from 'node:fs';

const STATUSES = new Set(['REST', 'WORK', 'STUDY']);
const MAX_SECONDS = 24 * 3600;
const RATES = { WORK: { perHour: 60, max: 120 }, STUDY: { perHour: 10, max: 20 } };
const DAY_START_HOUR = 4;
const env = data => ({ success: true, code: 0, errCode: null, errMessage: null, ...(data === undefined ? {} : { data }) });
const bad = (errMessage) => ({ status: 400, json: { success: false, code: 400, errCode: 'BAD_REQUEST', errMessage, data: null } });
const dayKey = now => { const d = new Date(now - DAY_START_HOUR * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export class Companion {
  constructor(file, log = console.log) {
    this.file = file; this.log = log;
    const j = this.#load() ?? {};
    this.s = j.s ?? null;                                           // the current task
    this.d = { day: null, WORK: 0, STUDY: 0, ...(j.d ?? {}) };      // what was earned today
    this.wallet = { stardust: 0, ...(j.wallet ?? {}) };             // stardust earned locally, on top of the saved balance
  }

  #load() {
    if (!this.file) return null;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return j && typeof j === 'object' ? j : null; }
    catch { return null; }
  }
  #save() {
    if (!this.file) return;
    try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ s: this.s, d: this.d, wallet: this.wallet }, null, 2) + '\n'); fs.renameSync(tmp, this.file); }
    catch (e) { this.log('companion: could not save:', e.message); }
  }
  #remaining(now = Date.now()) { return Math.max(0, Math.ceil(((this.s.endsAt ?? now) - now) / 1000)); }

  /** credit the rewards earned by the running task so far (called before anything changes the timer) */
  #settle(now = Date.now()) {
    const key = dayKey(now);
    if (this.d.day !== key) this.d = { day: key, WORK: 0, STUDY: 0 };
    const t = this.s, rate = t && t.taskStatus === 'ING' ? RATES[t.companionStatus] : null;
    if (!rate) return;
    const accum = Math.max(0, (t.planned || 0) - this.#remaining(now));
    const target = Math.min(rate.max, Math.floor(rate.perHour * accum / 3600));   // total for this task so far
    const due = target - (t.credited || 0);
    const give = Math.min(due, rate.max - this.d[t.companionStatus]);            // never above the daily cap
    if (give > 0) {
      this.d[t.companionStatus] += give;
      if (t.companionStatus === 'WORK') this.wallet.stardust += give;
      this.log(`companion: +${give} ${t.companionStatus === 'WORK' ? 'stardust' : 'affinity'} (today ${this.d[t.companionStatus]}/${rate.max})`);
    }
    t.credited = target;
    // at zero the game stops showing the task, so the task is finished here
    if (this.#remaining(now) === 0) {
      this.log(`companion: ${t.companionStatus} finished`);
      this.s = { agentId: t.agentId, timerType: t.timerType || 1, companionStatus: null, planned: 0, endsAt: null, taskStatus: 'END' };
      this.#save();
    }
  }

  /** the saved getUserAsset answer with what the offline tasks earned added */
  patchAsset(resp) {
    if (!resp?.data) return resp;
    this.#settle();
    const out = structuredClone(resp);
    const st = out.data.stardust;
    if (st && typeof st.balance === 'number') st.balance += this.wallet.stardust;
    for (const o of st?.obtainSourceList ?? []) if (o.code === 'companion_task_work' && o.variables) o.variables.companion_obtain_point = this.d.WORK;
    return out;
  }

  /** the answer for a companion request, or null when the request is not one of these */
  answer(ep, body = {}) {
    if (!ep.startsWith('userCompanionTaskApi/')) return null;
    const agentId = String(body?.agentId ?? this.s?.agentId ?? '1');
    switch (ep) {
      case 'userCompanionTaskApi/v1/create': {
        const secs = Math.round(Number(body?.secondsRemaining));
        if (!Number.isFinite(secs) || secs <= 0 || secs > MAX_SECONDS) return bad('Choose a time between 1 second and 24 hours.');
        const status = String(body?.companionStatus ?? '').toUpperCase();
        if (!STATUSES.has(status)) return bad('Unknown task type.');
        this.#settle();
        this.s = { agentId, timerType: Number(body?.timerType) || 1, companionStatus: status, planned: secs, endsAt: Date.now() + secs * 1000, taskStatus: 'ING', credited: 0 };
        this.#save();
        this.log(`companion: ${status} started for ${Math.round(secs / 60)} min`);
        return { status: 200, json: env(), how: 'local companion timer' };
      }
      case 'userCompanionTaskApi/v1/cal': {
        // the game reports the seconds it still has; keep the clock in step with it
        const r = Number(body?.secondsRemaining);
        if (this.s?.taskStatus === 'ING' && Number.isFinite(r) && r >= 0 && r <= (this.s.planned || 0)) {
          this.#settle(); this.s.endsAt = Date.now() + r * 1000; this.#save();
        }
        return { status: 200, json: env(), how: 'local companion timer' };
      }
      case 'userCompanionTaskApi/v1/end': {
        this.#settle();
        const was = this.s?.companionStatus;
        this.s = { agentId, timerType: this.s?.timerType || 1, companionStatus: null, planned: 0, endsAt: null, taskStatus: 'END' };
        this.#save();
        if (was) this.log(`companion: ${was} ended`);
        return { status: 200, json: env(), how: 'local companion timer' };
      }
      case 'userCompanionTaskApi/v1/query': {
        this.#settle();
        if (!this.s || this.s.taskStatus !== 'ING') {
          return { status: 200, json: env({ agentId, timerType: 1, companionStatus: null, secondsRemaining: 0, secondsAccumulated: 0, taskStatus: 'END' }), how: 'local companion timer' };
        }
        const remaining = this.#remaining();
        return { status: 200, json: env({ agentId, timerType: this.s.timerType || 1, companionStatus: this.s.companionStatus,
          secondsRemaining: remaining, secondsAccumulated: Math.max(0, (this.s.planned || 0) - remaining), taskStatus: 'ING' }), how: 'local companion timer' };
      }
      default: return null;   // list, pause, resume: see localapi.mjs
    }
  }
}
