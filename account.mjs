/**
 * account.mjs — a local stand-in for Molili's login / user / settings backend, backed by one JSON file.
 *
 * account.json layout (all values are plain data you can read and edit while Molili is CLOSED):
 *   version      schema version
 *   autoSync     true  = while the real server is reachable, keep this file updated from its responses
 *                false = never overwrite this file from the server (freeze it)
 *   login        { acceptAnyCode: true, code: "000000" }   how the local e-mail login checks the 6-digit code
 *   session      { loggedIn, method, lastLoginAt }          whether the game should start logged in
 *   userInfo     the profile object returned by getUserInfo / login
 *   settings     { configs: { <key>: { propKey, propVal } } }   returned by getSettingsConfig
 *   meta         { createdAt, updatedAt, source }
 *
 * Saving is crash-safe: write to a temp file, keep the previous version as <file>.bak, then rename.
 * Loading falls back to <file>.bak, and a file that can't be parsed is set aside, never deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const DEFAULT_CONFIGS = {
  agentId: 'local-agent', lang: 'en', enableTts: false, enableFollowUp: false, ttsLang: '', textLang: '',
};

const nowIso = () => new Date().toISOString();
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function defaults() {
  const configs = {};
  for (const [k, v] of Object.entries(DEFAULT_CONFIGS)) configs[k] = { propKey: k, propVal: v };
  return {
    version: VERSION, autoSync: true,
    login: { acceptAnyCode: true, code: '000000' },
    session: { loggedIn: false, method: null, lastLoginAt: null },
    userInfo: {},
    settings: { configs },
    meta: { createdAt: nowIso(), updatedAt: nowIso(), source: 'local' },
  };
}

/** make any parsed JSON safe to use: right types, defaults for what is missing, unknown fields kept */
function normalize(raw) {
  const d = defaults();
  if (!isObj(raw)) return d;
  const out = { ...raw };
  out.version = VERSION;
  out.autoSync = raw.autoSync !== false;
  out.login = { ...d.login, ...(isObj(raw.login) ? raw.login : {}) };
  out.login.acceptAnyCode = out.login.acceptAnyCode !== false;
  out.login.code = String(out.login.code ?? '000000');
  out.session = { ...d.session, ...(isObj(raw.session) ? raw.session : {}) };
  out.session.loggedIn = out.session.loggedIn === true;
  out.userInfo = isObj(raw.userInfo) ? raw.userInfo : {};
  const configs = isObj(raw.settings?.configs) ? raw.settings.configs : {};
  out.settings = { ...(isObj(raw.settings) ? raw.settings : {}), configs: { ...d.settings.configs, ...configs } };
  out.meta = { ...d.meta, ...(isObj(raw.meta) ? raw.meta : {}) };
  return out;
}

const ENVELOPE = { success: true, code: 0, errCode: null, errMessage: null };
const ok = data => ({ status: 200, json: { ...ENVELOPE, data } });
const fail = (status, errCode, errMessage) => ({ status, json: { success: false, code: status, errCode, errMessage, data: null } });

export class Account {
  constructor(file, log = console.log) {
    this.file = file; this.log = log; this.loadedFrom = null;
    this.state = this.#load();
  }

  /* ----------------------------------------------------------- persistence */
  #read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  #load() {
    if (!this.file) return defaults();
    for (const f of [this.file, this.file + '.bak']) {
      if (!fs.existsSync(f)) continue;
      try {
        const s = normalize(this.#read(f));
        this.loadedFrom = f;
        if (f !== this.file) this.log(`account: ${path.basename(this.file)} was unreadable — restored from ${path.basename(f)}`);
        return s;
      } catch (e) {
        if (f === this.file) {
          const aside = `${this.file}.corrupt-${Date.now()}`;
          try { fs.renameSync(f, aside); this.log(`account: ${path.basename(f)} is damaged (${e.message}); kept a copy as ${path.basename(aside)}`); } catch { /* ignore */ }
        }
      }
    }
    return defaults();
  }
  save() {
    if (!this.file) return;
    this.state.meta.updatedAt = nowIso();
    const tmp = this.file + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeFileSync(fd, JSON.stringify(this.state, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(this.file)) { try { fs.copyFileSync(this.file, this.file + '.bak'); } catch { /* ignore */ } }
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('account: could not save:', e.message); }
  }
  get exists() { return !!this.file && fs.existsSync(this.file); }
  get hasProfile() { return Object.keys(this.state.userInfo).length > 0; }

  /* --------------------------------------------------- which endpoints we own */
  static ep(pathname) { const m = pathname.match(/([A-Za-z]+Api\/v1\/.*)$/); return m ? m[1] : pathname; }
  static OWNED = new Set([
    'loginApi/v1/sendCode', 'loginApi/v1/loginByCode', 'loginApi/v1/steamLogin', 'loginApi/v1/logout',
    'loginApi/v1/bindEmail', 'loginApi/v1/unbindEmail', 'loginApi/v1/bindSteam', 'loginApi/v1/unbindSteam',
    'userInfoApi/v1/getUserInfo', 'userInfoApi/v1/updateUserInfo', 'userInfoApi/v1/cancelUser', 'userInfoApi/v1/restoreUser',
    'userSettingsApi/v1/getSettingsConfig', 'userSettingsApi/v1/updateSettingsConfig',
  ]);
  owns(pathname) { return Account.OWNED.has(Account.ep(pathname)); }

  /* ------------------------------------------------------- local handlers */
  #startSession(method, extra = {}) {
    const s = this.state;
    s.session = { loggedIn: true, method, lastLoginAt: nowIso() };
    s.userInfo = { ...s.userInfo, ...extra };
    if (!s.userInfo.userId) s.userInfo.userId = String(10_000_000 + crypto.randomInt(0, 89_999_999));
    this.save();
  }
  #loginResult(firstLogin) {
    const token = 'local-' + crypto.randomUUID();
    return ok({ token, firstLogin, coolDownSeconds: null, ...this.state.userInfo });
  }

  /** returns {status, json} or null when this endpoint is not ours */
  handle(pathname, body = {}) {
    const ep = Account.ep(pathname), s = this.state;
    switch (ep) {
      case 'loginApi/v1/sendCode':
        this.log(s.login.acceptAnyCode ? 'login: local mode — type any 6 digits as the code' : `login: local mode — the code is ${s.login.code}`);
        return ok(null);

      case 'loginApi/v1/loginByCode': {
        const email = String(body.email || '').trim();
        if (!email) return fail(400, 'BAD_REQUEST', 'Email is required');
        if (!s.login.acceptAnyCode && String(body.code) !== s.login.code) return fail(400, 'CODE_ERROR', 'Wrong code');
        const first = !this.hasProfile || s.userInfo.profileDone !== true && !s.userInfo.username && !s.userInfo.nickname;
        if (s.userInfo.email && s.userInfo.email !== email) this.log(`login: e-mail changed (${s.userInfo.email} -> ${email}); keeping the same local profile`);
        this.#startSession('email', { email, ...(body.steamId ? { steamId: String(body.steamId) } : {}) });
        this.log(`login: ${email} signed in locally${first ? ' (new profile)' : ''}`);
        return this.#loginResult(first);
      }
      case 'loginApi/v1/steamLogin': {
        const first = !this.hasProfile || s.userInfo.profileDone !== true && !s.userInfo.username && !s.userInfo.nickname;
        const extra = {};
        if (body.steamId) extra.steamId = String(body.steamId);
        if (body.steamUserName && !s.userInfo.username) extra.username = String(body.steamUserName);
        this.#startSession('steam', extra);
        this.log(`login: steam sign-in handled locally${first ? ' (new profile)' : ''}`);
        return this.#loginResult(first);
      }
      case 'loginApi/v1/logout':
        s.session.loggedIn = false; this.save(); this.log('login: signed out (profile kept)');
        return ok(null);

      case 'userInfoApi/v1/getUserInfo':
        if (!s.session.loggedIn || !this.hasProfile) return fail(401, 'UNAUTHORIZED', 'Not logged in');
        return ok({ ...s.userInfo });
      case 'userInfoApi/v1/updateUserInfo': {
        const { timestamp, ...rest } = body || {};
        s.userInfo = { ...s.userInfo, ...rest, profileDone: true }; this.save();
        return ok(null);
      }
      case 'userInfoApi/v1/restoreUser': return ok(null);
      case 'userInfoApi/v1/cancelUser':
        this.log('login: "delete account" ignored in local mode (nothing is deleted)');
        return ok(null);

      case 'loginApi/v1/bindEmail': if (body.email) { s.userInfo.email = String(body.email); this.save(); } return ok(null);
      case 'loginApi/v1/unbindEmail': return ok(null);
      case 'loginApi/v1/bindSteam': if (body.steamId) { s.userInfo.steamId = String(body.steamId); this.save(); } return ok(null);
      case 'loginApi/v1/unbindSteam': return ok(null);

      case 'userSettingsApi/v1/getSettingsConfig':
        return ok({ ...s.settings, configs: { ...s.settings.configs } });
      case 'userSettingsApi/v1/updateSettingsConfig':
        if (body.propKey) { s.settings.configs[body.propKey] = { ...(s.settings.configs[body.propKey] || {}), propKey: body.propKey, propVal: body.propVal }; this.save(); }
        return ok(null);
      default: return null;
    }
  }

  /** one-time import from the game's own settings store (store.json): profile + settings. Never the login token. */
  seedFromStore(store) {
    const ui = store?.userInfo, us = store?.userSetting;
    if (!isObj(ui) || !ui.userId) return null;
    const s = this.state;
    s.userInfo = {
      userId: String(ui.userId), username: ui.username ?? '', birthday: ui.birthday ?? '', gender: ui.gender ?? 0,
      email: ui.email ?? '', steamId: ui.steamId ?? null, steamUserName: ui.steamUserName ?? null, profileDone: true,
    };
    for (const [k, v] of Object.entries(isObj(us?.configs) ? us.configs : {})) {
      if (isObj(v) && 'propVal' in v) s.settings.configs[k] = { propKey: k, propVal: v.propVal };
    }
    s.session = { loggedIn: true, method: 'email', lastLoginAt: nowIso() };
    s.meta = { ...s.meta, source: 'imported from store.json' };
    this.save();
    return s.userInfo.username || '(no name)';
  }

  /* ----------------------------------------- snapshot from the real server */
  /** called with every successful response from the cloud; returns a short note when the file changed */
  mirror(pathname, reqBody, status, res) {
    if (!this.state.autoSync || status !== 200 || !isObj(res)) return null;
    const ep = Account.ep(pathname), s = this.state; let note = null;
    const data = res.data;
    switch (ep) {
      case 'userInfoApi/v1/getUserInfo':
        if (isObj(data)) { s.userInfo = { ...data }; s.session.loggedIn = true; note = 'profile'; } break;
      case 'loginApi/v1/loginByCode':
      case 'loginApi/v1/steamLogin':
        if (isObj(data)) {
          const { token, firstLogin, coolDownSeconds, ...profile } = data;
          s.userInfo = { ...s.userInfo, ...profile };
          if (reqBody?.email) s.userInfo.email = s.userInfo.email || String(reqBody.email);
          s.session = { loggedIn: true, method: ep.endsWith('steamLogin') ? 'steam' : 'email', lastLoginAt: nowIso() };
          note = 'login';
        } break;
      case 'userSettingsApi/v1/getSettingsConfig':
        if (isObj(data) && isObj(data.configs)) { s.settings = { ...data }; note = 'settings'; } break;
      case 'userSettingsApi/v1/updateSettingsConfig':
        if (reqBody?.propKey) { s.settings.configs[reqBody.propKey] = { ...(s.settings.configs[reqBody.propKey] || {}), propKey: reqBody.propKey, propVal: reqBody.propVal }; note = 'settings'; } break;
      case 'loginApi/v1/logout':
        s.session.loggedIn = false; note = 'logout'; break;
      default: return null;
    }
    if (note) { s.meta.source = 'cloud-snapshot'; this.save(); }
    return note;
  }
}
