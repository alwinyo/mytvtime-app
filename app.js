/* ============================================================
   My TV Time — PWA
   Reads and writes the SAME Supabase data as the Streamlit app.

   SCHEMA PARITY IS LOAD-BEARING. The packed arrays must round-trip
   byte-identically or the other app loses fields:
     movie = [id, name, watched, poster, release, runtime, dropped]
     show  = [id, name, eps, poster, firstAir, total, dropped, src]
                                                            ^^^^^
     index 7 is the source ("tmdb" | "football"). Dropping it would
     turn every football season into a broken TMDB show.
   ============================================================ */

'use strict';

const BUILD = '2026-08-24-c';      // shown in Me -> Data; bump on every upload
const CFG_KEY = 'mytv.cfg';
const TMDB_TTL = 12 * 3600 * 1000;
const FOOTBALL_TTL = 3600 * 1000;
const MATCH_MINUTES = 115;          // 90 + half-time + stoppage
const EPISODE_MINUTES = 45;
const MOVIE_MINUTES = 120;

const PLATFORMS = ['', 'Stremio', 'Netflix', 'OSN+', 'Amazon Prime', 'Apple TV+',
                   'Disney+', 'Starzplay', 'Cinema', 'Downloaded', 'Other'];
const MOODS = ['', '🤯 Blew my mind', '😂 Had me laughing', '😭 Wrecked me',
               '😍 Absolutely loved it', '🫣 Could barely watch', '🧠 Cleverly done',
               '🍿 Pure entertainment', '💔 Quietly devastating', '📈 Best thing all year',
               '😐 Went nowhere', '😴 Struggled to finish', '🙃 So bad it was fun'];

/* Stars alone tell you nothing at a glance; words do. */
const RATING_WORDS = ['', 'Didn\u2019t work', 'Watchable', 'Good', 'Really good', 'Outstanding'];
const FOOTBALL_COMPETITIONS = { PL: 'Premier League' };

let cfg = null;
let db = { shows: [], movies: [], analytics: {}, seen_recaps: [], legacy: [] };
let history = [];
let historyTableMissing = false;
let view = 'next';
let libFilter = 'WATCHLIST', libKind = 'tv', genre = 'Trending', meTab = 'stats';
let journalLimit = 100, searchTimer = null;
let feedKind = 'tv', nextSort = 'date', soonSort = 'date';
let nextLimit = 30, soonLimit = 30, libLimit = 60, libQuery = '', libSort = 'date';

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* Football crests are absolute URLs; TMDB stores bare paths. */
function imgUrl(path, size = 'w342') {
  const p = String(path || '');
  if (p.startsWith('http')) return p;
  return p ? `https://image.tmdb.org/t/p/${size}${p}` : '';
}
const isAbs = (p) => String(p || '').startsWith('http');

/* Dubai is UTC+4 all year, no DST. */
const now = () => new Date(Date.now() + 4 * 3600 * 1000);
const stamp = (d = now()) => d.toISOString().slice(0, 19).replace('T', ' ');
const TODAY = () => stamp().slice(0, 10);

function humanizeDays(days) {
  days = Math.max(0, Math.floor(days || 0));
  if (!days) return '0d';
  const y = Math.floor(days / 365), mo = Math.floor((days % 365) / 30), d = days % 30;
  const out = [];
  if (y) out.push(`${y}y`);
  if (mo) out.push(`${mo}mo`);
  if (d && !y) out.push(`${d}d`);
  return out.join(' ') || '0d';
}

function countdown(dateStr) {
  if (!dateStr) return 'Soon';
  const secs = (new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z') - now()) / 1000;
  if (secs <= 0) return 'Out now';
  const days = Math.floor(secs / 86400), hours = Math.floor((secs % 86400) / 3600);
  if (days >= 365) return `In ${Math.floor(days / 365)}y ${Math.floor((days % 365) / 30)}mo`;
  if (days >= 60) return `In ${Math.floor(days / 30)}mo`;
  if (days >= 14) return `In ${Math.floor(days / 7)}w`;
  if (days >= 1) return `In ${days}d ${hours}h`;
  if (hours >= 1) return `In ${hours}h`;
  return 'In <1h';
}

/** A short buzz on a successful action makes a web app feel native. */
function buzz(ms = 12) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

/** Grey poster shapes while data loads — perceived speed, not real speed. */
function skeletonGrid(n = 9) {
  const g = el('div', 'grid');
  for (let i = 0; i < n; i++) g.appendChild(el('div', 'skel'));
  return g;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------------- storage ---------------- */

async function sb(path, opts = {}) {
  const res = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
               'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function cacheGet(key, ttl) {
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.t < ttl) return hit.v;
  } catch { /* corrupt entry */ }
  return null;
}
function cacheSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); }
  catch {
    Object.keys(localStorage).filter(k => k.startsWith('tmdb:') || k.startsWith('fb:'))
      .forEach(k => localStorage.removeItem(k));
  }
}

/** Fetch that cannot hang forever. A stalled mobile request used to wedge the
    whole Up Next chain, because every show awaited the one before it. */
async function fetchJson(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;                       // timeout or network error -> skip, never hang
  } finally {
    clearTimeout(timer);
  }
}

/** Run fn over items with at most `limit` in flight. Sequential awaits over a
    50-show library meant 100 round-trips end to end; six at a time is ~8x faster
    and still polite to TMDB. */
async function mapLimit(items, limit, fn, onProgress, deadlineMs = 0) {
  const out = new Array(items.length);
  const stopAt = deadlineMs ? Date.now() + deadlineMs : 0;
  let cursor = 0, done = 0, timedOut = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (stopAt && Date.now() > stopAt) { timedOut = true; return; }
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
      done++;                                  // count regardless of a callback
      if (onProgress) onProgress(done, items.length);
    }
  });
  await Promise.all(workers);
  out.timedOut = timedOut;
  out.completed = done;
  return out;
}

/** Feeds are expensive, so recompute only when the library actually changes —
    the same trick that fixed the Streamlit rescan-on-every-tap problem. */
function libSignature() {
  return db.shows.map(s => `${s.id}:${s.watched_episodes.length}:${s.total_episodes}:${s.dropped ? 1 : 0}:${s.src}`).join('|')
       + '#' + db.movies.map(m => `${m.id}:${m.watched ? 1 : 0}:${m.dropped ? 1 : 0}`).join('|');
}
let feedCache = { sig: null, next: null, soon: null };

/* Feeds also persist to localStorage, so reopening the app paints instantly
   from the last good result instead of re-querying TMDB from cold. */
function loadFeedCache() {
  try {
    const raw = JSON.parse(localStorage.getItem('mytv.feeds') || 'null');
    if (raw && raw.sig) feedCache = raw;
  } catch { /* ignore */ }
}
function persistFeedCache() {
  try { localStorage.setItem('mytv.feeds', JSON.stringify(feedCache)); } catch { /* quota */ }
}
const invalidateFeeds = () => {
  feedCache = { sig: null, next: null, soon: null };
  try { localStorage.removeItem('mytv.feeds'); } catch { /* ignore */ }
};

async function tmdb(path, params = {}) {
  const qs = new URLSearchParams({ api_key: cfg.tmdb, ...params }).toString();
  const key = 'tmdb:' + path + '?' + qs.replace(/api_key=[^&]*&?/, '');
  const hit = cacheGet(key, TMDB_TTL);
  if (hit) return hit;
  const data = await fetchJson(`https://api.themoviedb.org/3/${path}?${qs}`);
  if (!data) return {};
  cacheSet(key, data);
  return data;
}

/* Byte-identical to Python's encode_eps/decode_eps. A Map, not an object:
   JS objects re-order integer-like keys, Python preserves insertion order. */
function encodeEps(list) {
  const seasons = new Map();
  for (const code of list) {
    const m = /^S(\d+)E(\d+)$/.exec(code);
    if (!m) continue;
    if (!seasons.has(+m[1])) seasons.set(+m[1], []);
    seasons.get(+m[1]).push(+m[2]);
  }
  return [...seasons.entries()].map(([s, eps]) => {
    const sorted = [...new Set(eps)].sort((a, b) => a - b);
    const parts = [];
    let start = sorted[0], prev = sorted[0];
    for (const e of sorted.slice(1)) {
      if (e === prev + 1) { prev = e; continue; }
      parts.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = e;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    return `${s}:${parts.join('.')}`;
  }).join('|');
}

function decodeEps(str) {
  if (!str) return [];
  const out = [];
  for (const part of String(str).split('|')) {
    if (!part.includes(':')) continue;
    const [s, rest] = part.split(':');
    for (const r of rest.split('.')) {
      if (r.includes('-')) {
        const [a, b] = r.split('-').map(Number);
        for (let e = a; e <= b; e++) out.push(`S${s}E${e}`);
      } else if (r) out.push(`S${s}E${r}`);
    }
  }
  return out;
}

function unpack(p) {
  return {
    movies: (p.m || []).map(m => ({
      id: m[0], name: m[1], watched: !!m[2], poster_path: m[3],
      release_date: m[4], runtime: m[5], dropped: !!m[6] })),
    shows: (p.s || []).map(s => ({
      id: s[0], name: s[1], watched_episodes: decodeEps(s[2]), poster_path: s[3],
      first_air_date: s[4], total_episodes: s[5], dropped: !!s[6],
      src: s.length > 7 ? (s[7] || 'tmdb') : 'tmdb' })),          // index 7
    analytics: Object.fromEntries(Object.entries(p.a || {}).map(([k, v]) => [k, { tv: v[0], movie: v[1] }])),
    seen_recaps: p.r || [],
    legacy: (p.h || []).map(h => ({
      type: h[0] === 1 ? 'tv' : 'movie', item: h[1], code: h[2] || '',
      at: h[3] || '', rating: h[4] || 0, feeling: h[5] || '', platform: h[6] || '' })),
  };
}

function pack(d) {
  return {
    m: d.movies.map(m => [m.id, m.name, m.watched ? 1 : 0, m.poster_path || '',
                          m.release_date || '', m.runtime || 0, m.dropped ? 1 : 0]),
    s: d.shows.map(s => [s.id, s.name, encodeEps(s.watched_episodes || []), s.poster_path || '',
                         s.first_air_date || '', s.total_episodes || 1, s.dropped ? 1 : 0,
                         s.src || 'tmdb']),
    a: Object.fromEntries(Object.entries(d.analytics || {}).map(([k, v]) => [k, [v.tv || 0, v.movie || 0]])),
    r: d.seen_recaps || [],
    ...(d.legacy?.length ? {
      h: d.legacy.map(h => [h.type === 'tv' ? 1 : 0, h.item, h.code, h.at, h.rating, h.feeling, h.platform]) } : {}),
  };
}

async function loadPayload() {
  const rows = await sb('tv_time_data?id=eq.1&select=payload');
  db = unpack(rows?.[0]?.payload || {});
}
/** Wraps any write so a failure is visible and the optimistic UI is undone.
    Ten click handlers previously swallowed Supabase errors: the screen showed
    the change, the database never got it, and it vanished on next refresh. */
async function guardedWrite(label, fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    console.error(label, e);
    toast(`Couldn't save — ${String(e.message || e).slice(0, 60)}`);
    try {                       // pull the truth back from the server
      await loadPayload();
      await loadHistory();
      invalidateFeeds();
      render();
    } catch { /* offline: leave the screen as-is */ }
    return false;
  }
}

async function savePayload() {
  await sb('tv_time_data?id=eq.1', { method: 'PATCH',
    body: JSON.stringify({ payload: pack(db) }), headers: { Prefer: 'return=minimal' } });
}

async function loadHistory() {
  const cols = 'id,media_type,item_id,episode_code,watched_at,rating,feeling,platform,cycle';
  const out = [];
  try {
    for (let offset = 0; ; offset += 1000) {
      const rows = await sb(`watch_history?select=${cols}&order=watched_at.desc&limit=1000&offset=${offset}`);
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    historyTableMissing = false;
  } catch (err) {
    if (/PGRST205|does not exist|schema cache/i.test(String(err.message || err))) {
      historyTableMissing = true; history = []; return;
    }
    throw err;
  }
  history = out.map(r => ({
    id: r.id, type: r.media_type, item: String(r.item_id), code: r.episode_code || '',
    at: r.watched_at || '', rating: r.rating || 0, feeling: r.feeling || '',
    platform: r.platform || '', cycle: r.cycle || 1 }));
}

async function migrateLegacy() {
  const rows = (db.legacy || []).map(h => ({
    media_type: h.type, item_id: String(h.item), episode_code: h.code || '',
    watched_at: h.at || stamp(), rating: h.rating || 0,
    feeling: h.feeling || '', platform: h.platform || '' }));
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 500) {
    await sb('watch_history?on_conflict=media_type,item_id,episode_code,watched_at', {
      method: 'POST', body: JSON.stringify(rows.slice(i, i + 500)),
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
  }
  db.legacy = [];
  await savePayload();
  await loadHistory();
  return rows.length;
}

function timesWatched(type, itemId, code = '') {
  return history.filter(h => h.type === type && h.item === String(itemId) && h.code === (code || '')).length;
}

async function addHistory(type, itemId, code, when) {
  if (historyTableMissing) { bumpAnalytics(type, +1, when); return null; }
  const cycle = timesWatched(type, itemId, code) + 1;
  const row = { media_type: type, item_id: String(itemId), episode_code: code || '',
                watched_at: when || stamp(), rating: 0, feeling: '', platform: '', cycle };
  const res = await sb('watch_history?on_conflict=media_type,item_id,episode_code,watched_at', {
    method: 'POST', body: JSON.stringify(row),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });
  const saved = { id: res?.[0]?.id, type, item: String(itemId), code: code || '',
                  at: row.watched_at, rating: 0, feeling: '', platform: '', cycle };
  history.unshift(saved);
  bumpAnalytics(type, +1, when);   // only after the row is really in
  return saved;
}

/** Removes the LATEST viewing, so unmarking a rewatch leaves the original. */
async function delHistory(type, itemId, code) {
  const matches = history
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => h.type === type && h.item === String(itemId) && h.code === (code || ''))
    .sort((a, b) => (b.h.at || '').localeCompare(a.h.at || ''));
  const i = matches.length ? matches[0].idx : -1;
  if (i === -1) { bumpAnalytics(type, -1); return; }
  const [gone] = history.splice(i, 1);
  bumpAnalytics(type, -1, gone.at);
  if (gone.id && !historyTableMissing) {
    await sb(`watch_history?id=eq.${gone.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
}

async function patchHistory(entry, fields) {
  const before = { rating: entry.rating, feeling: entry.feeling, platform: entry.platform };
  Object.assign(entry, fields);
  if (historyTableMissing) { toast("Notes can't save — history table missing"); return false; }
  if (!entry.id) { toast("This entry predates note support — re-mark it to enable notes"); return false; }
  try {
    await sb(`watch_history?id=eq.${entry.id}`, { method: 'PATCH',
      body: JSON.stringify({ rating: entry.rating, feeling: entry.feeling, platform: entry.platform }),
      headers: { Prefer: 'return=minimal' } });
    return true;
  } catch (e) {
    Object.assign(entry, before);          // put it back
    toast(`Couldn't save note — ${String(e.message || e).slice(0, 50)}`);
    return false;
  }
}

function bumpAnalytics(type, delta, when) {
  const key = (when || stamp()).slice(0, 7);
  const b = (db.analytics[key] ||= { tv: 0, movie: 0 });
  const f = type === 'tv' ? 'tv' : 'movie';
  b[f] = Math.max(0, (b[f] || 0) + delta);
}

/* ---------------- watched state ---------------- */

/* Some library rows were saved without a poster path, so the grid showed a
   placeholder while the detail sheet — which fetches fresh — looked fine.
   Fill the gap once, quietly, and write it back. */
const healing = new Set();
async function healArtwork(items, kind) {
  const gaps = items.filter(x => !x.poster_path && !healing.has(String(x.id))).slice(0, 12);
  if (!gaps.length) return false;
  gaps.forEach(x => healing.add(String(x.id)));
  let changed = false;
  await mapLimit(gaps, 4, async (x) => {
    if (isFootballShow(x)) return;
    const d = await tmdb(`${kind}/${x.id}`);
    if (d && d.poster_path) { x.poster_path = d.poster_path; changed = true; }
  });
  if (changed) await savePayload();
  return changed;
}

const getShow = (id) => db.shows.find(s => String(s.id) === String(id));
const getMovie = (id) => db.movies.find(m => String(m.id) === String(id));
const findLog = (type, id, code = '') =>
  history.find(h => h.type === type && h.item === String(id) && h.code === (code || ''));
const isFootballShow = (s) => !!s && s.src === 'football';

/* TMDB's number_of_episodes excludes season 0, so counting specials as watched
   pushes shows past 100%. Count the same set TMDB counts. */
const countedEps = (show) =>
  (show?.watched_episodes || []).filter(c => !c.startsWith('S0E')).length;

/** True mismatch: more real episodes watched than the show is meant to have. */
const isMismatched = (s) => !s.dropped && !isFootballShow(s)
  && s.total_episodes > 0 && countedEps(s) > s.total_episodes;
const topKey = (o) => Object.keys(o).length ? Object.entries(o).sort((a, b) => b[1] - a[1])[0] : null;

function epWatched(showId, code) {
  const s = getShow(showId);
  return !!(s && s.watched_episodes.includes(code)) || !!findLog('tv', showId, code);
}
function movieWatched(id) {
  const m = getMovie(id);
  return !!(m && m.watched) || !!findLog('movie', id);
}

/** Log another viewing without disturbing the first. */
async function rewatchEpisode(showId, code, meta = {}) {
  let s = getShow(showId);
  if (!s) return false;
  if (!s.watched_episodes.includes(code)) s.watched_episodes.push(code);
  await addHistory('tv', showId, code, stamp());
  invalidateFeeds();
  await savePayload();
  return true;
}

async function setEpisode(showId, code, on, meta = {}) {
  let s = getShow(showId);
  if (!s) {
    const d = await tmdb(`tv/${showId}`);
    s = { id: showId, name: meta.name || d.name, watched_episodes: [], poster_path: d.poster_path || '',
          first_air_date: d.first_air_date || '', total_episodes: d.number_of_episodes || 1,
          dropped: false, src: 'tmdb' };
    db.shows.push(s);
  }
  if (on) {
    if (!s.watched_episodes.includes(code)) s.watched_episodes.push(code);
    await addHistory('tv', showId, code);
  } else {
    s.watched_episodes = s.watched_episodes.filter(c => c !== code);
    await delHistory('tv', showId, code);
  }
  invalidateFeeds();
  await savePayload();
}

async function setMovie(id, on, meta = {}) {
  let m = getMovie(id);
  if (!m) {
    const d = await tmdb(`movie/${id}`);
    m = { id, name: meta.name || d.title, watched: false, poster_path: d.poster_path || '',
          release_date: d.release_date || '', runtime: d.runtime || MOVIE_MINUTES, dropped: false };
    db.movies.push(m);
  }
  m.watched = on;
  if (on) await addHistory('movie', id, ''); else await delHistory('movie', id, '');
  invalidateFeeds();
  await savePayload();
}

/** Bulk toggle — one payload save instead of one per episode. */
async function markMany(showId, codes, on, meta = {}) {
  const s = getShow(showId);
  if (!s) return 0;
  let changed = 0;
  for (const code of codes) {
    const already = epWatched(showId, code);
    if (on && !already) {
      if (!s.watched_episodes.includes(code)) s.watched_episodes.push(code);
      await addHistory('tv', showId, code);
      changed++;
    } else if (!on && already) {
      s.watched_episodes = s.watched_episodes.filter(c => c !== code);
      await delHistory('tv', showId, code);
      changed++;
    }
  }
  if (changed) { invalidateFeeds(); await savePayload(); }
  return changed;
}

/* ---------------- TMDB bundles ---------------- */

async function showBundle(id) {
  const base = await tmdb(`tv/${id}`);
  if (!base.seasons) return base;
  const nums = base.seasons.filter(s => s.season_number > 0).map(s => s.season_number);
  const bundle = { ...base };
  for (let i = 0; i < nums.length; i += 20) {
    const chunk = nums.slice(i, i + 20);
    const data = await tmdb(`tv/${id}`, { append_to_response: chunk.map(n => `season/${n}`).join(',') });
    for (const n of chunk) if (data[`season/${n}`]) bundle[`season/${n}`] = data[`season/${n}`];
  }
  return bundle;
}
const seasonEps = (bundle, n) => bundle[`season/${n}`]?.episodes || [];

async function providersFor(mediaType, id) {
  const data = await tmdb(`${mediaType}/${id}/watch/providers`);
  const region = data?.results?.AE || {};
  return [['Stream', region.flatrate || []], ['Rent', region.rent || []], ['Buy', region.buy || []]]
    .filter(([, items]) => items.length);
}

/* ---------------- football ---------------- */

// Football needs no key here — Streamlit holds it and syncs to Supabase.
const footballEnabled = () => true;

/* football-data.org sends no CORS headers on v4, so a browser request dies as
   "Failed to fetch" no matter what the key is. Streamlit fetches server-side
   and parks the result in Supabase; we read that instead. */
const fbCache = new Map();
let fbLastError = null;

async function fbSeason(code, season) {
  const key = `${code}-${season}`;
  if (fbCache.has(key)) return fbCache.get(key);
  const local = cacheGet('fbdb:' + key, FOOTBALL_TTL);
  if (local) { fbCache.set(key, local); return local; }

  try {
    const rows = await sb(`football_cache?competition=eq.${code}&season=eq.${season}&select=payload,updated_at&limit=1`);
    if (!rows || !rows.length) {
      fbLastError = `No fixtures stored yet for ${code} ${season}. Open the Streamlit app → Profile → Import → Football sync, and push them.`;
      return null;
    }
    const payload = rows[0].payload || {};
    payload.updated_at = rows[0].updated_at;
    fbLastError = null;
    fbCache.set(key, payload);
    cacheSet('fbdb:' + key, payload);
    return payload;
  } catch (e) {
    fbLastError = /PGRST205|schema cache/i.test(String(e.message))
      ? 'The football_cache table does not exist yet. Run football_cache.sql in Supabase.'
      : `Couldn't read fixtures: ${e.message}`;
    return null;
  }
}

/** Season year from the calendar alone — no network, never fails. */
function calendarSeason() {
  const d = now();
  return (d.getUTCMonth() + 1) >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

async function currentSeasonYear(code) {
  // Try the season the calendar suggests, then last season, since the cache is
  // keyed per season and a new campaign may not be pushed yet.
  const guess = calendarSeason();
  for (const y of [guess, guess - 1]) {
    const p = await fbSeason(code, y);
    if (p) return p.meta?.current_season || y;
  }
  return guess;
}

async function competitionEmblem(code) {
  const p = await fbSeason(code, calendarSeason());
  return p?.meta?.emblem || `https://crests.football-data.org/${code}.png`;
}

const footballShowId = (code, season) => `${code}-${season}`;

function parseFootballId(showId) {
  const m = /^(.+)-(\d+)$/.exec(String(showId));
  // Calendar fallback deliberately: a malformed id must not hit the network.
  return m ? [m[1], +m[2]] : ['PL', calendarSeason()];
}

const seasonLabel = (code, season) =>
  `${FOOTBALL_COMPETITIONS[code] || code} ${season}/${String(season + 1).slice(2)}`;

function kickoffLocal(utcIso) {
  if (!utcIso) return null;
  const d = new Date(utcIso);
  return isNaN(d) ? null : new Date(d.getTime() + 4 * 3600 * 1000);
}

async function footballMatchdays(code, season) {
  const payload = await fbSeason(code, season);
  const out = {};
  for (const m of (payload?.matches || [])) {
    const md = m.matchday || 0;
    if (!md) continue;
    const ko = kickoffLocal(m.utcDate);
    const sc = m.score?.fullTime || {};
    (out[md] ||= []).push({
      home: m.homeTeam?.shortName || m.homeTeam?.name || 'TBC',
      away: m.awayTeam?.shortName || m.awayTeam?.name || 'TBC',
      home_crest: m.homeTeam?.crest || '', away_crest: m.awayTeam?.crest || '',
      status: m.status || 'SCHEDULED',
      home_goals: sc.home ?? null, away_goals: sc.away ?? null,
      kickoff: ko ? stamp(ko).slice(0, 16) : '',
      date: ko ? stamp(ko).slice(0, 10) : '',
      started: !!(ko && ko <= now()),
    });
  }
  for (const md of Object.keys(out)) {
    out[md].sort((a, b) => (a.kickoff || '9999').localeCompare(b.kickoff || '9999'));
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => +a[0] - +b[0]));
}

const matchLabel = (g) => `${g.home} vs ${g.away}`;
const matchScore = (g) => g.home_goals == null ? '' : `${g.home_goals}\u2013${g.away_goals}`;
const trackedFootball = () => db.shows.filter(isFootballShow);

async function ensureFootballShow(code, season) {
  const sid = footballShowId(code, season);
  if (getShow(sid)) return getShow(sid);
  const days = await footballMatchdays(code, season);
  db.shows.push({
    id: sid, name: seasonLabel(code, season), watched_episodes: [],
    poster_path: await competitionEmblem(code), first_air_date: '',
    total_episodes: Object.values(days).reduce((n, v) => n + v.length, 0) || 380,
    dropped: false, src: 'football' });
  await savePayload();
  return getShow(sid);
}

async function computeFootballRows(kind) {
  if (!footballEnabled()) return [];
  const rows = [];
  for (const show of trackedFootball()) {
    if (show.dropped) continue;
    const [code, season] = parseFootballId(show.id);
    const days = await footballMatchdays(code, season);
    const seen = new Set(show.watched_episodes);

    // Furthest point you've reached. Watching matchday 6 means matchday 5 is
    // behind you — Up Next should move forward, not send you back.
    let maxMd = 0, maxIdx = 0;
    for (const c of seen) {
      const m = /^S(\d+)E(\d+)$/.exec(c);
      if (!m) continue;
      const md = +m[1], idx = +m[2];
      if (md > maxMd || (md === maxMd && idx > maxIdx)) { maxMd = md; maxIdx = idx; }
    }

    let pick = null;
    for (const [mdKey, games] of Object.entries(days)) {
      const md = +mdKey;
      for (let i = 0; i < games.length; i++) {
        const c = `S${md}E${i + 1}`;
        if (seen.has(c)) continue;
        const behind = md < maxMd || (md === maxMd && (i + 1) < maxIdx);
        if (kind === 'next' && behind) continue;          // already moved past it
        if (kind === 'next' && games[i].started) { pick = [c, games[i], md]; break; }
        if (kind === 'soon' && !games[i].started) { pick = [c, games[i], md]; break; }
      }
      if (pick) break;
    }
    if (!pick) continue;
    rows.push({ id: show.id, name: show.name, poster: show.poster_path, backdrop: '',
                code: pick[0], epName: matchLabel(pick[1]), date: pick[1].date || TODAY(),
                src: 'football', match: pick[1], matchday: pick[2] });
  }
  return rows;
}

/** Nobody publishes matchday artwork, so compose it from the two crests. */
function fixturePosterHtml(row) {
  const g = row.match || {};
  const c = 'width:44%;max-width:52px;aspect-ratio:1;object-fit:contain;filter:drop-shadow(0 3px 6px rgba(0,0,0,.6));';
  let inner = '';
  if (g.home_crest) inner += `<img src="${g.home_crest}" style="${c}">`;
  inner += '<span style="color:#FFC107;font-size:.62rem;font-weight:900;margin:0 3px;opacity:.85">v</span>';
  if (g.away_crest) inner += `<img src="${g.away_crest}" style="${c}">`;
  return `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 32%,#232A3A,#0B0E14 78%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:10px 8px 34px">
    <div style="font-size:.5rem;font-weight:900;letter-spacing:.16em;color:#FFC107;text-transform:uppercase;opacity:.9">
    Matchday ${row.matchday ?? ''}</div>
    <div style="display:flex;align-items:center;justify-content:center;width:100%">${inner}</div></div>`;
}

/* ---------------- feeds ---------------- */

async function computeNext(onProgress) {
  const sig = libSignature();
  if (feedCache.sig === sig && feedCache.next) return feedCache.next;

  const today = TODAY();
  const candidates = db.shows.filter(x => !x.dropped && !isFootballShow(x));

  const found = await mapLimit(candidates, 6, async (s) => {
    const b = await showBundle(s.id);
    const total = b.number_of_episodes || s.total_episodes || 0;
    if (total && s.watched_episodes.length >= total) return null;
    const seen = new Set(s.watched_episodes);
    for (const info of (b.seasons || []).filter(x => x.season_number > 0)) {
      for (const ep of seasonEps(b, info.season_number)) {
        const code = `S${info.season_number}E${ep.episode_number}`;
        const air = (ep.air_date || '').trim();
        if (!seen.has(code) && air && air <= today) {
          return { id: s.id, name: s.name, poster: s.poster_path || b.poster_path,
                   backdrop: b.backdrop_path, code, epName: ep.name || 'Episode',
                   date: air, kind: 'tv' };
        }
      }
    }
    return null;
  }, onProgress, 30000);                 // 30s ceiling — partial beats spinning

  const rows = found.filter(Boolean);
  rows.push(...(await computeFootballRows('next')).map(r => ({ ...r, kind: 'tv' })));
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  rows.partial = !!found.timedOut;
  feedCache.next = rows;
  if (!found.timedOut) feedCache.sig = sig;    // only a complete run marks it fresh
  persistFeedCache();
  return rows;
}

async function computeSoon(onProgress) {
  const sig = libSignature();
  if (feedCache.sig === sig && feedCache.soon) return feedCache.soon;

  const today = TODAY();
  const candidates = db.shows.filter(x => !x.dropped && !isFootballShow(x));

  const found = await mapLimit(candidates, 6, async (s) => {
    const b = await showBundle(s.id);
    const seen = new Set(s.watched_episodes);
    for (const info of (b.seasons || []).filter(x => x.season_number > 0)) {
      for (const ep of seasonEps(b, info.season_number)) {
        const code = `S${info.season_number}E${ep.episode_number}`;
        const air = (ep.air_date || '').trim();
        if (!seen.has(code) && air && air > today) {
          return { id: s.id, name: s.name, poster: s.poster_path || b.poster_path,
                   code, epName: ep.name || 'Episode', date: air, kind: 'tv' };
        }
      }
    }
    return null;
  }, onProgress, 30000);

  const rows = found.filter(Boolean);
  const partial = !!found.timedOut;
  for (const m of db.movies) {
    if (m.dropped || movieWatched(m.id)) continue;
    const d = (m.release_date || '').trim();
    if (d && d > today) {
      rows.push({ id: m.id, name: m.name, poster: m.poster_path, movie: true, date: d, kind: 'movie' });
    }
  }
  rows.push(...(await computeFootballRows('soon')).map(r => ({ ...r, kind: 'tv' })));
  rows.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  rows.partial = partial;
  feedCache.soon = rows;
  if (!partial) feedCache.sig = sig;
  persistFeedCache();
  return rows;
}

/* Sorting shared by both feeds. */
function sortFeed(rows, mode, desc) {
  const out = [...rows];
  if (mode === 'alpha') out.sort((a, b) => a.name.localeCompare(b.name));
  else out.sort((a, b) => desc ? (b.date || '').localeCompare(a.date || '')
                               : (a.date || '9999').localeCompare(b.date || '9999'));
  return out;
}

/* ---------------- primitives ---------------- */

function posterEl({ title, poster, badge, progress, mediaHtml, onOpen, quick }) {
  const b = el('button', 'poster');
  const media = mediaHtml ||
    `<img loading="lazy" src="${imgUrl(poster)}" alt=""
      style="width:100%;height:100%;object-fit:${isAbs(poster) ? 'contain' : 'cover'};display:block">`;
  b.innerHTML = media +
    (badge ? `<span class="p-badge">${esc(badge)}</span>` : '') +
    `<span class="p-title">${esc(title)}</span>` +
    (progress >= 0 ? `<span class="p-prog" style="width:${Math.min(progress, 1) * 100}%"></span>` : '');
  b.addEventListener('click', onOpen);

  if (quick) {
    // Hold a poster for quick actions, so the commonest job skips a screen.
    let timer = null, moved = false;
    const start = () => { moved = false; timer = setTimeout(() => {
      if (!moved) { buzz(20); quickMenu(quick); } }, 480); };
    const stop = () => clearTimeout(timer);
    b.addEventListener('touchstart', start, { passive: true });
    // Belt and braces: Chrome raises its image menu from a long touch on <img>.
    b.querySelectorAll('img').forEach(im => {
      im.addEventListener('contextmenu', (e) => e.preventDefault());
      im.setAttribute('draggable', 'false');
    });
    b.addEventListener('touchmove', () => { moved = true; stop(); }, { passive: true });
    b.addEventListener('touchend', stop);
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); quickMenu(quick); });
  }
  return b;
}

/** Bottom action menu shown on long-press. */
function quickMenu({ title, actions }) {
  const wrap = el('div', 'qm');
  wrap.innerHTML = `<div class="qm-sheet"><div class="qm-title">${esc(title)}</div></div>`;
  const sheet = wrap.querySelector('.qm-sheet');
  actions.filter(Boolean).forEach(([label, fn, danger]) => {
    const b = el('button', 'qm-item' + (danger ? ' danger' : ''), label);
    b.onclick = async () => { wrap.remove(); await fn(); };
    sheet.appendChild(b);
  });
  const cancel = el('button', 'qm-item cancel', 'Cancel');
  cancel.onclick = () => wrap.remove();
  sheet.appendChild(cancel);
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}

function gridOf(items) {
  const g = el('div', 'grid');
  items.forEach(i => g.appendChild(posterEl(i)));
  return g;
}

function emptyState(title, body, action) {
  const e = el('div', 'empty', `<strong>${esc(title)}</strong>${esc(body)}`);
  if (action) {
    const b = el('button', 'btn gold', action.label);
    b.onclick = action.onClick;
    e.appendChild(b);
  }
  return e;
}

/** Balanced rows: 7 options at 3-per-row become 3/2/2, never 3/3/1. */
function segmented(options, current, onPick, perRow = 0) {
  const wrap = el('div');
  const total = options.length;
  const per = perRow || total;
  const rowCount = Math.max(1, Math.ceil(total / per));
  const base = Math.floor(total / rowCount), extra = total % rowCount;
  let idx = 0;
  for (let r = 0; r < rowCount; r++) {
    const size = base + (r < extra ? 1 : 0);
    const row = el('div', 'seg');
    row.style.gridTemplateColumns = `repeat(${size}, minmax(0,1fr))`;
    for (const [label, value] of options.slice(idx, idx + size)) {
      const b = el('button', null, label);
      b.setAttribute('aria-pressed', String(value === current));
      b.onclick = () => onPick(value);
      row.appendChild(b);
    }
    idx += size;
    wrap.appendChild(row);
  }
  return wrap;
}

function statCards(cards) {
  const row = el('div', 'stat-row');
  row.innerHTML = cards.map(([v, u, l]) =>
    `<div class="stat"><b>${esc(v)}${u ? `<i>${esc(u)}</i>` : ''}</b><span>${esc(l)}</span></div>`).join('');
  return row;
}

function providerRows(groups) {
  if (!groups.length) return '';
  return '<div class="section-head">Where to watch</div>' + groups.map(([label, items]) =>
    `<div class="prov"><span>${label}</span><span>` +
    items.slice(0, 8).filter(p => p.logo_path)
      .map(p => `<img src="${imgUrl(p.logo_path, 'w92')}" title="${esc(p.provider_name)}">`).join('') +
    '</span></div>').join('');
}

/* ---------------- views ---------------- */

async function render() {
  document.querySelectorAll('#tabbar button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.view === view)));
  const v = $('#view');
  v.innerHTML = '<div class="spinner">Loading…</div>';
  try {
    if (view === 'next') await renderNext(v);
    else if (view === 'soon') await renderSoon(v);
    else if (view === 'search') await renderSearch(v);
    else if (view === 'library') renderLibrary(v);
    else await renderMe(v);
  } catch (err) {
    v.innerHTML = '';
    v.appendChild(emptyState("Couldn't load that", String(err.message || err),
      { label: 'Try again', onClick: render }));
  }
  if (historyTableMissing) v.prepend(historyBanner());
  else if (db.legacy?.length) v.prepend(legacyBanner());
}

function historyBanner() {
  return el('div', 'banner', `<strong>One setup step left</strong>
    Your library loaded, but the <code>watch_history</code> table doesn't exist yet,
    so watch dates and notes can't be saved. Run the SQL in Supabase, then tap ↻.`);
}

function legacyBanner() {
  const b = el('div', 'banner', `<strong>${db.legacy.length} watch dates to move</strong>
    These are still stored the old way, inside your library record.`);
  const go = el('button', 'btn gold');
  go.textContent = 'Move them now';
  go.style.cssText = 'width:100%;margin-top:10px';
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Moving…';
    try { const n = await migrateLegacy(); toast(`Moved ${n} entries`); render(); }
    catch { go.disabled = false; go.textContent = 'Try again'; toast('Failed — data untouched'); }
  };
  b.appendChild(go);
  return b;
}

function openRow(r) {
  if (r.src === 'football') {
    if (r.match && r.code) openMatch(r.id, r.name, r.code, r.match);
    else openFootball(r.id, r.name);
  }
  else if (r.movie) openMovie(r.id, r.name);
  else openEpisode(r.id, r.name, r.code);
}

async function renderNext(v) {
  // Show whatever we have instantly; refresh behind it. A cold recompute only
  // ever blocks the very first run.
  const fresh = feedCache.sig === libSignature();
  const cached = feedCache.next;
  if (!cached) {
    v.innerHTML = '<div class="spinner">Checking your shows… <b class="prog"></b></div>';
    v.appendChild(skeletonGrid(6));
  }
  const progEl = v.querySelector('.prog');
  const all = cached || await computeNext(
    (d, t) => { if (progEl) progEl.textContent = `${d}/${t}`; });
  v.innerHTML = '';
  if (cached && !fresh) {
    v.appendChild(el('div', 'refreshing', 'Updating in the background…'));
    computeNext().then(() => { if (view === 'next') render(); }).catch(() => {});
  }
  if (all.partial) {
    const warn = el('div', 'banner', `<strong>Partial results</strong>
      Some shows took too long to load. Tap ↻ to finish, or check your connection.`);
    v.appendChild(warn);
  }

  v.appendChild(segmented([['Series', 'tv'], ['Films', 'movie']], feedKind,
    k => { feedKind = k; render(); }, 2));
  v.appendChild(segmented([['Newest', 'date'], ['A–Z', 'alpha']], nextSort,
    m => { nextSort = m; render(); }, 2));

  let rows = all.filter(r => (r.kind || 'tv') === feedKind);
  if (feedKind === 'movie') {
    // Films you own, released, still unwatched — the movie half of Up Next.
    rows = db.movies.filter(m => !m.dropped && !movieWatched(m.id)
        && (m.release_date || '') && (m.release_date || '') <= TODAY())
      .map(m => ({ id: m.id, name: m.name, poster: m.poster_path, movie: true,
                   date: m.release_date, kind: 'movie' }));
  }
  rows = sortFeed(rows, nextSort, true);

  if (!rows.length) {
    v.appendChild(emptyState('All caught up',
      feedKind === 'tv' ? 'Nothing waiting. Add a show and it will show up here.'
                        : 'No unwatched films in your library.',
      { label: 'Find something', onClick: () => { view = 'search'; render(); } }));
    return;
  }

  const [hero, ...rest] = rows;
  const h = el('button', 'hero');
  // Crests must not be cropped like a backdrop, and a 2:3 poster used as a
  // wide hero should anchor to the top so faces survive the crop.
  const heroArt = hero.backdrop || hero.poster;
  const heroFit = isAbs(heroArt) ? 'object-fit:contain;padding:26px 0;'
                : hero.backdrop ? 'object-fit:cover;object-position:center;'
                : 'object-fit:cover;object-position:center 18%;';
  h.innerHTML = `<img src="${imgUrl(heroArt, 'w780')}" style="${heroFit}" alt="">
    <span class="hero-shade"></span>
    <span class="hero-inner">
      <span class="hero-name">${esc(hero.name)}</span>
      <span class="hero-ep">${esc(hero.code || '')}${hero.epName ? ' · ' + esc(hero.epName) : ''}</span></span>`;
  h.onclick = () => openRow(hero);
  v.appendChild(h);

  const actions = el('div', 'row-actions');
  const watch = el('button', 'btn gold', 'Mark watched');
  watch.onclick = async () => {
    watch.disabled = true;
    const ok = await guardedWrite('mark hero', async () => {
      if (hero.movie) await setMovie(hero.id, true, { name: hero.name });
      else await setEpisode(hero.id, hero.code, true, { name: hero.name });
    });
    if (!ok) return;
    invalidateFeeds();
    buzz(); toast(`${hero.code || hero.name} logged`);
    openRow(hero); render();
  };
  const info = el('button', 'btn', 'Details');
  info.onclick = () => openRow(hero);
  actions.append(watch, info);
  v.appendChild(actions);

  if (rest.length) {
    const shown = rest.slice(0, nextLimit);
    v.appendChild(el('div', 'section-head', `${rest.length} more waiting`));
    v.appendChild(gridOf(shown.map(r => ({
      title: r.name, poster: r.poster,
      badge: r.src === 'football' ? r.epName : r.code,
      mediaHtml: r.src === 'football' ? fixturePosterHtml(r) : null,
      onOpen: () => openRow(r) }))));
    if (rest.length > nextLimit) {
      const more = el('button', 'btn', `Load ${Math.min(30, rest.length - nextLimit)} more`);
      more.style.cssText = 'width:100%;margin-top:10px';
      more.onclick = () => { nextLimit += 30; render(); };
      v.appendChild(more);
    }
  }
}

async function renderSoon(v) {
  // Show whatever we have instantly; refresh behind it. A cold recompute only
  // ever blocks the very first run.
  const fresh = feedCache.sig === libSignature();
  const cached = feedCache.soon;
  if (!cached) {
    v.innerHTML = '<div class="spinner">Checking schedules… <b class="prog"></b></div>';
    v.appendChild(skeletonGrid(6));
  }
  const progEl = v.querySelector('.prog');
  const all = cached || await computeSoon(
    (d, t) => { if (progEl) progEl.textContent = `${d}/${t}`; });
  v.innerHTML = '';
  if (cached && !fresh) {
    v.appendChild(el('div', 'refreshing', 'Updating in the background…'));
    computeSoon().then(() => { if (view === 'soon') render(); }).catch(() => {});
  }
  if (all.partial) {
    const warn = el('div', 'banner', `<strong>Partial results</strong>
      Some shows took too long to load. Tap ↻ to finish, or check your connection.`);
    v.appendChild(warn);
  }

  v.appendChild(segmented([['Series', 'tv'], ['Films', 'movie']], feedKind,
    k => { feedKind = k; render(); }, 2));
  v.appendChild(segmented([['Soonest', 'date'], ['A–Z', 'alpha']], soonSort,
    m => { soonSort = m; render(); }, 2));

  const rows = sortFeed(all.filter(r => (r.kind || 'tv') === feedKind), soonSort, false);
  if (!rows.length) {
    v.appendChild(emptyState('Nothing scheduled',
      'When something in your library has a release date, it lands here.'));
    return;
  }

  const shown = rows.slice(0, soonLimit);
  v.appendChild(gridOf(shown.map(r => ({
    title: r.name, poster: r.poster,
    badge: r.movie ? countdown(r.date)
         : `${r.src === 'football' ? r.epName : r.code} · ${countdown(r.date)}`,
    mediaHtml: r.src === 'football' ? fixturePosterHtml(r) : null,
    onOpen: () => openRow(r) }))));
  if (rows.length > soonLimit) {
    const more = el('button', 'btn', `Load ${Math.min(30, rows.length - soonLimit)} more`);
    more.style.cssText = 'width:100%;margin-top:10px';
    more.onclick = () => { soonLimit += 30; render(); };
    v.appendChild(more);
  }
}

async function renderSearch(v) {
  v.innerHTML = '';
  const wrap = el('div', 'search-wrap');
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search shows and movies';
  input.value = renderSearch.q || '';
  wrap.appendChild(input);
  v.appendChild(wrap);

  const results = el('div');
  v.appendChild(results);

  const showDiscover = async () => {
    results.innerHTML = '';
    const genres = [['Trending', 'Trending'], ['Comedy', 'Comedy'], ['Action', 'Action'],
                    ['Sci-Fi', 'Sci-Fi'], ['Thriller', 'Thriller'], ['Horror', 'Horror']];
    if (footballEnabled()) genres.push(['Football', 'Football']);
    results.appendChild(segmented(genres, genre, g => { genre = g; showDiscover(); }, 3));

    const body = el('div');
    body.innerHTML = '<div class="spinner">Loading…</div>';
    results.appendChild(body);

    if (genre === 'Football') return renderFootballDiscover(body);

    const TV = { Comedy: 35, Action: 10759, 'Sci-Fi': 10765, Thriller: 9648, Horror: 9648 };
    const MOV = { Comedy: 35, Action: 28, 'Sci-Fi': 878, Thriller: 53, Horror: 27 };
    const [tvRes, mvRes] = genre === 'Trending'
      ? await Promise.all([tmdb('trending/tv/day'), tmdb('trending/movie/day')])
      : await Promise.all([
          tmdb('discover/tv', { with_genres: TV[genre], sort_by: 'popularity.desc' }),
          tmdb('discover/movie', { with_genres: MOV[genre], sort_by: 'popularity.desc' })]);

    body.innerHTML = '';
    body.appendChild(el('div', 'section-head', 'Series'));
    body.appendChild(gridOf((tvRes.results || []).slice(0, 12).map(i => ({
      title: i.name, poster: i.poster_path, onOpen: () => openShow(i.id, i.name) }))));
    body.appendChild(el('div', 'section-head', 'Films'));
    body.appendChild(gridOf((mvRes.results || []).slice(0, 12).map(i => ({
      title: i.title, poster: i.poster_path, onOpen: () => openMovie(i.id, i.title) }))));

    if (genre === 'Trending') await koreanRows(body);
  };

  const run = async (q) => {
    renderSearch.q = q;
    if (!q.trim()) return showDiscover();
    results.innerHTML = '<div class="spinner">Searching…</div>';
    const [tv, mv] = await Promise.all([tmdb('search/tv', { query: q }), tmdb('search/movie', { query: q })]);
    const items = [...(tv.results || []).map(r => ({ ...r, kind: 'tv' })),
                   ...(mv.results || []).map(r => ({ ...r, kind: 'movie' }))]
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 30);
    results.innerHTML = '';
    if (!items.length) {
      results.appendChild(emptyState('Nothing found',
        `No shows or films match “${q}”. Live sport isn't in TMDB, so leagues and fixtures won't appear here — use the Football filter instead.`));
      return;
    }
    results.appendChild(gridOf(items.map(i => ({
      title: i.name || i.title, poster: i.poster_path,
      badge: i.kind === 'tv' ? 'Series' : 'Film',
      onOpen: () => i.kind === 'tv' ? openShow(i.id, i.name) : openMovie(i.id, i.title) }))));
  };

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => run(input.value), 400);
  });
  await run(input.value);
}

/** Korean releases dated inside the current month — the row the Streamlit
    Discover tab had. Uses TMDB's date filters rather than popularity, so it
    genuinely reflects this month's releases. */
async function koreanRows(body) {
  const d = now();
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;
  const monthName = ['January','February','March','April','May','June','July',
                     'August','September','October','November','December'][m - 1];

  const [kt, km] = await Promise.all([
    tmdb('discover/tv', { with_original_language: 'ko', sort_by: 'popularity.desc',
      'first_air_date.gte': first, 'first_air_date.lte': last }),
    tmdb('discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc',
      'primary_release_date.gte': first, 'primary_release_date.lte': last }),
  ]);

  const tvList = (kt.results || []).slice(0, 12);
  const mvList = (km.results || []).slice(0, 12);

  if (tvList.length) {
    body.appendChild(el('div', 'section-head', `K-Dramas · ${monthName}`));
    body.appendChild(gridOf(tvList.map(i => ({
      title: i.name, poster: i.poster_path,
      badge: (i.first_air_date || '').slice(5) || null,
      onOpen: () => openShow(i.id, i.name) }))));
  }
  if (mvList.length) {
    body.appendChild(el('div', 'section-head', `K-Movies · ${monthName}`));
    body.appendChild(gridOf(mvList.map(i => ({
      title: i.title, poster: i.poster_path,
      badge: (i.release_date || '').slice(5) || null,
      onOpen: () => openMovie(i.id, i.title) }))));
  }
  if (!tvList.length && !mvList.length) {
    body.appendChild(el('div', 'section-head', `Korean · ${monthName}`));
    body.appendChild(el('div', 'muted', 'Nothing dated this month yet.'));
  }
}

async function renderFootballDiscover(body) {
  body.innerHTML = '';
  for (const [code, name] of Object.entries(FOOTBALL_COMPETITIONS)) {
    const season = await currentSeasonYear(code);      // from the API, never hardcoded
    const sid = footballShowId(code, season);
    const label = seasonLabel(code, season);
    const days = await footballMatchdays(code, season);

    body.appendChild(el('div', 'section-head', name));
    if (!Object.keys(days).length) {
      body.appendChild(emptyState("Couldn't load fixtures",
        fbLastError || 'No fixtures returned. The season may not be published yet.'));
      continue;
    }
    const tracked = getShow(sid);
    const past = trackedFootball().filter(x => parseFootballId(x.id)[0] === code && String(x.id) !== sid);
    if (past.length && !tracked) {
      body.appendChild(el('div', 'banner',
        `<strong>New season available</strong>${esc(label)} has started. Your earlier season stays in your library.`));
    }
    const emblem = await competitionEmblem(code);
    const cards = [{ id: sid, name: label, poster: emblem, sub: tracked ? 'Tracking' : 'Tap to add' }]
      .concat(past.map(x => ({ id: x.id, name: x.name, poster: x.poster_path, sub: 'Past season' })));
    body.appendChild(gridOf(cards.map(c => ({
      title: c.name, poster: c.poster, badge: c.sub, onOpen: () => openFootball(c.id, c.name) }))));
  }
}

function renderLibrary(v) {
  v.innerHTML = '';
  v.appendChild(segmented([['Series', 'tv'], ['Films', 'movie']], libKind,
    k => { libKind = k; libLimit = 60; renderLibrary(v); }, 2));
  v.appendChild(segmented(
    [['Watchlist', 'WATCHLIST'], ['Watching', 'WATCHING'], ['Done', 'WATCHED'], ['Dropped', 'DROPPED']],
    libFilter, f => { libFilter = f; libLimit = 60; renderLibrary(v); }, 2));

  const searchWrap = el('div', 'search-wrap');
  const input = el('input');
  input.type = 'search';
  input.placeholder = libKind === 'tv' ? 'Filter shows…' : 'Filter films…';
  input.value = libQuery;
  searchWrap.appendChild(input);
  v.appendChild(searchWrap);
  input.addEventListener('input', () => {
    libQuery = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { libLimit = 60; renderLibrary(v); input.focus(); }, 250);
  });

  v.appendChild(segmented([['Recent', 'date'], ['A–Z', 'alpha'], ['Progress', 'prog']], libSort,
    m => { libSort = m; renderLibrary(v); }, 3));

  const today = TODAY();
  const q = libQuery.trim().toLowerCase();
  let items;

  if (libKind === 'tv') {
    items = db.shows.filter(s => {
      if (q && !String(s.name).toLowerCase().includes(q)) return false;
      const w = countedEps(s), t = s.total_episodes || 0;
      const done = t > 0 && w >= t;
      if (libFilter === 'DROPPED') return s.dropped;
      if (s.dropped) return false;
      if (libFilter === 'WATCHED') return done;
      if (libFilter === 'WATCHING') return w > 0 && !done;
      return w === 0 && !done;
    });
    if (libSort === 'alpha') items.sort((a, b) => a.name.localeCompare(b.name));
    else if (libSort === 'prog') items.sort((a, b) =>
      (b.watched_episodes.length / (b.total_episodes || 1)) - (a.watched_episodes.length / (a.total_episodes || 1)));
    else items.sort((a, b) => String(b.first_air_date || '').localeCompare(String(a.first_air_date || '')));
  } else {
    items = db.movies.filter(m => {
      if (q && !String(m.name).toLowerCase().includes(q)) return false;
      const w = movieWatched(m.id);
      const soon = (m.release_date || '') > today;
      if (libFilter === 'DROPPED') return m.dropped;
      if (m.dropped) return false;
      if (libFilter === 'WATCHED') return w;
      if (libFilter === 'WATCHING') return soon && !w;
      return !w && !soon;
    });
    if (libSort === 'alpha') items.sort((a, b) => a.name.localeCompare(b.name));
    else items.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
  }

  if (!items.length) {
    v.appendChild(emptyState(q ? 'No matches' : 'Nothing here yet',
      q ? `Nothing in this tab matches “${libQuery}”.`
        : (libFilter === 'DROPPED' ? 'Shows you drop will collect here.' : 'Search for something to add it.'),
      q ? null : { label: 'Search', onClick: () => { view = 'search'; render(); } }));
    return;
  }

  v.appendChild(el('div', 'section-head',
    `${items.length} ${items.length === 1 ? 'title' : 'titles'}${q ? ` matching “${esc(libQuery)}”` : ''}`));

  // Backfill any missing artwork for what's on screen, then repaint once.
  healArtwork(items.slice(0, libLimit), libKind === 'tv' ? 'tv' : 'movie')
    .then(ok => { if (ok && view === 'library') renderLibrary(v); });

  const shown = items.slice(0, libLimit);
  const dropAction = (x, label) => [x.dropped ? 'Restore' : label, async () => {
    x.dropped = !x.dropped;
    invalidateFeeds();
    await guardedWrite('drop', () => savePayload());
    toast(x.dropped ? 'Dropped' : 'Restored');
    renderLibrary(v);
  }, !x.dropped];

  v.appendChild(gridOf(shown.map(x => libKind === 'tv'
    ? { title: x.name, poster: x.poster_path,
        progress: x.total_episodes ? countedEps(x) / x.total_episodes : -1,
        onOpen: () => isFootballShow(x) ? openFootball(x.id, x.name) : openShow(x.id, x.name),
        quick: { title: x.name, actions: [
          ['Open', () => isFootballShow(x) ? openFootball(x.id, x.name) : openShow(x.id, x.name)],
          dropAction(x, 'Drop show')] } }
    : { title: x.name, poster: x.poster_path, progress: movieWatched(x.id) ? 1 : -1,
        onOpen: () => openMovie(x.id, x.name),
        quick: { title: x.name, actions: [
          ['Open', () => openMovie(x.id, x.name)],
          [movieWatched(x.id) ? 'Unmark watched' : 'Mark watched', async () => {
            const on = movieWatched(x.id);
            if (await guardedWrite('toggle film', () => setMovie(x.id, !on, { name: x.name }))) {
              buzz(); toast(on ? 'Unmarked' : 'Logged'); renderLibrary(v);
            }
          }],
          dropAction(x, 'Drop')] } })));

  if (items.length > libLimit) {
    const more = el('button', 'btn', `Load ${Math.min(60, items.length - libLimit)} more`);
    more.style.cssText = 'width:100%;margin-top:10px';
    more.onclick = () => { libLimit += 60; renderLibrary(v); };
    v.appendChild(more);
  }
}

/* ---------------- donut charts (hand-rolled SVG, no dependency) ---------------- */

const CHART_COLORS = ['#FFC107', '#FF8A65', '#4FC3F7', '#AED581', '#BA68C8',
                      '#F06292', '#4DB6AC', '#FFD54F', '#90A4AE', '#A1887F'];

/** Counts -> labelled donut. Slices under 3% are folded into "Other" so the
    ring stays readable instead of fraying into slivers. */
function donut(counts, { limit = 8, size = 150 } = {}) {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return el('div', 'muted', 'Nothing logged yet.');

  const total = entries.reduce((n, [, v]) => n + v, 0);
  const keep = entries.slice(0, limit);
  const restSum = entries.slice(limit).reduce((n, [, v]) => n + v, 0);
  if (restSum) keep.push(['Other', restSum]);

  const r = size / 2 - 12, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const rings = keep.map(([label, n], i) => {
    const frac = n / total;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="${CHART_COLORS[i % CHART_COLORS.length]}" stroke-width="18"
      stroke-dasharray="${(frac * circ).toFixed(2)} ${circ.toFixed(2)}"
      stroke-dashoffset="${(-offset * circ).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"></circle>`;
    offset += frac;
    return seg;
  }).join('');

  const legend = keep.map(([label, n], i) =>
    `<div class="lg"><span style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
      <span>${esc(label)}</span><b>${Math.round(n / total * 100)}%</b></div>`).join('');

  return el('div', 'donut-wrap', `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
         aria-label="Distribution chart">${rings}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="#EDEDED"
            font-size="17" font-weight="800">${total}</text>
      <text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="#9A9A9A"
            font-size="8" letter-spacing="1.4">LOGGED</text>
    </svg><div class="legend">${legend}</div>`);
}

/** Star spread as a simple bar list — a donut of 1..5 reads worse than bars. */
function ratingBars() {
  const counts = [0, 0, 0, 0, 0];
  history.forEach(h => { if (h.rating > 0) counts[h.rating - 1]++; });
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return el('div', 'muted', 'No ratings yet.');
  const max = Math.max(...counts);
  return el('div', 'rbars', counts.map((n, i) =>
    `<div class="rbar"><span>${'★'.repeat(i + 1)}<i>${esc(RATING_WORDS[i + 1])}</i></span>
      <span class="track"><span style="width:${max ? n / max * 100 : 0}%"></span></span>
      <b>${n}</b></div>`).reverse().join(''));
}

/** Genre mix across your most-watched titles. TMDB ids only — football ids
    are not TMDB ids and would 404. */
async function genreMix() {
  const counts = {};
  history.forEach(h => { counts[h.type + ':' + h.item] = (counts[h.type + ':' + h.item] || 0) + 1; });
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 15)
    .map(k => k.split(':'))
    .filter(([, id]) => /^\d+$/.test(id));
  const genres = {};
  await mapLimit(top, 5, async ([type, id]) => {
    const d = await tmdb(`${type === 'tv' ? 'tv' : 'movie'}/${id}`);
    (d.genres || []).forEach(g => { genres[g.name] = (genres[g.name] || 0) + 1; });
  });
  return genres;
}

/* ============================================================
   History-powered views — only meaningful now the decade is back
   ============================================================ */

/** GitHub-contributions grid for one year: 53 columns, 7 rows. */
function yearGrid(year) {
  const counts = {};
  for (const h of history) {
    if (h.at.startsWith(String(year))) counts[h.at.slice(0, 10)] = (counts[h.at.slice(0, 10)] || 0) + 1;
  }
  const max = Math.max(1, ...Object.values(counts));
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  const lead = (start.getUTCDay() + 6) % 7;                 // Monday-first
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="yc pad"></span>');
  const months = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const n = counts[key] || 0;
    const lvl = !n ? 0 : n >= max * 0.75 ? 4 : n >= max * 0.5 ? 3 : n >= max * 0.25 ? 2 : 1;
    if (d.getUTCDate() === 1) months.push([cells.length, d.getUTCMonth()]);
    cells.push(`<span class="yc l${lvl}" title="${key}: ${n}"></span>`);
  }
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const labels = months.map(([idx, mi]) =>
    `<span style="grid-column:${Math.floor(idx / 7) + 1}">${names[mi]}</span>`).join('');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const active = Object.keys(counts).length;
  return `<div class="ygrid-wrap">
      <div class="ygrid-months">${labels}</div>
      <div class="ygrid">${cells.join('')}</div>
      <div class="muted">${total.toLocaleString()} watched across ${active} days</div>
    </div>`;
}

function historyYears() {
  const ys = new Set(history.map(h => h.at.slice(0, 4)).filter(y => /^\d{4}$/.test(y)));
  return [...ys].sort().reverse();
}

/** "Three years ago today…" */
function onThisDay() {
  const md = stamp().slice(5, 10);
  const hits = history.filter(h => h.at.slice(5, 10) === md && h.at.slice(0, 4) !== stamp().slice(0, 4));
  if (!hits.length) return null;
  const byYear = {};
  hits.forEach(h => { (byYear[h.at.slice(0, 4)] ||= []).push(h); });
  return byYear;
}

/** Strava-style personal bests, all derived from history. */
function personalRecords() {
  if (!history.length) return null;
  const byDate = {}, byYear = {};
  history.forEach(h => {
    byDate[h.at.slice(0, 10)] = (byDate[h.at.slice(0, 10)] || 0) + 1;
    byYear[h.at.slice(0, 4)] = (byYear[h.at.slice(0, 4)] || 0) + 1;
  });
  const dates = Object.keys(byDate).sort();
  let best = 0, run = 0, prev = null, gap = 0, gapFrom = '';
  for (const d of dates) {
    if (prev) {
      const diff = (new Date(d) - new Date(prev)) / 86400000;
      if (diff === 1) run++; else {
        run = 1;
        if (diff > gap) { gap = diff; gapFrom = prev; }
      }
    } else run = 1;
    best = Math.max(best, run);
    prev = d;
  }
  const topDay = Object.entries(byDate).sort((a, b) => b[1] - a[1])[0];
  const topYear = Object.entries(byYear).sort((a, b) => b[1] - a[1])[0];
  return {
    first: dates[0], last: dates[dates.length - 1],
    days: dates.length, streak: best,
    gap: Math.round(gap), gapFrom,
    topDay, topYear, total: history.length,
  };
}

/* ---------------- Me ---------------- */

async function renderMe(v) {
  v.innerHTML = '';
  v.appendChild(segmented(
    [['Stats', 'stats'], ['Year', 'year'], ['Records', 'records'],
     ['Diary', 'journal'], ['Recaps', 'recaps'], ['Health', 'health'], ['Data', 'data']],
    meTab, t => { meTab = t; renderMe(v); }, 4));
  const body = el('div');
  v.appendChild(body);
  if (meTab === 'year') renderYear(body);
  else if (meTab === 'records') renderRecords(body);
  else if (meTab === 'stats') renderStats(body);
  else if (meTab === 'health') await renderHealth(body);
  else if (meTab === 'journal') {
    renderJournal(body);
    buildFixtureIndex().then(() => {
      if (meTab === 'journal' && view === 'me') { body.innerHTML = ''; renderJournal(body); }
    }).catch(() => {});
  }
  else if (meTab === 'recaps') renderRecaps(body);
  else renderData(body);
}

let yearPick = null;

function renderYear(v) {
  const years = historyYears();
  if (!years.length) {
    v.appendChild(emptyState('No history yet', 'Mark something watched and your year fills in.'));
    return;
  }
  if (!yearPick || !years.includes(yearPick)) yearPick = years[0];
  v.appendChild(segmented(years.map(y => [y, y]), yearPick,
    y => { yearPick = y; renderMe($('#view').firstChild ? $('#view') : v); }, 4));
  v.insertAdjacentHTML('beforeend', yearGrid(+yearPick));

  const t = onThisDay();
  if (t) {
    v.appendChild(el('div', 'section-head', 'On this day'));
    Object.keys(t).sort().reverse().forEach(y => {
      const ago = +stamp().slice(0, 4) - +y;
      const items = t[y];
      const line = el('div', 'panel');
      line.innerHTML = `<div class="otd-year">${ago} year${ago > 1 ? 's' : ''} ago</div>` +
        items.slice(0, 4).map(h => {
          const o = h.type === 'tv' ? getShow(h.item) : getMovie(h.item);
          return `<div class="otd-row"><img src="${imgUrl(o?.poster_path, 'w185')}" alt="">
            <span><b>${esc(o?.name || 'Unknown')}</b><i>${esc(h.code || 'Film')}</i></span></div>`;
        }).join('') +
        (items.length > 4 ? `<div class="muted">and ${items.length - 4} more</div>` : '');
      v.appendChild(line);
    });
  }
}

function renderRecords(v) {
  const r = personalRecords();
  if (!r) { v.appendChild(emptyState('No records yet', 'Watch something and the numbers start.')); return; }
  const yrs = +r.last.slice(0, 4) - +r.first.slice(0, 4) + 1;
  v.appendChild(el('div', 'big-stat',
    `<b>${r.total.toLocaleString()}</b><span>things watched</span>
     <i>across ${yrs} years, on ${r.days.toLocaleString()} different days</i>`));
  v.appendChild(el('div', 'panel', '<div class="section-head">Personal bests</div>' + [
    ['🔥', 'Biggest single day', `${r.topDay[1]} on ${r.topDay[0]}`],
    ['🔗', 'Longest streak', `${r.streak} day${r.streak > 1 ? 's' : ''}`],
    ['🏆', 'Busiest year', `${r.topYear[0]} · ${r.topYear[1].toLocaleString()}`],
    ['🌵', 'Longest gap', r.gap ? `${humanizeDays(r.gap)} after ${r.gapFrom}` : '—'],
    ['🥇', 'First ever logged', r.first],
    ['🕘', 'Most recent', r.last],
  ].map(([i, l, val]) =>
    `<div class="fact"><span>${i}</span><span>${esc(l)}</span><b>${esc(String(val))}</b></div>`).join('')));
}

function renderStats(v) {
  let eps = 0, tvMins = 0;
  for (const s of db.shows) {
    const w = s.watched_episodes.length;
    eps += w;
    tvMins += w * (isFootballShow(s) ? MATCH_MINUTES : EPISODE_MINUTES);
  }
  const films = db.movies.filter(m => m.watched);
  const total = tvMins + films.reduce((n, m) => n + (m.runtime || MOVIE_MINUTES), 0);

  const rated = history.filter(h => h.rating > 0);
  const avg = (a) => a.length ? (a.reduce((n, h) => n + h.rating, 0) / a.length).toFixed(1) : '—';
  const plats = {}, feels = {}, dates = {};
  let nightOwl = 0;
  for (const h of history) {
    if (h.platform) plats[h.platform] = (plats[h.platform] || 0) + 1;
    if (h.feeling) feels[h.feeling] = (feels[h.feeling] || 0) + 1;
    const hour = +h.at.slice(11, 13);
    if (hour >= 1 && hour <= 5) nightOwl++;
    dates[h.at.slice(0, 10)] = (dates[h.at.slice(0, 10)] || 0) + 1;
  }
  const done = db.shows.filter(s => !s.dropped && s.total_episodes > 0 && countedEps(s) >= s.total_episodes).length;
  const flairs = [];
  if (nightOwl >= 10) flairs.push('🦉 Night Owl');
  if (Math.max(0, ...Object.values(dates)) >= 6) flairs.push('🍿 Marathoner');
  if (done >= 10) flairs.push('👑 Completionist');
  if (!flairs.length) flairs.push('🌱 Newcomer');

  const months = Math.floor(total / 43800);
  const days = Math.floor((total % 43800) / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const spent = months ? `${months} months, ${days} days` : days ? `${days} days, ${hours} hours` : `${hours} hours`;

  v.appendChild(el('div', 'big-stat',
    `<b>${(eps + films.length).toLocaleString()}</b><span>Things watched</span>
     <i>${esc(spent)} of your life on screen</i>`));

  v.appendChild(el('div', 'flairs', flairs.map(f => `<span class="chip">${esc(f)}</span>`).join('')));

  const facts = el('div', 'panel');
  facts.innerHTML = `<div class="section-head">The numbers</div>` + [
    ['📺', 'Episodes watched', eps.toLocaleString()],
    ['🎬', 'Films watched', films.length.toLocaleString()],
    ['📚', 'Shows in library', db.shows.filter(x => !x.dropped).length],
    ['🏁', 'Shows finished', db.shows.filter(x => !x.dropped && x.total_episodes > 0
        && countedEps(x) >= x.total_episodes).length],
    ['⭐', 'Average rating', rated.length
        ? `${avg(rated)} · ${RATING_WORDS[Math.round(avg(rated))] || ''}` : 'Not rated yet'],
    ['📡', 'Most used platform', topKey(plats)?.[0] || 'Not logged'],
    ['🎭', 'Signature mood', topKey(feels)?.[0] || 'Not logged'],
    ['🌙', 'Late-night watches', `${nightOwl}`],
  ].map(([i, l, val]) =>
    `<div class="fact"><span>${i}</span><span>${esc(l)}</span><b>${esc(String(val))}</b></div>`).join('');
  v.appendChild(facts);

  v.appendChild(el('div', 'section-head', 'Last 12 months'));
  v.appendChild(activityChart());
  v.appendChild(el('div', 'section-head', 'When you watch'));
  v.appendChild(heatmap());

  const plat = {}, mood = {};
  history.forEach(h => {
    if (h.platform) plat[h.platform] = (plat[h.platform] || 0) + 1;
    if (h.feeling) mood[h.feeling] = (mood[h.feeling] || 0) + 1;
  });

  v.appendChild(el('div', 'section-head', 'Platforms'));
  v.appendChild(donut(plat));
  v.appendChild(el('div', 'section-head', 'Moods'));
  v.appendChild(donut(mood));
  v.appendChild(el('div', 'section-head', 'Ratings'));
  v.appendChild(ratingBars());

  const dna = el('div');
  dna.innerHTML = '<div class="section-head">Taste profile</div><div class="muted">Reading genres…</div>';
  v.appendChild(dna);
  genreMix().then(g => {
    dna.innerHTML = '<div class="section-head">Taste profile</div>';
    dna.appendChild(Object.keys(g).length ? donut(g) : el('div', 'muted', 'Watch more to unlock this.'));
  }).catch(() => { dna.innerHTML = ''; });
}

function activityChart() {
  const months = [];
  const d = now();
  for (let i = 11; i >= 0; i--) {
    months.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  const vals = months.map(k => (db.analytics[k]?.tv || 0) + (db.analytics[k]?.movie || 0));
  const max = Math.max(1, ...vals);
  return el('div', 'chart', months.map((k, i) =>
    `<div class="bar-col"><span class="bar-val">${vals[i] || ''}</span>
      <span class="bar" style="height:${Math.max(Math.round(vals[i] / max * 100), 2)}%"></span>
      <span class="bar-lbl">${k.slice(5)}</span></div>`).join(''));
}

function heatmap() {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const grid = {};
  for (const h of history) {
    const dt = new Date(h.at.replace(' ', 'T') + 'Z');
    if (isNaN(dt)) continue;
    grid[`${(dt.getUTCDay() + 6) % 7}-${Math.floor(dt.getUTCHours() / 3)}`] =
      (grid[`${(dt.getUTCDay() + 6) % 7}-${Math.floor(dt.getUTCHours() / 3)}`] || 0) + 1;
  }
  const max = Math.max(1, ...Object.values(grid));
  let html = '<div class="heat">';
  for (let d = 0; d < 7; d++) {
    html += `<span class="heat-lbl">${DAYS[d]}</span>`;
    for (let b = 0; b < 8; b++) {
      const n = grid[`${d}-${b}`] || 0;
      const a = n ? (0.15 + 0.85 * (n / max)).toFixed(2) : 0;
      html += `<span class="heat-cell" title="${DAYS[d]} ${b * 3}:00 — ${n}" style="background:rgba(255,193,7,${a})"></span>`;
    }
  }
  return el('div', null, html + '</div><div class="heat-axis"><span>00</span><span>12</span><span>21</span></div>');
}

async function renderHealth(v) {
  let totalEp = 0, watchedEp = 0, backlogMins = 0;
  const almost = [], stale = [];

  for (const s of db.shows) {
    if (s.dropped) continue;
    let total;
    if (isFootballShow(s)) {
      const [code, season] = parseFootballId(s.id);
      const days = await footballMatchdays(code, season);
      total = Object.values(days).reduce((n, g) => n + g.filter(x => x.started).length, 0);
    } else {
      total = s.total_episodes || 1;
    }
    const w = Math.min(countedEps(s), total);   // never exceed what exists
    totalEp += total; watchedEp += w;
    const rem = Math.max(0, total - w);
    backlogMins += rem * (isFootballShow(s) ? MATCH_MINUTES : EPISODE_MINUTES);
    if (rem > 0 && rem <= 3 && !isFootballShow(s)) almost.push({ id: s.id, name: s.name, rem, poster: s.poster_path });

    if (!isFootballShow(s) && w > 0 && rem > 0) {
      const last = history.filter(h => h.type === 'tv' && h.item === String(s.id)).map(h => h.at).sort().pop();
      if (last) {
        const age = Math.round((now() - new Date(last.replace(' ', 'T') + 'Z')) / 86400000);
        if (age > 90) stale.push({ id: s.id, name: s.name, age, poster: s.poster_path, rem });
      }
    }
  }

  const totalMov = db.movies.filter(m => !m.dropped).length;
  const watchedMov = db.movies.filter(m => m.watched && !m.dropped).length;
  backlogMins += (totalMov - watchedMov) * MOVIE_MINUTES;

  const c30 = new Date(now().getTime() - 30 * 86400000);
  const c7 = new Date(now().getTime() - 7 * 86400000);
  let mins30 = 0, eps7 = 0, mins7 = 0;
  const dates = new Set();
  for (const h of history) {
    const dt = new Date(h.at.replace(' ', 'T') + 'Z');
    if (isNaN(dt)) continue;
    dates.add(h.at.slice(0, 10));
    const mins = h.type === 'tv' ? EPISODE_MINUTES : MOVIE_MINUTES;
    if (dt >= c30) mins30 += mins;
    if (dt >= c7) { mins7 += mins; if (h.type === 'tv') eps7++; }
  }
  const perDay = mins30 > 0 ? mins30 / 30 : 0;
  const daysToClear = perDay > 0 ? Math.round(backlogMins / perDay) : null;

  let streak = 0, cur = new Date(now());
  if (!dates.has(stamp(cur).slice(0, 10))) cur = new Date(cur.getTime() - 86400000);
  while (dates.has(stamp(cur).slice(0, 10))) { streak++; cur = new Date(cur.getTime() - 86400000); }

  let best = 0, run = 0, prev = null;
  for (const d of [...dates].sort()) {
    if (prev && (new Date(d) - new Date(prev)) === 86400000) run++; else run = 1;
    best = Math.max(best, run); prev = d;
  }

  const items = totalEp + totalMov;
  const pct = items ? Math.round(((watchedEp + watchedMov) / items) * 100) : 0;

  // completion ring
  const R = 52, C = 2 * Math.PI * R;
  v.appendChild(el('div', 'ring-wrap', `
    <svg viewBox="0 0 130 130" width="130" height="130">
      <circle cx="65" cy="65" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/>
      <circle cx="65" cy="65" r="${R}" fill="none" stroke="url(#g)" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${(pct / 100 * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 65 65)"/>
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#FFD54F"/><stop offset="100%" stop-color="#FFC107"/></linearGradient></defs>
      <text x="65" y="62" text-anchor="middle" fill="#EDEDED" font-size="26" font-weight="800">${pct}%</text>
      <text x="65" y="80" text-anchor="middle" fill="#9A9A9A" font-size="9" letter-spacing="1.5">WATCHED</text>
    </svg>
    <div class="ring-side">
      <div class="kv"><span>Backlog</span><b>${humanizeDays(Math.round(backlogMins / 1440))}</b></div>
      <div class="kv"><span>At current pace</span><b>${daysToClear == null ? '—' : humanizeDays(daysToClear)}</b></div>
      <div class="kv"><span>Unwatched</span><b>${(totalEp - watchedEp + totalMov - watchedMov).toLocaleString()}</b></div>
    </div>`));

  v.appendChild(statCards([
    [eps7, 'eps', 'This week'],
    [Math.round(mins7 / 60), 'h', 'Hours this week'],
    [Math.round(perDay), 'm', 'Daily average']]));
  v.appendChild(statCards([
    [humanizeDays(streak), '', 'Current streak'],
    [humanizeDays(best), '', 'Longest streak'],
    [dates.size, '', 'Active days']]));

  const rowFor = (x, sub) => {
    const b = el('button', 'mini');
    b.innerHTML = `<img src="${imgUrl(x.poster, 'w185')}" alt="">
      <span><b>${esc(x.name)}</b><i>${esc(sub)}</i></span><span class="ch">›</span>`;
    b.onclick = () => openShow(x.id, x.name);
    return b;
  };

  if (almost.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'section-head', `Finish these · ${almost.length}`));
    panel.appendChild(el('div', 'muted', 'Three episodes or fewer to go.'));
    almost.sort((a, b) => a.rem - b.rem).slice(0, 6)
      .forEach(x => panel.appendChild(rowFor(x, `${x.rem} episode${x.rem > 1 ? 's' : ''} left`)));
    v.appendChild(panel);
  }

  if (stale.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'section-head', `Gone cold · ${stale.length}`));
    panel.appendChild(el('div', 'muted', 'Started, then untouched for over three months. Finish or drop.'));
    stale.sort((a, b) => b.age - a.age).slice(0, 6)
      .forEach(x => panel.appendChild(rowFor(x, `${humanizeDays(x.age)} ago · ${x.rem} left`)));
    v.appendChild(panel);
  }

  if (!almost.length && !stale.length) {
    v.appendChild(el('div', 'panel',
      '<div class="section-head">Nothing needs attention</div>' +
      '<div class="muted">No shows are nearly finished or gone stale. Tidy library.</div>'));
  }
}

/* Football journal rows stored S5E2, which means nothing on its own.
   Resolve those to "Arsenal vs Chelsea" using the cached fixtures. */
let fixtureIndex = {};

async function buildFixtureIndex() {
  const needed = new Set();
  for (const h of history) {
    if (h.type !== 'tv') continue;
    const show = getShow(h.item);
    if (isFootballShow(show)) needed.add(show.id);
  }
  for (const id of needed) {
    const [code, season] = parseFootballId(id);
    const days = await footballMatchdays(code, season);
    for (const [md, games] of Object.entries(days)) {
      games.forEach((g, i) => { fixtureIndex[`${id}|S${md}E${i + 1}`] = matchLabel(g); });
    }
  }
}

let diaryQuery = '';

function renderJournal(v) {
  const wrap = el('div', 'search-wrap');
  const input = el('input');
  input.type = 'search';
  input.placeholder = 'Search your history…';
  input.value = diaryQuery;
  wrap.appendChild(input);
  v.appendChild(wrap);
  input.addEventListener('input', () => {
    diaryQuery = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const holder = v.parentElement;
      holder.innerHTML = ''; renderJournal(holder);
      const box = holder.querySelector('input'); if (box) { box.focus(); box.setSelectionRange(999, 999); }
    }, 250);
  });
  renderDiary(v);
}

function renderDiary(v) {
  if (!history.length) {
    v.appendChild(emptyState('No history yet', 'Mark something watched and it appears here.'));
    return;
  }
  const q = diaryQuery.trim().toLowerCase();
  const rows = q
    ? history.filter(h => {
        const o = h.type === 'tv' ? getShow(h.item) : getMovie(h.item);
        return String(o?.name || '').toLowerCase().includes(q)
            || String(h.code || '').toLowerCase().includes(q)
            || String(h.platform || '').toLowerCase().includes(q);
      })
    : history;

  if (q) {
    const first = rows.length ? rows[rows.length - 1] : null;
    v.appendChild(el('div', 'muted', rows.length
      ? `${rows.length.toLocaleString()} matches · first on ${first.at.slice(0, 10)}`
      : 'No matches.'));
  }

  let month = '';
  for (const h of rows.slice(0, journalLimit)) {
    const m = h.at.slice(0, 7);
    if (m !== month) { month = m; v.appendChild(el('div', 'section-head', prettyMonth(m))); }
    const isTv = h.type === 'tv';
    const obj = isTv ? getShow(h.item) : getMovie(h.item);
    const b = el('button', 'log');
    const art = imgUrl(obj?.poster_path, 'w185');
    b.innerHTML = `${art ? `<span class="log-wash" style="background-image:url('${art}')"></span>` : ''}
      <img loading="lazy" src="${art}" alt=""
        style="object-fit:${isAbs(obj?.poster_path) ? 'contain' : 'cover'}">
      <span class="log-main"><span class="log-name">${esc(obj?.name || 'Unknown')}</span>
        <span class="log-meta">${esc(h.at.slice(0, 16))}</span><br>
        ${h.code ? `<span class="chip">${esc(fixtureIndex[`${h.item}|${h.code}`] || h.code)}</span>`
                 : '<span class="chip">Film</span>'}
        ${h.cycle > 1 ? `<span class="chip plain">↻ rewatch ${h.cycle}</span>` : ''}
        ${h.rating ? `<span class="chip plain">${'★'.repeat(h.rating)}</span>` : ''}
        ${h.platform ? `<span class="chip plain">${esc(h.platform)}</span>` : ''}
        ${h.feeling ? `<span class="chip plain">${esc(h.feeling)}</span>` : ''}</span>`;
    b.onclick = () => isTv
      ? (isFootballShow(obj) ? openFootball(h.item, obj?.name || '') : openEpisode(h.item, obj?.name || '', h.code))
      : openMovie(h.item, obj?.name || '');
    v.appendChild(b);
  }
  v.appendChild(el('div', 'muted',
    `Showing ${Math.min(journalLimit, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`));
  if (rows.length > journalLimit) {
    const more = el('button', 'btn', 'Load 100 more');
    more.style.width = '100%';
    more.onclick = () => { journalLimit += 100; render(); };
    v.appendChild(more);
    const all = el('button', 'btn', 'Show everything');
    all.style.cssText = 'width:100%;margin-top:8px';
    all.onclick = () => { journalLimit = rows.length; render(); };
    v.appendChild(all);
  }
}

/* ---------------- recaps ---------------- */

function pendingRecaps() {
  const seen = new Set(db.seen_recaps || []);
  const thisMonth = stamp().slice(0, 7);
  const out = [];
  for (const key of Object.keys(db.analytics).sort()) {
    if (key >= thisMonth) continue;
    const id = `monthly-${key}`;
    if (seen.has(id)) continue;
    const st = db.analytics[key] || {};
    if ((st.tv || 0) + (st.movie || 0) <= 0) continue;
    out.push({ kind: 'month', key, id, sort: key });
  }
  for (const y of [...new Set(Object.keys(db.analytics).map(k => k.slice(0, 4)))].sort()) {
    if (+y >= now().getUTCFullYear()) continue;
    const id = `yearly-${y}`;
    if (seen.has(id)) continue;
    const rows = Object.entries(db.analytics).filter(([k]) => k.startsWith(y));
    const tv = rows.reduce((n, [, v]) => n + (v.tv || 0), 0);
    const mv = rows.reduce((n, [, v]) => n + (v.movie || 0), 0);
    if (tv + mv <= 0) continue;
    out.push({ kind: 'year', key: y, id, sort: y + '-13' });
  }
  return out.sort((a, b) => a.sort.localeCompare(b.sort));
}

function recapRow(icon, title, sub, isNew, onOpen) {
  const b = el('button', 'recap-row' + (isNew ? ' new' : ''));
  b.innerHTML = `<span class="ic">${icon}</span>
    <span class="tx"><b>${esc(title)}</b><i>${esc(sub)}</i></span><span class="ch">›</span>`;
  b.onclick = onOpen;
  return b;
}

function recapSubtitle(id, key) {
  if (id.startsWith('monthly')) {
    const st = db.analytics[key] || {};
    return `${st.tv || 0} episodes · ${st.movie || 0} films`;
  }
  const rows = Object.entries(db.analytics).filter(([k]) => k.startsWith(key));
  const tv = rows.reduce((n, [, v]) => n + (v.tv || 0), 0);
  const mv = rows.reduce((n, [, v]) => n + (v.movie || 0), 0);
  return `${tv} episodes · ${mv} films`;
}

function prettyMonth(key) {
  const [y, m] = key.split('-');
  const names = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
  return `${names[+m - 1] || key} ${y}`;
}

function renderRecaps(v) {
  const pending = pendingRecaps();
  if (pending.length) {
    v.appendChild(el('div', 'section-head', `Ready for you · ${pending.length}`));
    pending.forEach(r => v.appendChild(recapRow(
      r.kind === 'month' ? '🌙' : '🏆',
      r.kind === 'month' ? prettyMonth(r.key) : `${r.key} in review`,
      recapSubtitle(r.id, r.key), true,
      () => r.kind === 'month' ? openMonthRecap(r.key, r.id) : openYearRecap(r.key, r.id))));
  }

  const seen = (db.seen_recaps || []).slice().sort().reverse();
  if (!seen.length && !pending.length) {
    v.appendChild(emptyState('No recaps yet',
      'Monthly and yearly wraps unlock on their own once a period ends.'));
    return;
  }
  if (seen.length) {
    v.appendChild(el('div', 'section-head', `Archive · ${seen.length}`));
    seen.forEach(id => {
      const key = id.replace(/^(monthly|yearly)-/, '');
      const isMonth = id.startsWith('monthly');
      v.appendChild(recapRow(isMonth ? '📅' : '🏆',
        isMonth ? prettyMonth(key) : `${key} in review`,
        recapSubtitle(id, key), false,
        () => isMonth ? openMonthRecap(key, id) : openYearRecap(key, id)));
    });
  }
}

async function markRecapSeen(id) {
  if (!(db.seen_recaps || []).includes(id)) {
    (db.seen_recaps ||= []).push(id);
    await savePayload();
  }
}

/** Poster wall behind the recap header — your actual year, not a gradient. */
function recapCollage(counts) {
  let posters = Object.keys(counts)
    .map(id => getShow(id)).filter(s => s && s.poster_path && !isAbs(s.poster_path))
    .slice(0, 12).map(s => imgUrl(s.poster_path, 'w185'));

  // Journal entries can be missing for older periods while the totals survive.
  // Fall back to the shows you've watched most, so the wall is never empty.
  if (posters.length < 3) {
    posters = db.shows
      .filter(x => !x.dropped && x.poster_path && !isAbs(x.poster_path) && x.watched_episodes.length)
      .sort((a, b) => b.watched_episodes.length - a.watched_episodes.length)
      .slice(0, 12).map(x => imgUrl(x.poster_path, 'w185'));
  }
  if (posters.length < 3) return '';
  while (posters.length < 12) posters.push(...posters.slice(0, 12 - posters.length));
  return `<div class="collage">${posters.map(p => `<img src="${p}" alt="">`).join('')}</div>`;
}

function recapSlide(title, body) {
  return `<div class="slide"><div class="slide-t">${esc(title)}</div>${body}</div>`;
}

const recapHero = (big, cap, sub) =>
  `<div class="recap-hero"><div class="rh-big">${esc(big)}</div><div class="rh-cap">${esc(cap)}</div>
   ${sub ? `<div class="rh-sub">${esc(sub)}</div>` : ''}</div>`;

const recapFacts = (rows) => !rows.length ? '' :
  '<div class="facts">' + rows.map(([i, l, v]) =>
    `<div class="fact"><span>${i}</span><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join('') + '</div>';

function recapPodium(counts, limit, fallbackLabel) {
  let entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  let unit = 'episodes';
  if (!entries.length && fallbackLabel) {
    // No journal detail for this period — show all-time favourites instead,
    // clearly labelled rather than silently pretending it's period data.
    entries = db.shows.filter(x => !x.dropped && x.watched_episodes.length)
      .sort((a, b) => b.watched_episodes.length - a.watched_episodes.length)
      .slice(0, limit).map(x => [String(x.id), x.watched_episodes.length]);
    unit = 'episodes all time';
  }
  const cards = entries.map(([sid, n], i) => {
    const s = getShow(sid);
    if (!s) return '';
    return `<div class="podium"><span class="rank">${i + 1}</span>
      <img src="${imgUrl(s.poster_path, 'w185')}" style="object-fit:${isAbs(s.poster_path) ? 'contain' : 'cover'}" alt="">
      <span><b>${esc(s.name)}</b><i>${n} ${unit}</i></span></div>`;
  }).filter(Boolean).join('');
  return cards ? `<div class="facts">${cards}</div>` : '';
}

function sliceHistory(prefix) {
  const shows = {}, plats = {}, feels = {}, days = {}, ratings = [];
  for (const h of history) {
    if (!h.at.startsWith(prefix)) continue;
    if (h.type === 'tv') shows[h.item] = (shows[h.item] || 0) + 1;
    if (h.platform) plats[h.platform] = (plats[h.platform] || 0) + 1;
    if (h.feeling) feels[h.feeling] = (feels[h.feeling] || 0) + 1;
    if (h.rating > 0) ratings.push(h.rating);
    days[h.at.slice(0, 10)] = (days[h.at.slice(0, 10)] || 0) + 1;
  }
  return { shows, plats, feels, days, ratings };
}

/** Calendar strip: one dot per day of the month, brighter the more you watched. */
function monthDayStrip(key) {
  const [y, m] = key.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const counts = {};
  history.forEach(h => { if (h.at.startsWith(key)) counts[+h.at.slice(8, 10)] = (counts[+h.at.slice(8, 10)] || 0) + 1; });
  const max = Math.max(1, ...Object.values(counts));
  const active = Object.keys(counts).length;
  if (!active) return '';
  let cells = '';
  for (let d = 1; d <= days; d++) {
    const n = counts[d] || 0;
    const a = n ? (0.2 + 0.8 * (n / max)).toFixed(2) : 0;
    cells += `<span title="${d}: ${n}" style="background:rgba(255,193,7,${a})"></span>`;
  }
  return `<div class="section-head">Every day</div>
    <div class="daystrip">${cells}</div>
    <div class="muted">Watched on ${active} of ${days} days</div>`;
}

/** Month-by-month bars for the year recap. */
function yearMonthChart(year) {
  const names = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  const vals = names.map((_, i) => {
    const k = `${year}-${String(i + 1).padStart(2, '0')}`;
    const a = db.analytics[k] || {};
    return (a.tv || 0) + (a.movie || 0);
  });
  if (!vals.some(Boolean)) return '';
  const max = Math.max(...vals);
  const bars = vals.map((n, i) =>
    `<div class="bar-col"><span class="bar-val">${n || ''}</span>
      <span class="bar" style="height:${Math.max(Math.round(n / max * 100), 2)}%"></span>
      <span class="bar-lbl">${names[i]}</span></div>`).join('');
  return `<div class="section-head">Month by month</div><div class="chart">${bars}</div>`;
}

/** Things that happened, not just totals — the part Refract does well. */
function yearMilestones(year) {
  const inYear = history.filter(h => h.at.startsWith(String(year)));
  if (!inYear.length) return '';

  const firstSeen = {}, rows = [];
  history.forEach(h => {
    if (h.type !== 'tv') return;
    const cur = firstSeen[h.item];
    if (!cur || h.at < cur) firstSeen[h.item] = h.at;
  });
  const started = Object.entries(firstSeen).filter(([, at]) => at.startsWith(String(year))).length;

  const finished = db.shows.filter(s => !s.dropped && s.total_episodes > 0
    && s.watched_episodes.length >= s.total_episodes
    && history.some(h => h.type === 'tv' && h.item === String(s.id) && h.at.startsWith(String(year)))).length;

  const films = inYear.filter(h => h.type === 'movie').length;
  const sorted = inYear.map(h => h.at).sort();
  const dates = new Set(inYear.map(h => h.at.slice(0, 10)));

  let best = 0, run = 0, prev = null;
  for (const d of [...dates].sort()) {
    if (prev && (new Date(d) - new Date(prev)) === 86400000) run++; else run = 1;
    best = Math.max(best, run); prev = d;
  }

  if (started) rows.push(['🌱', 'New shows started', started]);
  if (finished) rows.push(['🏁', 'Shows finished', finished]);
  if (films) rows.push(['🎬', 'Films watched', films]);
  rows.push(['📆', 'Days with something watched', dates.size]);
  if (best > 1) rows.push(['🔗', 'Longest streak', `${best} days`]);
  rows.push(['🥇', 'First of the year', sorted[0].slice(0, 10)]);
  rows.push(['🔚', 'Last of the year', sorted[sorted.length - 1].slice(0, 10)]);

  return '<div class="section-head">Milestones</div>' + recapFacts(rows);
}

function openMonthRecap(key, id) {
  const st = db.analytics[key] || { tv: 0, movie: 0 };
  const { shows, plats, feels, days, ratings } = sliceHistory(key);
  const mins = st.tv * EPISODE_MINUTES + st.movie * MOVIE_MINUTES;
  const total = st.tv + st.movie;
  const active = Object.keys(days).length;
  const [y, m] = key.split('-').map(Number);
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const busiest = topKey(days);
  const avgR = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const strip = monthDayStrip(key).replace(/<div class="section-head">.*?<\/div>/, '');

  const facts = [
    avgR ? ['⭐', 'Average rating', `${avgR.toFixed(1)} · ${RATING_WORDS[Math.round(avgR)] || ''}`] : null,
    topKey(plats) ? ['📡', 'Mostly on', topKey(plats)[0]] : null,
    topKey(feels) ? ['🎭', 'Felt like', topKey(feels)[0]] : null,
    busiest ? ['🔥', 'Biggest day', `${busiest[1]} on the ${+busiest[0].slice(8)}`] : null,
  ].filter(Boolean);

  openStory([
    slideHero('Monthly Wrap-Up', prettyMonth(key), total.toLocaleString(),
      `things watched · about ${Math.floor(mins / 60)} hours`, recapCollage(shows)),
    slideStat('The Shape of It', `${st.tv}`, 'episodes',
      `<div class="split">
         <div><b>${st.movie}</b><span>films</span></div>
         <div><b>${active}<i>/${inMonth}</i></b><span>days active</span></div>
         <div><b>${Math.floor(mins / 60)}</b><span>hours</span></div>
       </div>`),
    active ? slideBlock('Every Day', 'When You Watched', strip) : null,
    Object.keys(shows).length || db.shows.some(x => x.watched_episodes.length)
      ? slideBlock('On Repeat',
          Object.keys(shows).length ? 'What You Kept Coming Back To' : 'Your Most-Watched Shows',
          recapPodium(shows, 3, true)) : null,
    facts.length ? slideBlock('The Details', 'How It Felt', recapFacts(facts)) : null,
    slideStat('That Was', prettyMonth(key), 'wrapped'),
  ], () => markRecapSeen(id).then(render));
}

function openYearRecap(year, id) {
  const rows = Object.entries(db.analytics).filter(([k]) => k.startsWith(year));
  const tv = rows.reduce((n, [, v]) => n + (v.tv || 0), 0);
  const mv = rows.reduce((n, [, v]) => n + (v.movie || 0), 0);
  const { shows, plats, feels, days, ratings } = sliceHistory(year);
  const mins = tv * EPISODE_MINUTES + mv * MOVIE_MINUTES;
  const dayCount = Math.floor(mins / 1440);
  const avgR = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0;
  const busiest = topKey(days);

  const months = {};
  history.forEach(h => { if (h.at.startsWith(year)) months[h.at.slice(0, 7)] = (months[h.at.slice(0, 7)] || 0) + 1; });
  const peak = topKey(months);
  const chart = yearMonthChart(year).replace(/<div class="section-head">.*?<\/div>/, '');
  const miles = yearMilestones(year).replace(/<div class="section-head">.*?<\/div>/, '');

  const tier = dayCount > 12 ? ['👑', 'Emperor of the Couch', 'Hollywood should put you on the payroll.']
             : dayCount > 5 ? ['🍿', 'Marathon Veteran', 'You lock down a weekend and finish what you start.']
             : ['🎬', 'Curation Connoisseur', 'Selective. You watch what is worth watching.'];

  const facts = [
    avgR ? ['⭐', 'Average rating', `${avgR.toFixed(1)} · ${RATING_WORDS[Math.round(avgR)] || ''}`] : null,
    topKey(plats) ? ['📡', 'Home base', topKey(plats)[0]] : null,
    topKey(feels) ? ['🎭', 'Signature mood', topKey(feels)[0]] : null,
    peak ? ['📈', 'Busiest month', `${prettyMonth(peak[0]).split(' ')[0]} · ${peak[1]}`] : null,
    busiest ? ['🔥', 'Biggest day', `${busiest[1]} on ${busiest[0]}`] : null,
  ].filter(Boolean);

  openStory([
    slideHero('Year in Review', year, (tv + mv).toLocaleString(),
      `things watched · ${dayCount} days on screen`, recapCollage(shows)),
    slideStat('Episodes', tv.toLocaleString(), 'across the year',
      `<div class="split">
         <div><b>${mv.toLocaleString()}</b><span>films</span></div>
         <div><b>${Object.keys(days).length}</b><span>days active</span></div>
         <div><b>${Math.floor(mins / 60).toLocaleString()}</b><span>hours</span></div>
       </div>`),
    chart ? slideBlock('Across the Year', 'Month by Month', chart) : null,
    slideBlock('On Repeat',
      Object.keys(shows).length ? 'Your Top Shows' : 'Your Most-Watched Shows',
      recapPodium(shows, 5, true)),
    miles ? slideBlock('Milestones', 'What Happened', miles) : null,
    facts.length ? slideBlock('The Details', 'How It Felt', recapFacts(facts)) : null,
    { html: `<div class="sl-mid">
        <div class="sl-badge">${tier[0]}</div>
        <div class="sl-h2">${esc(tier[1])}</div>
        <div class="sl-sub">${esc(tier[2])}</div>
      </div>` },
  ], () => markRecapSeen(id).then(render));
}

function dataRow(title, sub, label, onClick, gold) {
  const row = el('div', 'data-row');
  row.innerHTML = `<span class="tx"><b>${esc(title)}</b><i>${esc(sub)}</i></span>`;
  const b = el('button', 'btn' + (gold ? ' gold' : ''), label);
  b.onclick = () => onClick(b);
  row.appendChild(b);
  return row;
}

function renderData(v) {
  const shows = db.shows.filter(x => !x.dropped).length;
  const eps = db.shows.reduce((n, x) => n + x.watched_episodes.length, 0);

  const summary = el('div', 'panel');
  summary.innerHTML = `<div class="section-head">Your data</div>
    <div class="kv"><span>Shows tracked</span><b>${shows}</b></div>
    <div class="kv"><span>Films tracked</span><b>${db.movies.filter(x => !x.dropped).length}</b></div>
    <div class="kv"><span>Episodes logged</span><b>${eps.toLocaleString()}</b></div>
    <div class="kv"><span>History entries</span><b>${history.length.toLocaleString()}</b></div>
    <div class="kv"><span>Months of analytics</span><b>${Object.keys(db.analytics).length}</b></div>
    <div class="kv"><span>Recaps unlocked</span><b>${(db.seen_recaps || []).length}</b></div>`;
  v.appendChild(summary);

  const backup = el('div', 'panel');
  backup.appendChild(el('div', 'section-head', 'Backup'));
  backup.appendChild(dataRow('Download everything',
    'Library, history and analytics as one JSON file. Keep a copy before big changes.',
    'Download', () => {
      const blob = new Blob([JSON.stringify({ exported_at: stamp(), build: BUILD, ...db, history }, null, 2)],
        { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mytvtime-${stamp().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Backup downloaded');
    }, true));
  v.appendChild(backup);

  const repair = el('div', 'panel');
  repair.appendChild(el('div', 'section-head', 'Repair'));
  repair.appendChild(dataRow('Recount monthly totals',
    'Rebuilds the Activity chart and recap numbers from your history. Use if totals look doubled.',
    'Recount', async (b) => {
      b.disabled = true;
      const a = {};
      for (const h of history) {
        if (h.at.length < 7) continue;
        const bucket = (a[h.at.slice(0, 7)] ||= { tv: 0, movie: 0 });
        bucket[h.type === 'tv' ? 'tv' : 'movie']++;
      }
      db.analytics = a;
      await savePayload();
      toast(`Recounted ${Object.keys(a).length} months`);
      render();
    }));
  const over = db.shows.filter(isMismatched);
  repair.appendChild(dataRow('Refresh episode totals',
    'Re-reads episode counts from TMDB. Fixes shows where TMDB has since added episodes.',
    'Refresh', async (b) => {
      b.disabled = true; b.textContent = 'Working…';
      const targets = over.length ? over : db.shows.filter(x => !x.dropped && !isFootballShow(x));
      let fixed = 0;
      await mapLimit(targets, 5, async (x) => {
        const d = await tmdb(`tv/${x.id}`);
        const n = d?.number_of_episodes;
        if (n && n !== x.total_episodes) { x.total_episodes = n; fixed++; }
      });
      if (fixed) { invalidateFeeds(); await guardedWrite('totals', () => savePayload()); }
      toast(fixed ? `Updated ${fixed} shows` : 'Everything already current');
      render();
    }));
  if (over.length) {
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'section-head', `Mismatched · ${over.length}`));
    panel.appendChild(el('div', 'muted',
      'More episodes watched than these shows contain. Usually the import matched '
      + 'the wrong TMDB entry, or an anthology is split differently there. '
      + 'Refreshing totals will not fix it — open one to check.'));
    const fixBtn = el('button', 'btn gold');
    fixBtn.style.cssText = 'width:100%;margin:10px 0 4px';
    fixBtn.textContent = 'Scan and clean up';
    const out = el('div', 'muted');
    fixBtn.onclick = async () => {
      fixBtn.disabled = true; out.textContent = 'Checking each show against TMDB…';
      const results = await scanPhantoms((d, t) => { out.textContent = `Checking ${d}/${t}…`; });
      if (!results.length) { out.textContent = 'Nothing to remove — every episode exists.'; fixBtn.disabled = false; return; }
      const total = results.reduce((n, r) => n + r.bad.length, 0);
      const lines = results.map(r =>
        `• ${r.show.name}: remove ${r.bad.length} (keeping ${r.kept} of ${r.real})`).join('\n');
      if (!confirm(`Remove ${total} episodes that don't exist in TMDB?\n\n${lines}\n\nYour watch history rows for them are deleted too. This cannot be undone — download a backup first if unsure.`)) {
        fixBtn.disabled = false; out.textContent = 'Cancelled — nothing changed.'; return;
      }
      out.textContent = 'Removing…';
      const res = await applyPhantomFix(results);
      buzz(20);
      toast(`Removed ${res.episodes} episodes`);
      render();
    };
    panel.appendChild(fixBtn);
    panel.appendChild(out);

    over.sort((a, b) => (countedEps(b) - b.total_episodes) - (countedEps(a) - a.total_episodes))
      .slice(0, 12).forEach(x => {
        const b = el('button', 'mini');
        b.innerHTML = `<img src="${imgUrl(x.poster_path, 'w185')}" alt="">
          <span><b>${esc(x.name)}</b><i>${countedEps(x)} watched · ${x.total_episodes} exist
          (+${countedEps(x) - x.total_episodes})</i></span><span class="ch">›</span>`;
        b.onclick = () => openShow(x.id, x.name);
        panel.appendChild(b);
      });
    v.appendChild(panel);
  }

  repair.appendChild(dataRow('Rebuild feeds',
    'Clears the cached Up Next and Coming Soon results and recomputes them.',
    'Rebuild', () => { invalidateFeeds(); toast('Feeds cleared'); render(); }));
  v.appendChild(repair);

  if (footballEnabled()) {
    const foot = el('div', 'panel');
    foot.appendChild(el('div', 'section-head', 'Football'));
    const out = el('div', 'muted', "Fixtures come from Supabase, filled by the Streamlit app — the football API blocks browsers, so the phone can't fetch them directly.");
    foot.appendChild(dataRow('Check fixture cache',
      'Reads what Streamlit has stored in Supabase.', 'Check',
      async (b) => {
        b.disabled = true; out.textContent = 'Checking…';
        try {
          const rows = await sb('football_cache?select=competition,season,updated_at&order=updated_at.desc');
          out.innerHTML = rows && rows.length
            ? rows.map(r => `<b style="color:#8BC34A">${esc(r.competition)} ${r.season}</b> — synced ${esc(String(r.updated_at).slice(0, 16).replace('T', ' '))}`).join('<br>')
            : '<b style="color:#ff8a80">Empty.</b> Open Streamlit → Profile → Import → Football sync and push a season.';
        } catch (e) {
          out.innerHTML = `<b style="color:#ff8a80">${esc(e.message)}</b>`;
        }
        b.disabled = false;
      }));
    foot.appendChild(out);
    v.appendChild(foot);
  }

  const app = el('div', 'panel');
  app.appendChild(el('div', 'section-head', 'App'));
  app.innerHTML += `<div class="kv"><span>Build</span><b>${esc(BUILD)}</b></div>`;
  app.appendChild(dataRow('Force update',
    'Unregisters the service worker, clears every cache and reloads. Your keys and data are untouched.',
    'Update', async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        Object.keys(localStorage).filter(k => k.startsWith('tmdb:') || k.startsWith('fb:')
          || k.startsWith('fbfail:') || k === 'mytv.feeds').forEach(k => localStorage.removeItem(k));
      } catch { /* best effort */ }
      location.reload(true);
    }, true));
  app.appendChild(dataRow('Disconnect this device',
    'Removes your keys from this phone. Nothing in Supabase changes.',
    'Sign out', () => {
      if (confirm('Remove your keys from this device? Your data in Supabase is untouched.')) {
        localStorage.removeItem(CFG_KEY); location.reload();
      }
    }));
  v.appendChild(app);
}

/* ============================================================
   Recap stories — Spotify-Wrapped style paging.

   Built ON TOP of openSheet rather than as a new overlay, so it inherits the
   back-gesture handling that took several attempts to get right. The sheet
   just gets a full-screen class.
   ============================================================ */

function openStory(slides, onDone) {
  const items = slides.filter(Boolean);
  if (!items.length) return;
  let i = 0;

  const body = openSheet('');
  const sheet = $('#sheet');
  sheet.classList.add('story-mode');

  const wrap = el('div', 'story');
  wrap.innerHTML = `<div class="story-bars"></div>
    <div class="story-stage"></div>
    <div class="story-nav"><button class="sn prev" aria-label="Previous"></button>
      <button class="sn next" aria-label="Next"></button></div>
    <div class="story-foot"></div>`;
  body.appendChild(wrap);

  const bars = wrap.querySelector('.story-bars');
  const stage = wrap.querySelector('.story-stage');
  const foot = wrap.querySelector('.story-foot');
  bars.innerHTML = items.map(() => '<span><i></i></span>').join('');

  const paint = () => {
    [...bars.children].forEach((b, n) =>
      b.firstChild.style.width = n < i ? '100%' : n === i ? '100%' : '0%');
    stage.innerHTML = `<div class="story-card">${items[i].html}</div>`;
    stage.firstChild.classList.add('in');
    foot.innerHTML = '';
    if (i === items.length - 1) {
      const done = el('button', 'btn gold', 'Done');
      done.style.width = '100%';
      done.onclick = async () => { if (onDone) await onDone(); closeStory(); };
      foot.appendChild(done);
    } else {
      foot.appendChild(el('div', 'story-hint', 'Tap to continue'));
    }
  };

  const go = (d) => {
    const next = i + d;
    if (next < 0) return;
    if (next >= items.length) { if (onDone) onDone(); closeStory(); return; }
    i = next; buzz(6); paint();
  };

  wrap.querySelector('.sn.next').onclick = () => go(1);
  wrap.querySelector('.sn.prev').onclick = () => go(-1);

  let sx = 0;
  wrap.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
  });

  paint();
}

function closeStory() {
  $('#sheet').classList.remove('story-mode');
  closeSheet();
}

/* Slide builders ------------------------------------------------ */

const slideHero = (eyebrow, title, big, sub, collage) => ({ html: `
  <div class="sl-hero">${collage || ''}<div class="sl-veil"></div>
    <div class="sl-mid">
      <div class="sl-eyebrow">${esc(eyebrow)}</div>
      <div class="sl-title">${esc(title)}</div>
      <div class="sl-big">${esc(big)}</div>
      <div class="sl-sub">${esc(sub)}</div>
    </div></div>` });

const slideStat = (kicker, big, sub, extra) => ({ html: `
  <div class="sl-mid">
    <div class="sl-eyebrow">${esc(kicker)}</div>
    <div class="sl-big">${esc(big)}</div>
    <div class="sl-sub">${esc(sub)}</div>
    ${extra || ''}
  </div>` });

const slideBlock = (kicker, title, body) => ({ html: `
  <div class="sl-top">
    <div class="sl-eyebrow">${esc(kicker)}</div>
    <div class="sl-h2">${esc(title)}</div>
    ${body}
  </div>` });

/** Find watched codes that do not exist in TMDB's structure for a show.

    The original import fuzzy-matched titles, so some shows collected episodes
    that belong to a different series entirely — The Haunting of Hill House
    absorbed Bly Manor's season 2, and Perilloor Premier League absorbed 475
    football matches as seasons 33 and 34. */
async function findPhantomEpisodes(show) {
  const b = await showBundle(show.id);
  const valid = new Set();
  for (const info of (b.seasons || [])) {
    const n = info.season_number;
    for (const ep of seasonEps(b, n)) valid.add(`S${n}E${ep.episode_number}`);
  }
  if (!valid.size) return null;                 // no data — never guess
  const bad = (show.watched_episodes || []).filter(c => !valid.has(c));
  return { show, bad, kept: show.watched_episodes.length - bad.length, real: valid.size };
}

async function scanPhantoms(onProgress) {
  const targets = db.shows.filter(isMismatched);
  const found = await mapLimit(targets, 4, (x) => findPhantomEpisodes(x), onProgress);
  return found.filter(r => r && r.bad.length);
}

/** Remove the phantom codes and their history rows. Shown for review first. */
async function applyPhantomFix(results) {
  let episodes = 0, rows = 0;
  for (const r of results) {
    const bad = new Set(r.bad);
    r.show.watched_episodes = r.show.watched_episodes.filter(c => !bad.has(c));
    episodes += bad.size;
    for (const code of bad) {
      const idx = history.findIndex(h => h.type === 'tv' && h.item === String(r.show.id) && h.code === code);
      if (idx === -1) continue;
      const [gone] = history.splice(idx, 1);
      rows++;
      if (gone.id && !historyTableMissing) {
        try { await sb(`watch_history?id=eq.${gone.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); }
        catch { /* leave the row; the payload is already correct */ }
      }
    }
  }
  invalidateFeeds();
  await savePayload();
  return { episodes, rows };
}

/* ---------------- sheets ---------------- */

function openSheet(html) {
  // Pushed here because opening a sheet always follows a tap — a genuine user
  // gesture, so Chrome will not mark the entry skippable.
  if ($('#sheet').hidden) pushHistory({ kind: 'sheet', view });
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  $('#sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  return $('#sheet-body');
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
}

/* Back-gesture handling.

   Chrome applies a "history manipulation intervention": entries pushed WITHOUT
   a user gesture are flagged skippable, and back jumps straight past them. My
   earlier attempts pushed a buffer at boot — no gesture — so Android skipped it
   and exited the app. Every push below therefore happens inside a real tap.

     tap a poster / tab  -> pushState
     back                -> popstate -> close the sheet, or return to that tab
     back at the root    -> nothing pushed, so the app closes, as it should
*/
/* NOTE: this module declares `let history = []` for the watch log, which
   shadows window.history for the entire file. Browser-history calls MUST be
   written as window.history.* — bare history.pushState() resolves to the array
   and throws. That shadowing was the real cause of the back button never
   working, through four attempted fixes. */

function pushHistory(state) {
  try {
    window.history.pushState({ mytv: true, ...state }, '');
  } catch { /* history unavailable */ }
}

window.addEventListener('popstate', (e) => {
  if (!$('#sheet').hidden) { closeSheet(); return; }   // 1. close the sheet

  const target = e.state?.view;                        // 2. return to that tab
  if (target && target !== view) { view = target; render(); return; }

  if (view !== 'next') { view = 'next'; render(); return; }
  // 3. root with nothing open: allow the app to close.
});

function sheetHeader(title, backdrop, poster, chips) {
  const bg = backdrop ? imgUrl(backdrop, 'w780') : (isAbs(poster) ? '' : imgUrl(poster, 'w780'));
  return `${bg ? `<div class="sheet-hero"><img src="${bg}" alt=""></div>` : '<div class="sheet-hero plain"></div>'}
    <div class="sheet-head">
      <div class="sheet-poster"><img src="${imgUrl(poster)}"
        style="object-fit:${isAbs(poster) ? 'contain' : 'cover'}" alt=""></div>
      <div><div class="sheet-title">${esc(title)}</div>
        <div>${chips.filter(Boolean).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div></div>
    </div><div class="sheet-body">`;
}

function journalEditor(container, entry) {
  const wrap = el('div');
  wrap.innerHTML = `<div class="section-head">Your notes</div>
    <div class="field"><label>Rating</label><div class="stars"></div></div>
    <div class="field"><label>Watched on</label><select class="j-plat">${PLATFORMS.map(p =>
      `<option value="${esc(p)}"${p === entry.platform ? ' selected' : ''}>${p || '—'}</option>`).join('')}</select></div>
    <div class="field"><label>Mood</label><select class="j-mood">${MOODS.map(m =>
      `<option value="${esc(m)}"${m === entry.feeling ? ' selected' : ''}>${m || '—'}</option>`).join('')}</select></div>`;
  const stars = wrap.querySelector('.stars');
  const caption = el('div', 'rating-word', RATING_WORDS[entry.rating] || 'Not rated');
  for (let n = 1; n <= 5; n++) {
    const b = el('button', null, '★');
    b.setAttribute('aria-pressed', String(entry.rating >= n));
    b.onclick = async () => {
      await patchHistory(entry, { rating: entry.rating === n ? 0 : n });
      [...stars.children].forEach((c, i) => c.setAttribute('aria-pressed', String(entry.rating >= i + 1)));
      caption.textContent = RATING_WORDS[entry.rating] || 'Not rated';
      toast('Saved');
    };
    stars.appendChild(b);
  }
  stars.after(caption);
  wrap.querySelector('.j-plat').onchange = async (e) => { await patchHistory(entry, { platform: e.target.value }); toast('Saved'); };
  wrap.querySelector('.j-mood').onchange = async (e) => { await patchHistory(entry, { feeling: e.target.value }); toast('Saved'); };
  container.appendChild(wrap);
}

function showHistoryStats(showId) {
  const logs = history.filter(h => h.type === 'tv' && h.item === String(showId));
  if (!logs.length) return null;
  const dates = logs.map(h => h.at).filter(Boolean).sort();
  const ratings = logs.filter(h => h.rating > 0).map(h => h.rating);
  const plats = {}, feels = {};
  logs.forEach(h => {
    if (h.platform) plats[h.platform] = (plats[h.platform] || 0) + 1;
    if (h.feeling) feels[h.feeling] = (feels[h.feeling] || 0) + 1;
  });
  return { count: logs.length, first: dates[0]?.slice(0, 10) || '',
           last: dates[dates.length - 1]?.slice(0, 10) || '',
           avg: ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0,
           rated: ratings.length, platform: topKey(plats)?.[0] || '', mood: topKey(feels)?.[0] || '' };
}

/** Cast strip + inline actor panel: their top roles, and what you already own. */
async function castStrip(mediaType, id, container) {
  const credits = await tmdb(`${mediaType}/${id}/credits`);
  const cast = (credits.cast || []).slice(0, 15);
  if (!cast.length) return;
  container.appendChild(el('div', 'section-head', 'Cast'));
  const strip = el('div', 'cast');
  cast.forEach(a => {
    const c = el('button', 'cast-card');
    c.innerHTML = `<img loading="lazy" src="${a.profile_path ? imgUrl(a.profile_path, 'w185')
        : 'https://via.placeholder.com/185x278/222/555?text=%20'}" alt="">
      <span class="cast-char">${esc(a.character || '\u00a0')}</span>
      <span class="cast-name">${esc(a.name)}</span>`;
    c.onclick = () => openActor(a.id, a.name);
    strip.appendChild(c);
  });
  container.appendChild(strip);
}

async function openActor(actorId, actorName) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const [person, credits] = await Promise.all([
    tmdb(`person/${actorId}`), tmdb(`person/${actorId}/combined_credits`)]);

  const owned = [], seen = new Set();
  for (const c of (credits.cast || [])) {
    const key = String(c.id);
    if (seen.has(key)) continue;
    const mine = c.media_type === 'tv' ? getShow(key) : getMovie(key);
    if (mine) { owned.push({ ...c, mine }); seen.add(key); }
  }
  const all = (credits.cast || []).slice()
    .filter(c => c.poster_path || c.name || c.title)
    .sort((a, b) => String(b.first_air_date || b.release_date || '')
                      .localeCompare(String(a.first_air_date || a.release_date || '')));
  const series = all.filter(c => c.media_type === 'tv');
  const films = all.filter(c => c.media_type === 'movie');

  const bio = (person.biography || '').trim();
  body.innerHTML = sheetHeader(person.name || actorName, '', person.profile_path,
    [person.birthday ? `Born ${person.birthday}` : '', person.place_of_birth || '',
     `${(credits.cast || []).length} credits`]) +
    (bio ? `<p class="overview">${esc(bio.length > 320 ? bio.slice(0, 320) + '…' : bio)}</p>` : '') +
    '<div class="owned"></div><div class="roles"></div></div>';

  if (owned.length) {
    const box = body.querySelector('.owned');
    box.appendChild(el('div', 'section-head', `In your library · ${owned.length}`));
    box.appendChild(gridOf(owned.slice(0, 9).map(c => ({
      title: c.mine.name, poster: c.mine.poster_path,
      badge: c.media_type === 'tv' ? 'Series' : 'Film',
      onOpen: () => c.media_type === 'tv'
        ? (isFootballShow(c.mine) ? openFootball(c.mine.id, c.mine.name) : openShow(c.mine.id, c.mine.name))
        : openMovie(c.mine.id, c.mine.name) }))));
  }
  const roles = body.querySelector('.roles');

  // Full filmography, newest first, paged so a 200-credit career stays usable.
  const section = (label, list, kind) => {
    if (!list.length) return;
    let shown = 18;
    const head = el('div', 'section-head', `${label} · ${list.length}`);
    const holder = el('div');
    const paint = () => {
      holder.innerHTML = '';
      holder.appendChild(gridOf(list.slice(0, shown).map(c => ({
        title: c.name || c.title, poster: c.poster_path,
        badge: String(c.first_air_date || c.release_date || '').slice(0, 4) || null,
        onOpen: () => kind === 'tv' ? openShow(c.id, c.name) : openMovie(c.id, c.title) }))));
      if (list.length > shown) {
        const more = el('button', 'btn', `Show ${Math.min(18, list.length - shown)} more`);
        more.style.cssText = 'width:100%;margin-top:10px';
        more.onclick = () => { shown += 18; paint(); };
        holder.appendChild(more);
      }
    };
    paint();
    roles.append(head, holder);
  };
  section('Series', series, 'tv');
  section('Films', films, 'movie');
}

async function openEpisode(showId, showName, code) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const m = /^S(\d+)E(\d+)$/.exec(code) || [];
  const [ep, show] = await Promise.all([
    m[1] ? tmdb(`tv/${showId}/season/${m[1]}/episode/${m[2]}`) : {}, tmdb(`tv/${showId}`)]);
  const on = epWatched(showId, code);
  body.innerHTML = sheetHeader(ep.name || showName, ep.still_path || show.backdrop_path, show.poster_path,
    [code, on ? '✅ Watched' : '', ep.vote_average ? `★ ${ep.vote_average.toFixed(1)}` : '']) +
    `<div class="muted">${esc(ep.air_date || '')}</div>
     <p class="overview">${esc(ep.overview || 'No synopsis yet.')}</p>
     <div class="sheet-actions">
       <button class="btn ${on ? '' : 'gold'} act-toggle">${on ? 'Unmark' : 'Mark watched'}</button>
       <button class="btn act-show">Open series</button></div></div>`;
  const inner = body.querySelector('.sheet-body');
  body.querySelector('.act-toggle').onclick = async (e) => {
    e.target.disabled = true;
    if (!await guardedWrite('toggle episode', () => (setEpisode(showId, code, !on, { name: showName })))) return;
    buzz(); toast(on ? 'Unmarked' : `${code} logged`);
    openEpisode(showId, showName, code); render();
  };
  body.querySelector('.act-show').onclick = () => openShow(showId, showName);
  const log = findLog('tv', showId, code);
  if (on && log) journalEditor(inner, log);
  castStrip('tv', showId, inner);
}

async function openShow(showId, showName) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const b = await showBundle(showId);
  const s = getShow(showId);
  const inLib = !!s;
  const watched = s ? Math.min(countedEps(s), b.number_of_episodes || Infinity) : 0;
  const total = b.number_of_episodes || 0;
  const epMins = (b.episode_run_time || [])[0] || EPISODE_MINUTES;
  const stats = showHistoryStats(showId);
  const prov = await providersFor('tv', showId);
  const today = TODAY();

  const chips = [b.status || 'Series'];
  if (b.vote_average) chips.push(`★ ${b.vote_average.toFixed(1)}`);
  if (b.first_air_date) chips.push(b.first_air_date.slice(0, 4));
  if (inLib) chips.push(`${watched}/${total}`);
  (b.genres || []).slice(0, 2).forEach(g => chips.push(g.name));

  const left = Math.max(0, total - watched);
  const mins = left * epMins;
  const nxt = b.next_episode_to_air;

  body.innerHTML = sheetHeader(b.name || showName, b.backdrop_path, b.poster_path, chips) +
    (inLib && total ? `<div class="progress"><span style="width:${Math.min(watched / total, 1) * 100}%"></span></div>
      <div class="muted">${watched} of ${total} episodes · ${left ? `${left} to go` : 'finished 🎉'}</div>
      <div class="stat-row">
        <div class="stat"><b>${left}<i>eps</i></b><span>Remaining</span></div>
        <div class="stat"><b>${mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}` : Math.floor(mins / 60)}<i>hrs</i></b><span>Time left</span></div>
        <div class="stat"><b>${stats && stats.avg ? stats.avg : '—'}</b><span>Your rating</span></div></div>` : '') +
    (nxt?.air_date ? `<div class="callout"><b>Next episode</b>
      S${nxt.season_number}E${nxt.episode_number} · ${esc(nxt.name || 'TBA')}<br>
      <i>${nxt.air_date} · ${countdown(nxt.air_date)}</i></div>` : '') +
    `<div class="sheet-actions">
       <button class="btn ${inLib ? '' : 'gold'} act-lib">${inLib ? (s.dropped ? 'Restore' : 'Drop show') : 'Add to library'}</button>
       <button class="btn act-season">Mark season</button></div>` +
    (stats ? `<div class="section-head">Your history</div><div class="facts">
       <div class="fact"><span>📅</span><span>First watched</span><b>${stats.first}</b></div>
       ${stats.last !== stats.first ? `<div class="fact"><span>🕘</span><span>Last watched</span><b>${stats.last}</b></div>` : ''}
       <div class="fact"><span>✅</span><span>Episodes logged</span><b>${stats.count}</b></div>
       ${stats.rated ? `<div class="fact"><span>⭐</span><span>Average</span><b>${stats.avg} over ${stats.rated}</b></div>` : ''}
       ${stats.platform ? `<div class="fact"><span>📡</span><span>Mostly on</span><b>${esc(stats.platform)}</b></div>` : ''}
       ${stats.mood ? `<div class="fact"><span>🎭</span><span>Usually</span><b>${esc(stats.mood)}</b></div>` : ''}</div>` : '') +
    `<p class="overview">${esc(b.overview || '')}</p>` + providerRows(prov) +
    `<div class="field"><label>Season</label><select class="sel-season">${
      (b.seasons || []).filter(x => x.season_number > 0).map(x => {
        const eps = seasonEps(b, x.season_number);
        const done = eps.filter(e => epWatched(showId, `S${x.season_number}E${e.episode_number}`)).length;
        return `<option value="${x.season_number}">Season ${x.season_number} — ${done}/${eps.length}${eps.length && done === eps.length ? ' ✓' : ''}</option>`;
      }).join('')}</select></div><div class="ep-list"></div></div>`;

  const list = body.querySelector('.ep-list');
  const sel = body.querySelector('.sel-season');

  const drawSeason = () => {
    const n = +sel.value;
    list.innerHTML = '';
    for (const ep of seasonEps(b, n)) {
      const code = `S${n}E${ep.episode_number}`;
      const on = epWatched(showId, code);
      const air = (ep.air_date || '').trim();
      const future = air && air > today;
      const log = on ? findLog('tv', showId, code) : null;
      const meta = [];
      const seenTimes = timesWatched('tv', showId, code);
      if (log) {
        meta.push('✅ ' + log.at.slice(0, 10));
        if (seenTimes > 1) meta.push(`↻ ${seenTimes}×`);
        if (log.rating) meta.push('★'.repeat(log.rating));
        if (log.platform) meta.push(log.platform);
      } else if (future) meta.push(`🗓 ${air} · ${countdown(air)}`);
      else if (air) meta.push(air);
      if (ep.vote_average) meta.push(`★ ${ep.vote_average.toFixed(1)}`);

      const row = el('div', 'ep');
      row.innerHTML = `<div class="ep-thumb">
          ${ep.still_path ? `<img src="${imgUrl(ep.still_path, 'w300')}" style="${future ? 'opacity:.45' : ''}" alt="">`
                          : '<div class="ep-noimg">No still</div>'}
          ${on ? '<button class="ep-notes">📝 Notes</button>' : ''}
          ${on ? '<button class="ep-again">↻ Again</button>' : ''}</div>
        <div class="ep-body">
          <button class="ep-check ${on ? 'on' : ''}"${(!inLib || future) ? ' disabled' : ''}>
            <span>${on ? '✓' : ''}</span><b>${ep.episode_number}. ${esc(ep.name || 'Episode')}</b></button>
          <div class="ep-meta">${esc(meta.join(' · '))}</div>
          <div class="ep-ov">${esc(ep.overview || '')}</div></div>`;
      const chk = row.querySelector('.ep-check');
      if (chk && !chk.disabled) chk.onclick = async () => {
        if (!await guardedWrite('toggle episode', () => (setEpisode(showId, code, !on, { name: b.name || showName })))) return;
        drawSeason(); buzz(); toast(on ? 'Unmarked' : `${code} logged`);
      };
      const notes = row.querySelector('.ep-notes');
      if (notes) notes.onclick = () => openEpisode(showId, b.name || showName, code);
      const again = row.querySelector('.ep-again');
      if (again) again.onclick = async () => {
        again.disabled = true;
        if (await guardedWrite('rewatch', () => rewatchEpisode(showId, code, { name: b.name || showName }))) {
          buzz(); toast(`${code} logged again`);
        }
        drawSeason();
      };
      list.appendChild(row);
    }
  };
  sel.onchange = drawSeason;
  drawSeason();
  castStrip('tv', showId, body.querySelector('.sheet-body'));

  body.querySelector('.act-season').onclick = async (e) => {
    if (!inLib) return toast('Add the show first');
    e.target.disabled = true;
    const n = +sel.value;
    const codes = seasonEps(b, n).filter(ep => (ep.air_date || '') && (ep.air_date || '') <= today)
      .map(ep => `S${n}E${ep.episode_number}`);
    if (!await guardedWrite('mark season', () => markMany(showId, codes, true))) return;
    e.target.disabled = false;
    drawSeason(); buzz(18); toast(`Season ${n} logged`);
  };

  body.querySelector('.act-lib').onclick = async () => {
    if (!inLib) {
      db.shows.push({ id: showId, name: b.name || showName, watched_episodes: [],
        poster_path: b.poster_path || '', first_air_date: b.first_air_date || '',
        total_episodes: b.number_of_episodes || 1, dropped: false, src: 'tmdb' });
      toast('Added to library');
    } else {
      s.dropped = !s.dropped;
      toast(s.dropped ? 'Dropped' : 'Restored');
    }
    invalidateFeeds();
    await savePayload();
    openShow(showId, showName);
  };
}

async function openMovie(id, name) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const d = await tmdb(`movie/${id}`);
  const m = getMovie(id);
  const inLib = !!m;
  const on = movieWatched(id);
  const prov = await providersFor('movie', id);

  const chips = [];
  if (d.runtime) chips.push(`${d.runtime} min`);
  if (on) chips.push('✅ Watched');
  if (m?.dropped) chips.push('⚰️ Dropped');
  if (d.vote_average) chips.push(`★ ${d.vote_average.toFixed(1)}`);
  (d.genres || []).slice(0, 2).forEach(g => chips.push(g.name));

  body.innerHTML = sheetHeader(d.title || name, d.backdrop_path, d.poster_path, chips) +
    `<p class="overview">${esc(d.overview || '')}</p>` + providerRows(prov) +
    `<div class="sheet-actions">
       <button class="btn ${on ? '' : 'gold'} act-toggle">${on ? 'Unmark' : 'Mark watched'}</button>
       <button class="btn act-lib">${inLib ? (m.dropped ? 'Restore' : 'Drop') : 'Add to library'}</button></div>` +
    (inLib && m.dropped ? '<button class="btn act-del" style="width:100%">Delete permanently</button>' : '') +
    '</div>';
  const inner = body.querySelector('.sheet-body');
  body.querySelector('.act-toggle').onclick = async (e) => {
    e.target.disabled = true;
    if (!await guardedWrite('toggle film', () => (setMovie(id, !on, { name })))) return;
    buzz(); toast(on ? 'Unmarked' : 'Logged');
    openMovie(id, name); render();
  };
  body.querySelector('.act-lib').onclick = async () => {
    if (!inLib) {
      db.movies.push({ id, name: d.title || name, watched: false, poster_path: d.poster_path || '',
        release_date: d.release_date || '', runtime: d.runtime || MOVIE_MINUTES, dropped: false });
      toast('Added to library');
    } else {
      // Drop, not delete. Deleting used to be the only option, which threw away
      // the entry and its history in one tap.
      m.dropped = !m.dropped;
      toast(m.dropped ? 'Dropped' : 'Restored');
    }
    invalidateFeeds();
    await savePayload();
    openMovie(id, name);
  };
  const del = body.querySelector('.act-del');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${d.title || name}” permanently? Its watch history stays.`)) return;
    db.movies = db.movies.filter(x => String(x.id) !== String(id));
    invalidateFeeds();
    await savePayload();
    toast('Deleted'); closeSheet(); render();
  };
  const log = findLog('movie', id);
  if (on && log) journalEditor(inner, log);
  castStrip('movie', id, inner);
}

async function openMatch(showId, showName, code, game) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const on = epWatched(showId, code);
  const md = (/^S(\d+)E/.exec(code) || [])[1] || '';
  const score = matchScore(game);
  const finished = game.status === 'FINISHED';

  body.innerHTML = `<div class="sheet-hero plain match-hero">
      <div class="mh-md">Matchday ${esc(md)}</div>
      <div class="mh-teams">
        <div class="mh-team">${game.home_crest ? `<img src="${game.home_crest}" alt="">` : ''}
          <span>${esc(game.home)}</span></div>
        <div class="mh-score">${esc(score || 'v')}</div>
        <div class="mh-team">${game.away_crest ? `<img src="${game.away_crest}" alt="">` : ''}
          <span>${esc(game.away)}</span></div>
      </div>
      <div class="mh-when">${esc(game.kickoff)} · ${finished ? 'Full time'
        : game.started ? esc(game.status) : countdown(game.date)}</div>
    </div>
    <div class="sheet-body">
      <div class="sheet-actions">
        <button class="btn ${on ? '' : 'gold'} act-toggle"${game.started ? '' : ' disabled'}>
          ${on ? 'Unmark' : game.started ? 'Mark watched' : 'Not kicked off'}</button>
        <button class="btn act-season">Matchday ${esc(md)}</button>
      </div>
    </div>`;

  const inner = body.querySelector('.sheet-body');
  body.querySelector('.act-toggle').onclick = async (e) => {
    if (!game.started) return;
    e.target.disabled = true;
    if (!await guardedWrite('toggle episode', () => (setEpisode(showId, code, !on, { name: showName })))) return;
    buzz(); toast(on ? 'Unmarked' : 'Logged');
    openMatch(showId, showName, code, game);
    render();
  };
  body.querySelector('.act-season').onclick = () => openFootball(showId, showName);

  // Rating, platform and mood — the same journal every episode gets.
  const log = findLog('tv', showId, code);
  if (on && log) journalEditor(inner, log);
  else if (on) inner.appendChild(el('div', 'muted', 'Notes appear once the watch is saved.'));
}

async function openFootball(showId, showName) {
  const body = openSheet('<div class="spinner">Loading fixtures…</div>');
  const [code, season] = parseFootballId(showId);
  const days = await footballMatchdays(code, season);

  if (!Object.keys(days).length) {
    body.innerHTML = '<div class="sheet-body"></div>';
    body.querySelector('.sheet-body').appendChild(emptyState("Couldn't load fixtures",
      fbLastError || 'No fixtures returned. The season may not be published yet.'));
    return;
  }

  const emblem = await competitionEmblem(code);
  const current = await currentSeasonYear(code);
  const s = getShow(showId);
  const inLib = !!s;
  const total = Object.values(days).reduce((n, v) => n + v.length, 0);
  const watched = new Set(s ? s.watched_episodes : []);
  const played = Object.values(days).reduce((n, v) => n + v.filter(g => g.started).length, 0);

  const chips = ['Football', `${Object.keys(days).length} matchdays`];
  if (season !== current) chips.push('Past season');
  if (inLib) chips.push(`✅ ${watched.size}/${total}`);

  const mdKeys = Object.keys(days).map(Number);
  const defaultMd = mdKeys.find(md => days[md].some(g => !g.started)) ?? mdKeys[mdKeys.length - 1];

  body.innerHTML = sheetHeader(showName, '', emblem, chips) +
    (inLib ? `<div class="progress"><span style="width:${total ? Math.min(watched.size / total, 1) * 100 : 0}%"></span></div>
      <div class="muted">${watched.size} of ${total} matches · ${Math.max(0, played - watched.size)} played but unwatched</div>
      <div class="stat-row">
        <div class="stat"><b>${Math.max(0, played - watched.size)}</b><span>To catch up</span></div>
        <div class="stat"><b>${total - played}</b><span>Still to play</span></div>
        <div class="stat"><b>${Object.keys(days).length}</b><span>Matchdays</span></div></div>`
      : '<button class="btn gold act-add" style="width:100%">Track this season</button>') +
    `<div class="field"><label>Matchday</label><select class="sel-md">${
      mdKeys.map(md => {
        const done = days[md].filter((g, i) => watched.has(`S${md}E${i + 1}`)).length;
        return `<option value="${md}"${md === defaultMd ? ' selected' : ''}>Matchday ${md} — ${done}/${days[md].length}${done === days[md].length ? ' ✓' : ''}</option>`;
      }).join('')}</select></div>
    ${inLib ? '<div class="sheet-actions"><button class="btn act-md-all">Mark matchday</button><button class="btn act-md-none">Unmark</button></div>' : ''}
    <div class="fixtures"></div></div>`;

  const add = body.querySelector('.act-add');
  if (add) add.onclick = async () => {
    add.disabled = true;
    await ensureFootballShow(code, season);
    toast('Tracking'); openFootball(showId, showName); render();
  };

  const sel = body.querySelector('.sel-md');
  const listEl = body.querySelector('.fixtures');

  const draw = () => {
    const md = +sel.value;
    listEl.innerHTML = '';
    days[md].forEach((g, i) => {
      const cs = `S${md}E${i + 1}`;
      const on = watched.has(cs);
      const row = el('div', 'fixture' + (g.started ? '' : ' upcoming'));
      row.innerHTML = `<div class="fx-main">
          ${g.home_crest ? `<img src="${g.home_crest}" alt="">` : ''}<span>${esc(g.home)}</span>
          <b>${esc(matchScore(g) || 'v')}</b>
          ${g.away_crest ? `<img src="${g.away_crest}" alt="">` : ''}<span>${esc(g.away)}</span></div>
        <div class="fx-meta">${esc(g.kickoff)} · ${g.started ? (g.status === 'FINISHED' ? 'FT' : g.status) : countdown(g.date)}</div>
        ${inLib && g.started ? `<button class="btn fx-btn ${on ? '' : 'gold'}">${on ? '✓ Seen' : 'Mark'}</button>` : ''}`;
      const btn = row.querySelector('.fx-btn');
      if (btn) btn.onclick = async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        if (!await guardedWrite('toggle match', () => (setEpisode(showId, cs, !on, { name: showName })))) return;
        if (on) watched.delete(cs); else watched.add(cs);
        draw(); buzz(); toast(on ? 'Unmarked' : 'Logged');
      };
      row.style.cursor = 'pointer';
      row.onclick = () => openMatch(showId, showName, cs, g);   // rate one match
      listEl.appendChild(row);
    });
  };
  sel.onchange = draw;
  draw();

  const all = body.querySelector('.act-md-all');
  if (all) all.onclick = async () => {
    all.disabled = true;
    const md = +sel.value;
    const codes = days[md].map((g, i) => g.started ? `S${md}E${i + 1}` : null).filter(Boolean);
    if (!await guardedWrite('mark season', () => markMany(showId, codes, true))) return;
    codes.forEach(c => watched.add(c));
    all.disabled = false; draw(); buzz(18); toast(`Matchday ${md} logged`); render();
  };
  const none = body.querySelector('.act-md-none');
  if (none) none.onclick = async () => {
    none.disabled = true;
    const md = +sel.value;
    const codes = days[md].map((g, i) => `S${md}E${i + 1}`).filter(c => watched.has(c));
    if (!await guardedWrite('unmark season', () => markMany(showId, codes, false))) return;
    codes.forEach(c => watched.delete(c));
    none.disabled = false; draw(); toast('Unmarked'); render();
  };
}

/* ---------------- boot ---------------- */

async function start() {
  $('#setup').hidden = true;
  $('#app').hidden = false;
  $('#view').innerHTML = '<div class="spinner">Loading your library…</div>';
  loadFeedCache();
  await loadPayload();
  await loadHistory();
  render();
  // Push an earned wrap-up once per app open, oldest first, like Streamlit does.
  const due = pendingRecaps();
  if (due.length && !sessionStorage.getItem('recapShown')) {
    sessionStorage.setItem('recapShown', '1');
    setTimeout(() => {
      const r = due[0];
      if (r.kind === 'month') openMonthRecap(r.key, r.id); else openYearRecap(r.key, r.id);
    }, 700);
  }
}

function boot() {
  try { window.history.replaceState({ mytv: true, kind: 'root', view: 'next' }, ''); } catch { /* ignore */ }
  cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
  if (!cfg) { $('#setup').hidden = false; return; }
  start().catch(err => {
    $('#view').innerHTML = '';
    $('#view').appendChild(emptyState("Couldn't reach your data", String(err.message || err),
      { label: 'Check keys', onClick: () => { localStorage.removeItem(CFG_KEY); location.reload(); } }));
  });
}

$('#cfg-save').onclick = async () => {
  const next = { url: $('#cfg-url').value.trim(), key: $('#cfg-key').value.trim(),
                 tmdb: $('#cfg-tmdb').value.trim(), football: ($('#cfg-football')?.value || '').trim() };
  const err = $('#cfg-error');
  if (!next.url || !next.key || !next.tmdb) {
    err.textContent = 'Supabase URL, Supabase key and TMDB key are all needed.';
    err.hidden = false; return;
  }
  cfg = next;
  try {
    await sb('tv_time_data?id=eq.1&select=id');
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    start();
  } catch (e) {
    cfg = null;
    err.textContent = 'Those keys did not work: ' + (e.message || e);
    err.hidden = false;
  }
};

document.querySelectorAll('#tabbar button').forEach(b => {
  b.onclick = () => {
    if (!$('#sheet').hidden) closeSheet();
    if (view === b.dataset.view) return;
    pushHistory({ kind: 'tab', view });     // remember where we came from
    view = b.dataset.view;
    render();
  };
});

$('#sheet-close').onclick = closeSheet;
$('#sheet-backdrop').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* Pull down at the top of a list to refresh — replaces the floating button,
   which was the last piece of chrome sitting over the content. */
(function pullToRefresh() {
  const view = $('#view');
  let startY = 0, pulling = false;
  const bar = el('div', 'ptr');
  bar.innerHTML = '<span></span>';
  document.body.appendChild(bar);

  window.addEventListener('touchstart', (e) => {
    pulling = window.scrollY <= 0 && $('#sheet').hidden;
    startY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) bar.style.height = Math.min(dy * 0.4, 64) + 'px';
  }, { passive: true });

  window.addEventListener('touchend', async () => {
    if (!pulling) return;
    const h = parseFloat(bar.style.height) || 0;
    bar.style.height = '0px';
    pulling = false;
    if (h > 46) {
      buzz(15);
      bar.classList.add('busy');
      Object.keys(localStorage).filter(k => k.startsWith('tmdb:') || k.startsWith('fbdb:'))
        .forEach(k => localStorage.removeItem(k));
      invalidateFeeds();
      try { await loadPayload(); await loadHistory(); } catch { /* offline */ }
      bar.classList.remove('busy');
      render();
      toast('Refreshed');
    }
  });
})();

boot();
