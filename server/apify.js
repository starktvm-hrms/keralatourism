// Fetches follower counts through Apify actors (pay per result).
// Only profile counts are requested: follower lists are switched off, which keeps
// each run to a few cents.
'use strict';

const API = 'https://api.apify.com/v2';
const ACTORS = {
  instagram: 'apify~instagram-profile-scraper',
  facebook: 'apify~facebook-pages-scraper',
  youtube: 'streamers~youtube-channel-scraper',
  x: 'apidojo~twitter-user-scraper',
};
const PLATFORMS = Object.keys(ACTORS);

// ---- Turning what people type into one clean handle per platform ----
function stripUrl(v, hosts) {
  v = String(v || '').trim();
  if (!v) return '';
  const m = v.match(new RegExp('^(?:https?://)?(?:www\\.|m\\.|mobile\\.)?(?:' + hosts + ')/+(.*)$', 'i'));
  if (m) v = m[1];
  return v.split(/[?#]/)[0].replace(/\/+$/, '');
}

const normalize = {
  instagram: (v) => stripUrl(v, 'instagram\\.com').split('/')[0].replace(/^@/, '').toLowerCase(),
  x: (v) => stripUrl(v, 'twitter\\.com|x\\.com').split('/')[0].replace(/^@/, ''),
  facebook: (v) => {
    const s = stripUrl(v, 'facebook\\.com|fb\\.com');
    if (/^profile\.php/i.test(s)) return s; // numeric profile pages keep their query-less id form
    return s.split('/')[0].replace(/^@/, '');
  },
  youtube: (v) => {
    let s = stripUrl(v, 'youtube\\.com');
    if (/^(channel|user|c)\//i.test(s)) return s.split('/').slice(0, 2).join('/');
    s = s.split('/')[0];
    if (/^UC[\w-]{22}$/.test(s)) return 'channel/' + s;
    return s ? '@' + s.replace(/^@/, '') : '';
  },
};

const urlFor = {
  instagram: (h) => 'https://www.instagram.com/' + h + '/',
  facebook: (h) => 'https://www.facebook.com/' + h,
  youtube: (h) => 'https://www.youtube.com/' + h,
  x: (h) => 'https://x.com/' + h,
};

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

// ---- Calling an actor and waiting for its rows ----
async function runActor(platform, input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set on the server');
  const res = await fetch(`${API}/acts/${ACTORS[platform]}/run-sync-get-dataset-items?timeout=290&format=json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(320000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error.message || msg; } catch (e) {}
    throw new Error(`Apify ${res.status}: ${msg}`);
  }
  return JSON.parse(text);
}

const lastSegment = (u) => String(u || '').toLowerCase().split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();

// Each returns Map(handle -> {followers, name} | {error})
const scrapers = {
  async instagram(handles) {
    const rows = await runActor('instagram', { usernames: handles });
    const out = new Map();
    for (const r of rows) {
      const key = String(r.username || r.inputUrl || '').toLowerCase();
      const h = handles.find((x) => x.toLowerCase() === key || key.endsWith('/' + x.toLowerCase()));
      if (!h) continue;
      out.set(h, r.followersCount != null ? { followers: toNumber(r.followersCount), name: r.fullName } : { error: r.error || 'not found' });
    }
    return out;
  },
  async facebook(handles) {
    const rows = await runActor('facebook', { startUrls: handles.map((h) => ({ url: urlFor.facebook(h) })) });
    const out = new Map();
    for (const r of rows) {
      const keys = [r.facebookUrl, r.pageUrl, r.url, r.inputUrl].filter(Boolean).map(lastSegment);
      const h = handles.find((x) => keys.includes(lastSegment(x)));
      if (!h || out.get(h)?.followers != null) continue;
      const f = toNumber(r.followers ?? r.likes);
      out.set(h, f != null && !r.error ? { followers: f, name: r.title || r.pageName } : { error: r.error || 'not found' });
    }
    return out;
  },
  async youtube(handles) {
    const urls = handles.map(urlFor.youtube);
    const rows = await runActor('youtube', { startUrls: urls.map((url) => ({ url })), maxResults: 1, maxResultsShorts: 0, maxResultStreams: 0 });
    const out = new Map();
    for (const r of rows) {
      const i = urls.findIndex((u) => u.toLowerCase() === String(r.input || '').toLowerCase());
      if (i < 0 || out.get(handles[i])?.followers != null) continue;
      const f = toNumber(r.numberOfSubscribers);
      out.set(handles[i], f != null ? { followers: f, name: r.channelName } : { error: r.error || 'not found' });
    }
    return out;
  },
  async x(handles) {
    const rows = await runActor('x', {
      twitterHandles: handles, maxItems: handles.length + 5,
      getFollowers: false, getFollowing: false, getRetweeters: false, getAbout: false,
    });
    const out = new Map();
    for (const r of rows) {
      const h = handles.find((x) => x.toLowerCase() === String(r.userName || '').toLowerCase());
      if (!h) continue;
      out.set(h, r.followers != null ? { followers: toNumber(r.followers), name: r.name } : { error: 'not found' });
    }
    return out;
  },
};

const FRIENDLY = { not_available: 'Page not found or not public (check the username)', not_found: 'Not found (check the username)' };
for (const [p, fn] of Object.entries(scrapers)) {
  scrapers[p] = async (handles) => {
    const out = await fn(handles);
    for (const v of out.values()) if (v.error && FRIENDLY[v.error]) v.error = FRIENDLY[v.error];
    return out;
  };
}

module.exports = { PLATFORMS, normalize, urlFor, scrapers };
