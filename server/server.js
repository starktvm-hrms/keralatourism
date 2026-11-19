// Kerala Tourism social dashboard: a small Node server with no npm dependencies.
// Serves the page, signs people in, keeps the account list and follower history,
// and runs the Apify scrape on a schedule or on demand.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const { PLATFORMS, SCRAPED, normalize, urlFor, scrapers } = require('./apify');

const PORT = Number(process.env.PORT || 3107);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.SESSION_SECRET || '';
const PUBLIC = path.join(__dirname, '..', 'public');
const GROUPS = ['own', 'domestic', 'international'];
const SESSION_DAYS = 14;
const VERSION = Date.now().toString(36);
const RETRIES = Math.max(0, Math.min(5, Number(process.env.SCRAPE_RETRIES ?? 2))); // extra immediate attempts for handles that came back empty
if (SECRET.length < 32) { console.error('SESSION_SECRET (32+ chars) must be set'); process.exit(1); }

// ---------- passwords and sessions ----------
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeSession(email) {
  const v = Buffer.from(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return v + '.' + sign(v);
}
function readSession(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)kt_sess=([^;]+)/);
  if (!m) return null;
  const [v, s] = m[1].split('.');
  if (!v || !s) return null;
  const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const d = JSON.parse(Buffer.from(v, 'base64url').toString());
    if (d.x < Date.now()) return null;
    const users = store.read('users', []);
    return users.find((u) => u.email === d.e) ? d.e : null;
  } catch (e) { return null; }
}
const cookie = (val, maxAge) => `kt_sess=${val}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// login attempts per IP (in memory)
const attempts = new Map();
function tooMany(ip) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) return false;
  return a.n >= 8;
}
function failed(ip) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60e3 });
  else a.n++;
}

// ---------- accounts, snapshots, settings ----------
const today = () => new Date().toISOString().slice(0, 10);
const getSettings = () => ({ schedule: 'weekly', ...store.read('settings', {}) });

function cleanAccount(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? '').trim().slice(0, 80);
  const group = GROUPS.includes(body.group) ? body.group : existing.group;
  if (!name) throw new Error('Name is required');
  if (!group) throw new Error('Group must be own, domestic or international');
  const handles = {};
  for (const p of PLATFORMS) {
    const raw = body.handles && p in body.handles ? body.handles[p] : existing.handles?.[p];
    const h = normalize[p](raw || '');
    if (h && !/^[\w.@\/-]{1,120}$/.test(h)) throw new Error(`The ${p} username doesn't look right`);
    if (h) handles[p] = h;
  }
  // an account that only holds imported history may have no username at all
  const hasHistory = existing.id && store.read('snapshots', []).some((s) => s.a === existing.id);
  if (!Object.keys(handles).length && !hasHistory) throw new Error('Add at least one username');
  return { name, group, handles };
}

// ---------- scraping ----------
let running = null; // promise while a scrape runs

async function scrapeAll(trigger) {
  if (running) return running;
  running = (async () => {
    const accounts = store.read('accounts', []);
    const started = new Date().toISOString();
    const results = [];
    for (const p of SCRAPED) {
      const handles = [...new Set(accounts.map((a) => a.handles[p]).filter(Boolean))];
      if (!handles.length) continue;
      // First try every handle; then immediately retry only the ones that came back
      // without a count, up to RETRIES more times.
      const found = new Map(), errors = new Map(), tries = new Map();
      let pending = handles;
      for (let attempt = 0; attempt <= RETRIES && pending.length; attempt++) {
        if (attempt) console.log(`[scrape] ${p}: retrying ${pending.length} missing (${pending.join(', ')})`);
        let got = null, failure = null;
        try { got = await scrapers[p](pending); } catch (e) { failure = e.message; console.error(`[scrape] ${p}:`, e.message); }
        for (const h of pending) {
          tries.set(h, attempt + 1);
          const r = got && got.get(h);
          if (r && r.followers != null) { found.set(h, r); errors.delete(h); }
          else errors.set(h, failure || (r && r.error) || 'No result from Apify (check the username)');
        }
        pending = pending.filter((h) => !found.has(h));
      }
      const d = today();
      const snaps = store.read('snapshots', []);
      for (const a of accounts) {
        const h = a.handles[p];
        if (!h) continue;
        const r = found.get(h);
        if (r && r.followers != null) {
          const i = snaps.findIndex((s) => s.a === a.id && s.p === p && s.d === d);
          const row = { d, a: a.id, p, f: r.followers };
          if (i >= 0) snaps[i] = row; else snaps.push(row);
          results.push({ account: a.id, platform: p, followers: r.followers, name: r.name || '', tries: tries.get(h) });
        } else {
          const n = tries.get(h) || 1;
          results.push({ account: a.id, platform: p, error: errors.get(h) + (n > 1 ? ` (tried ${n} times)` : ''), tries: n });
        }
      }
      store.write('snapshots', snaps);
    }
    const run = { trigger, started, finished: new Date().toISOString(), results };
    store.write('lastRun', run);
    console.log(`[scrape] ${trigger}: ${results.filter((r) => !r.error).length} ok, ${results.filter((r) => r.error).length} failed`);
    return run;
  })().finally(() => { running = null; });
  return running;
}

// The schedule counts from when the server first ran, so a fresh install or newly
// added accounts never trigger an immediate fetch; use "Refresh now" for that.
if (!getSettings().lastScheduled) store.write('settings', { ...getSettings(), lastScheduled: new Date().toISOString() });

// Accounts listed in seed-accounts.json are added once (by type + name). One that
// was added before is never re-added, even if it was deleted in the dashboard.
(function importSeed() {
  let seed;
  try { seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-accounts.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[seed] unreadable:', e.message); return; }
  const settings = getSettings(), done = new Set(settings.seeded || []), doneH = new Set(settings.seededHandles || []);
  if (!settings.seededHandles) { // first run of username tracking: treat what earlier versions already handled as done
    for (const s of seed) {
      if (!done.has(String(s.group) + ':' + String(s.name).trim().toLowerCase())) continue;
      try { for (const [p, h] of Object.entries(cleanAccount(s).handles)) if (!(s.newHandles || []).includes(p)) doneH.add(`${s.group}:${String(s.name).trim().toLowerCase()}:${p}:${h}`); } catch (e) {}
    }
  }
  const accounts = store.read('accounts', []);
  const key = (g, n) => g + ':' + String(n).trim().toLowerCase();
  let added = 0;
  for (const s of seed) {
    const k = key(s.group, s.name);
    let clean;
    try { clean = cleanAccount(s); } catch (e) { console.error('[seed]', s.name, e.message); continue; }
    const existing = accounts.find((a) => key(a.group, a.name) === k);
    if (!done.has(k)) {
      done.add(k);
      if (!existing) {
        accounts.push({ id: crypto.randomBytes(6).toString('hex'), ...clean, created: new Date().toISOString() }); added++;
        for (const [p, h] of Object.entries(clean.handles)) doneH.add(`${k}:${p}:${h}`);
        continue;
      }
    } else if (!existing) continue; // deleted in the dashboard: leave it deleted
    // A username listed here for the first time is applied once: it fills an empty platform, or replaces
    // a username this list set earlier. A username typed in the dashboard is never overwritten.
    for (const [p, h] of Object.entries(clean.handles)) {
      const hk = `${k}:${p}:${h}`;
      if (doneH.has(hk)) continue;
      doneH.add(hk);
      const cur = existing.handles[p];
      if (!cur) { existing.handles[p] = h; added++; }
      else if (cur !== h && doneH.has(`${k}:${p}:${cur}`)) {
        existing.handles[p] = h; added++;
        // the old username's counts belong to a different profile: drop them
        const snaps = store.read('snapshots', []);
        const keep = snaps.filter((x) => !(x.a === existing.id && x.p === p && !x.m));
        if (keep.length !== snaps.length) { store.write('snapshots', keep); console.log(`[seed] ${s.name} ${p}: ${cur} -> ${h}, removed ${snaps.length - keep.length} old count(s)`); }
      }
    }
  }
  store.write('accounts', accounts);
  store.write('settings', { ...getSettings(), seeded: [...done], seededHandles: [...doneH] });
  if (added) console.log(`[seed] added ${added} account(s) or usernames`);
})();

// Follower history from earlier records (server/history/*.json) is loaded once per file id:
// values go to the named account (created without usernames if missing), flagged h:1.
// A day that already has a value is left alone, and nothing is re-added after a delete.
(function importHistory() {
  const dir = path.join(__dirname, 'history');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) { return; }
  const key = (g, n) => g + ':' + String(n).trim().toLowerCase();
  for (const f of files) {
    let h;
    try { h = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { console.error('[history]', f, e.message); continue; }
    const done = new Set(getSettings().historyImported || []);
    if (!h.id || done.has(h.id)) continue;
    const accounts = store.read('accounts', []), snaps = store.read('snapshots', []);
    const have = new Set(snaps.map((s) => `${s.a}|${s.p}|${s.d}`));
    let added = 0, created = 0;
    for (const acc of h.accounts || []) {
      if (!GROUPS.includes(acc.group) || !acc.name) continue;
      let a = accounts.find((x) => key(x.group, x.name) === key(acc.group, acc.name));
      if (!a) { a = { id: crypto.randomBytes(6).toString('hex'), name: String(acc.name).trim().slice(0, 80), group: acc.group, handles: {}, created: new Date().toISOString() }; accounts.push(a); created++; }
      for (const [p, rows] of Object.entries(acc.series || {})) {
        if (!PLATFORMS.includes(p) || !Array.isArray(rows)) continue;
        for (const [d, v] of rows) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || !Number.isFinite(v) || v < 0 || have.has(`${a.id}|${p}|${d}`)) continue;
          have.add(`${a.id}|${p}|${d}`); snaps.push({ d, a: a.id, p, f: Math.round(v), h: 1 }); added++;
        }
      }
    }
    snaps.sort((x, y) => x.d.localeCompare(y.d));
    store.write('accounts', accounts);
    store.write('snapshots', snaps);
    const s = getSettings();
    store.write('settings', { ...s, historyImported: [...done, h.id], history: [...(s.history || []), { id: h.id, source: h.source || f, at: new Date().toISOString() }] });
    console.log(`[history] ${f}: ${added} value(s) added, ${created} account(s) created`);
  }
})();

// schedule: checked every 30 minutes
function scheduleDue() {
  const s = getSettings();
  if (s.schedule === 'off') return false;
  const last = store.read('lastRun', null);
  const lastScheduled = s.lastScheduled ? Date.parse(s.lastScheduled) : 0;
  const every = s.schedule === 'daily' ? 864e5 : 7 * 864e5;
  return Date.now() - Math.max(lastScheduled, last ? Date.parse(last.started) : 0) >= every - 30 * 60e3;
}
setInterval(() => {
  if (running || !scheduleDue() || !store.read('accounts', []).length) return;
  store.write('settings', { ...getSettings(), lastScheduled: new Date().toISOString() });
  scrapeAll('schedule').catch((e) => console.error('[scrape] schedule', e));
}, 30 * 60e3).unref();

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const f = path.normalize(path.join(PUBLIC, rel));
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, 'Not found');
  const ext = path.extname(f);
  if (ext === '.html') { // stamp asset links with this server's start time, so a deploy is never mixed with cached files
    const html = fs.readFileSync(f, 'utf8').replace(/(src|href)="([\w.-]+\.(?:js|css))"/g, `$1="$2?v=${VERSION}"`);
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': TYPES[ext], 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(f).pipe(res);
}

function dataPayload() {
  const accounts = store.read('accounts', []);
  const ids = new Set(accounts.map((a) => a.id));
  return {
    accounts: accounts.map((a) => ({ ...a, urls: Object.fromEntries(Object.entries(a.handles).map(([p, h]) => [p, urlFor[p](h)])) })),
    snapshots: store.read('snapshots', []).filter((s) => ids.has(s.a)),
    settings: { schedule: getSettings().schedule, history: getSettings().history || [] },
    lastRun: store.read('lastRun', null),
    running: !!running,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress);

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, p);
  }

  // same-origin check for anything that changes state
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cross-site request refused' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (tooMany(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const { email = '', password = '' } = await readBody(req);
    const user = store.read('users', []).find((u) => u.email === String(email).trim().toLowerCase());
    if (!user || !checkPassword(String(password), user.hash)) { failed(ip); return send(res, 401, { error: 'Incorrect email or password.' }); }
    attempts.delete(ip);
    return send(res, 200, { email: user.email }, { 'Set-Cookie': cookie(makeSession(user.email), SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

  const email = readSession(req);
  if (!email) return send(res, 401, { error: 'Sign in required' });

  if (p === '/api/me') return send(res, 200, { email });
  if (p === '/api/data' && req.method === 'GET') return send(res, 200, dataPayload());

  if (p === '/api/accounts' && req.method === 'POST') {
    const body = await readBody(req);
    const accounts = store.read('accounts', []);
    if (accounts.length >= 60) return send(res, 400, { error: 'Account limit reached (60)' });
    const a = { id: crypto.randomBytes(6).toString('hex'), ...cleanAccount(body), created: new Date().toISOString() };
    accounts.push(a); store.write('accounts', accounts);
    return send(res, 200, dataPayload());
  }
  const m = p.match(/^\/api\/accounts\/([a-f0-9]{12})$/);
  if (m && req.method === 'PUT') {
    const body = await readBody(req);
    const accounts = store.read('accounts', []);
    const i = accounts.findIndex((a) => a.id === m[1]);
    if (i < 0) return send(res, 404, { error: 'Not found' });
    accounts[i] = { ...accounts[i], ...cleanAccount(body, accounts[i]) };
    store.write('accounts', accounts);
    return send(res, 200, dataPayload());
  }
  if (m && req.method === 'DELETE') {
    store.write('accounts', store.read('accounts', []).filter((a) => a.id !== m[1]));
    store.write('snapshots', store.read('snapshots', []).filter((s) => s.a !== m[1]));
    return send(res, 200, dataPayload());
  }
  // Enter a follower count by hand (when a fetch could not get it). One value per account,
  // platform and day; a later successful fetch for the same day replaces it.
  if (p === '/api/snapshots' && (req.method === 'POST' || req.method === 'DELETE')) {
    const { account, platform, date, followers } = await readBody(req);
    const a = store.read('accounts', []).find((x) => x.id === account);
    if (!a) return send(res, 404, { error: 'Account not found' });
    const onPlatform = PLATFORMS.includes(platform) && (a.handles[platform] || store.read('snapshots', []).some((s) => s.a === a.id && s.p === platform));
    if (!onPlatform) return send(res, 400, { error: 'This account has no username on that platform' });
    const d = String(date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d)) || d > today() || d < '2000-01-01') return send(res, 400, { error: 'Pick a date that is not in the future' });
    const snaps = store.read('snapshots', []);
    const i = snaps.findIndex((s) => s.a === a.id && s.p === platform && s.d === d);
    if (req.method === 'DELETE') {
      if (i < 0 || !snaps[i].m) return send(res, 400, { error: 'Only values entered by hand can be removed' });
      snaps.splice(i, 1);
    } else {
      const f = Number(String(followers ?? '').replace(/[,\s]/g, ''));
      if (!Number.isInteger(f) || f < 0 || f > 5e9) return send(res, 400, { error: 'Enter the number of followers as a whole number' });
      const row = { d, a: a.id, p: platform, f, m: 1, by: email };
      if (i >= 0) snaps[i] = row; else snaps.push(row);
    }
    store.write('snapshots', snaps);
    return send(res, 200, dataPayload());
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    const { schedule } = await readBody(req);
    if (!['off', 'daily', 'weekly'].includes(schedule)) return send(res, 400, { error: 'Schedule must be off, daily or weekly' });
    store.write('settings', { ...getSettings(), schedule });
    return send(res, 200, dataPayload());
  }
  if (p === '/api/refresh' && req.method === 'POST') {
    if (!store.read('accounts', []).length) return send(res, 400, { error: 'Add an account first' });
    scrapeAll('manual:' + email).catch((e) => console.error('[scrape] manual', e));
    return send(res, 202, dataPayload());
  }
  return send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const client = /required|must|look right|Add at least|Bad JSON|Too large/.test(e.message);
    if (!client) console.error(e);
    if (!res.headersSent) send(res, client ? 400 : 500, { error: client ? e.message : 'Server error' });
  });
}).listen(PORT, HOST, () => console.log(`kt-dashboard on http://${HOST}:${PORT} (data in ${store.DATA_DIR})`));

