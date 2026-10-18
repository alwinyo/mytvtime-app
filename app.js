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

const BUILD = '2026-10-18-g';      // shown in Me -> Data; bump on every upload
const CFG_KEY = 'mytv.cfg';
const TMDB_TTL = 12 * 3600 * 1000;
const FOOTBALL_TTL = 3600 * 1000;
const MATCH_MINUTES = 115;          // 90 + half-time + stoppage
const EPISODE_MINUTES = 45;
const MOVIE_MINUTES = 120;

const PLATFORMS = ['', 'Stremio', 'Netflix', 'OSN+', 'Amazon Prime', 'Apple TV+',
                   'Disney+', 'Starzplay', 'Cinema', 'Downloaded', 'Other'];
/* Moods: a tighter set, and you can pick more than one, because an episode
   can be both tense and funny. Stored as readable labels joined by " · "
   so the Streamlit app and the raw table still make sense.

   Older entries used single emoji phrases. They are never rewritten in the
   database — they are mapped onto the new set whenever they are read, so
   eleven years of history count toward the right moods. */
const MOODS = ['Loved it', 'Mind-blowing', 'Thrilling', 'Funny', 'Moving', 'Clever', 'Easy watch', 'Meh'];

const LEGACY_MOOD = {
  'Blew my mind': 'Mind-blowing', 'Mind Blown': 'Mind-blowing',
  'Had me laughing': 'Funny', 'Hilarious': 'Funny', 'So bad it was fun': 'Funny',
  'Wrecked me': 'Moving', 'Emotional': 'Moving', 'Quietly devastating': 'Moving', 'Heartbroken': 'Moving',
  'Absolutely loved it': 'Loved it', 'Loved it': 'Loved it', 'Best thing all year': 'Loved it', 'Peak Cinema': 'Loved it',
  'Could barely watch': 'Thrilling', 'Edge of Seat': 'Thrilling', 'Pure Hype': 'Thrilling',
  'Cleverly done': 'Clever', 'Genius Plot': 'Clever',
  'Pure entertainment': 'Easy watch',
  'Went nowhere': 'Meh', 'Struggled to finish': 'Meh', 'Bored': 'Meh', 'Frustrated': 'Meh', 'Trash': 'Meh',
};

/** Whatever was stored -> a clean list of current mood labels. */
function parseMoods(feeling) {
  if (!feeling) return [];
  const out = [];
  for (const raw of String(feeling).split(' · ')) {
    const t = raw.trim();
    if (!t) continue;
    if (MOODS.includes(t)) { out.push(t); continue; }
    const bare = t.replace(/^[^A-Za-z]+/, '').trim();      // drop a leading emoji
    const mapped = LEGACY_MOOD[bare] || LEGACY_MOOD[t];
    if (mapped) out.push(mapped);
  }
  return [...new Set(out)];
}
const formatMoods = (list) => list.join(' · ');


/* Stars alone tell you nothing at a glance; words do. */
const RATING_WORDS = ['', 'Didn\u2019t work', 'Watchable', 'Good', 'Really good', 'Outstanding'];
const FOOTBALL_COMPETITIONS = { PL: 'Premier League' };

let cfg = null;
let db = { shows: [], movies: [], analytics: {}, seen_recaps: [], legacy: [] };
let history = [];
let historyTableMissing = false;
let historyComplete = false;
let historyLoadError = '';

/* ------------------------------------------------------------------
   CRASH GUARD
   Chrome's "Aw, Snap!" kills the tab outright, so no code runs to record
   it. Instead each launch writes a marker and removes it once the app has
   run steadily for 15 seconds. A marker still present at the next launch
   means the last one died — so this launch runs in safe mode: no recap
   pop-up and no background colour sampling, with a quiet note saying so.
   ------------------------------------------------------------------ */
let safeMode = false;
try {
  safeMode = !!localStorage.getItem('mytv.booting');
  localStorage.setItem('mytv.booting', String(Date.now()));
  setTimeout(() => { try { localStorage.removeItem('mytv.booting'); } catch { /* ignore */ } }, 15000);
} catch { /* storage unavailable: carry on normally */ }         // set when later pages could not be fetched

/** Try a few times before giving up. A single slow page used to stop the
    whole history load silently, leaving every stat quietly incomplete. */
async function withRetry(fn, waits = [0, 1500, 4000]) {
  let last;
  for (const w of waits) {
    if (w) await new Promise(r => setTimeout(r, w));
    try { return await fn(); } catch (e) { last = e; }
  }
  throw last;
}

/** How many history rows the server actually holds — the truth to check against. */
async function serverHistoryCount() {
  try {
    const res = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/watch_history?select=id', {
      method: 'HEAD',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, Prefer: 'count=exact' },
    });
    const n = +String(res.headers.get('content-range') || '').split('/')[1];
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/** Every history row, straight from the server — never whatever is in memory. */
async function fetchAllHistory(onProgress) {
  const out = [];
  for (let offset = 0; ; offset += HISTORY_PAGE) {
    const rows = await withRetry(() => fetchHistoryPage(offset));
    out.push(...rows.map(mapHistoryRow));
    if (onProgress) onProgress(out.length);
    if (rows.length < HISTORY_PAGE) break;
  }
  return out;
}
const HISTORY_PAGE = 1000;

/* `cycle` only exists after the rewatch migration; drop it if absent. */
let historyCols = 'id,media_type,item_id,episode_code,watched_at,rating,feeling,platform,cycle,favorite';
let historyHasFavorite = true;     // false until reactions_migration.sql has run

async function fetchHistoryPage(offset) {
  const q = (cols) =>
    sb(`watch_history?select=${cols}&order=watched_at.desc&limit=${HISTORY_PAGE}&offset=${offset}`);
  try {
    return await q(historyCols);
  } catch (e) {
    // Columns added by later migrations may not exist yet. Drop whichever one
    // the database complained about and try again, rather than failing to load.
    const msg = String(e.message || e);
    for (const col of ['favorite', 'cycle']) {
      if (msg.includes(col) && historyCols.includes(',' + col)) {
        historyCols = historyCols.replace(',' + col, '');
        if (col === 'favorite') historyHasFavorite = false;
        return fetchHistoryPage(offset);
      }
    }
    throw e;
  }
}

const mapHistoryRow = (r) => ({
  id: r.id, type: r.media_type, item: String(r.item_id), code: r.episode_code || '',
  at: r.watched_at || '', rating: r.rating || 0, feeling: r.feeling || '',
  platform: r.platform || '', cycle: r.cycle || 1, favorite: r.favorite || '',
});
let view = 'next';
let libFilter = 'watching', libKind = 'tv', genre = 'Trending', meTab = 'insights';
let journalLimit = 100, searchTimer = null;
let feedKind = 'tv', nextSort = 'smart', soonSort = 'date';
let nextLimit = 30, soonLimit = 30, libLimit = 60, libQuery = '', libSort = 'date';

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ------------------------------------------------------------------
   ICONS — one consistent line set in place of emoji. Emoji render
   differently on every phone and never match each other; these inherit
   the text colour and size of wherever they sit.
   ------------------------------------------------------------------ */
const ICON_PATHS = {
  star:     '<path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"/>',
  tv:       '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="m8 2.5 4 3.5 4-3.5"/>',
  smile:    '<circle cx="12" cy="12" r="9.2"/><path d="M8.3 14.3s1.4 2 3.7 2 3.7-2 3.7-2M9 9.6h.01M15 9.6h.01"/>',
  flame:    '<path d="M12 2.8c.8 3.4 5.2 5.6 5.2 10.2a5.2 5.2 0 0 1-10.4 0c0-2.6 1.5-4.2 2.6-5.1.2 2 1.4 3.1 2.6 3.1 0-3.1-1.6-5.4 0-8.2z"/>',
  film:     '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M7.5 3v18M16.5 3v18M3 8h4.5M3 12h4.5M3 16h4.5M16.5 8H21M16.5 12H21M16.5 16H21"/>',
  link:     '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  award:    '<circle cx="12" cy="9" r="6"/><path d="M8.6 13.6 7.2 21.5 12 19l4.8 2.5-1.4-7.9"/>',
  clock:    '<circle cx="12" cy="12" r="9.2"/><path d="M12 7v5.2l3.2 2"/>',
  crown:    '<path d="m3 8 4.2 4L12 5l4.8 7L21 8l-2 11H5z"/>',
  sprout:   '<path d="M12 21v-8.5M12 12.5c0-4 3-6.3 7.5-6.3 0 4-3 6.3-7.5 6.3zM12 14.5c0-3.3-2.6-5.3-6.5-5.3 0 3.3 2.6 5.3 6.5 5.3z"/>',
  flag:     '<path d="M5 21.5V3.5M5 4h11.5l-2.2 4 2.2 4H5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 2.8v4M16 2.8v4"/>',
  pause:    '<circle cx="12" cy="12" r="9.2"/><path d="M10 9v6M14 9v6"/>',
  moon:     '<path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z"/>',
  library:  '<path d="M4 4h4v16H4zM10 4h4v16h-4zM15.8 5.4l3.6-1 3.4 15.4-3.6 1z"/>',
  trending: '<path d="m3 17 6-6 4 4 8-8M15 7h6v6"/>',
  trophy:   '<path d="M8 21h8M12 16.5V21M7 3.5h10V9A5 5 0 0 1 7 9zM7 5.5H4.2A3 3 0 0 0 7 10M17 5.5h2.8A3 3 0 0 1 17 10"/>',
  check:    '<circle cx="12" cy="12" r="9.2"/><path d="m8 12.2 2.8 2.8L16.2 9"/>',
  edit:     '<path d="M4 20h4.2L19.4 8.8a2.6 2.6 0 0 0-3.7-3.7L4.5 16.3zM14.5 6.3l3.7 3.7"/>',
  sparkle:  '<path d="m12 3 2.2 6.3L20.5 11.5l-6.3 2.2L12 20l-2.2-6.3L3.5 11.5l6.3-2.2z"/>',
  drop:     '<circle cx="12" cy="12" r="9.2"/><path d="m9 9 6 6M15 9l-6 6"/>',
  play:     '<path d="M7 4.5v15l12-7.5z"/>',
  user:     '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  ball:     '<circle cx="12" cy="12" r="9.2"/><path d="m12 7 3.6 2.6-1.4 4.2H9.8L8.4 9.6zM12 7V3M15.6 9.6l3.9-1.3M14.2 13.8l2.4 3.4M9.8 13.8l-2.4 3.4M8.4 9.6 4.5 8.3"/>',
  dots:     '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  heart:    '<path d="M12 20.5s-8-4.6-8-10.4A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8 3.1c0 5.8-8 10.4-8 10.4z"/>',
};
// Emoji that used to act as icons, mapped onto the set above.
const EMOJI_ICON = { '⭐': 'star', '📡': 'tv', '🎭': 'smile', '🔥': 'flame', '🎬': 'film', '🔗': 'link',
  '🥇': 'award', '🕘': 'clock', '👑': 'crown', '🌱': 'sprout', '🏁': 'flag', '📅': 'calendar', '📆': 'calendar',
  '🗓': 'calendar', '🎞️': 'film', '🎞': 'film', '🌵': 'pause', '🦉': 'moon', '🌙': 'moon', '📺': 'tv',
  '📚': 'library', '🔚': 'flag', '📈': 'trending', '🏆': 'trophy', '✅': 'check', '📝': 'edit',
  '🍿': 'sparkle', '⚰️': 'drop', '⚰': 'drop' };

/** An inline icon by name, or by the emoji it replaces. Unknown -> as given. */
function ico(nameOrEmoji, cls = '') {
  const name = ICON_PATHS[nameOrEmoji] ? nameOrEmoji : EMOJI_ICON[nameOrEmoji];
  if (!name) return esc(nameOrEmoji || '');
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

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
/** A short burst of confetti — the finished-a-series moment. */
function celebrate(title) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { toast(`Finished ${title}`); return; }
  const host = el('div', 'confetti');
  const colours = ['var(--accent)', '#F3F4F6', '#FF8A80', '#80CBC4', '#FFCC80', '#B39DDB'];
  for (let i = 0; i < 36; i++) {
    const p = el('i');
    p.style.left = (40 + Math.random() * 20) + '%';
    p.style.background = colours[i % colours.length];
    p.style.setProperty('--dx', (Math.random() * 340 - 170) + 'px');
    p.style.setProperty('--dy', (-(160 + Math.random() * 260)) + 'px');
    p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
    p.style.animationDelay = (Math.random() * 80) + 'ms';
    host.appendChild(p);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 1600);
  buzz([18, 40, 18]);
  toast(`Finished ${title}`);
}

function skeletonGrid(n = 9) {
  const g = el('div', 'grid');
  for (let i = 0; i < n; i++) g.appendChild(el('div', 'skel'));
  return g;
}

/** Toast with an action — "Marked S2E4 · Undo", as Gmail does archiving. */
function toastAction(msg, label, fn, ms = 4200) {
  const t = $('#toast');
  t.innerHTML = '';
  t.appendChild(el('span', null, esc(msg)));
  const b = el('button', 'toast-act', esc(label));
  b.onclick = async () => { t.hidden = true; await fn(); };
  t.appendChild(b);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------------- storage ---------------- */

async function sb(path, opts = {}, timeoutMs = 20000) {
  // Every TMDB call had an AbortController; these did not, so one stalled
  // request left the app on "Loading your library…" forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/' + path, {
      ...opts, signal: ctrl.signal,
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key,
                 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs / 1000}s: ${path.split('?')[0]}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function cacheGet(key, ttl) {
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    // An entry can carry its own lifetime (hit.l), set from what it contains.
    const life = hit && hit.l ? hit.l : ttl;
    if (hit && Date.now() - hit.t < life) return hit.v;
  } catch { /* corrupt entry */ }
  return null;
}
const CACHE_MAX = 400_000;   // ~400 KB per entry

function cacheSet(key, value, life) {
  try {
    const blob = JSON.stringify(life ? { t: Date.now(), v: value, l: life }
                                     : { t: Date.now(), v: value });
    // One oversized show used to overflow the quota, and the old fallback then
    // wiped every cached entry — so a single big series slowed down everything.
    if (blob.length > CACHE_MAX) return;
    localStorage.setItem(key, blob);
  } catch {
    Object.keys(localStorage).filter(k => k.startsWith('tmdb:'))
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
  return db.shows.map(s => `${s.id}:${s.watched_episodes.length}:${s.total_episodes}:${s.dropped ? 1 : 0}:${s.src}:${s.status || ''}`).join('|')
       + '#' + db.movies.map(m => `${m.id}:${m.watched ? 1 : 0}:${m.dropped ? 1 : 0}:${m.status || ''}`).join('|');
}
const FEED_TTL = 3 * 3600 * 1000;   // re-scan for newly aired episodes every 3h
let feedCache = { sig: null, next: null, soon: null, ts: 0 };

/** Fresh means: same library AND scanned recently. Without the time check a
    feed could sit unchanged for days while new episodes aired. */
function feedFresh() {
  return feedCache.sig === libSignature() && (Date.now() - (feedCache.ts || 0) < FEED_TTL);
}

/* Feeds also persist to localStorage, so reopening the app paints instantly
   from the last good result instead of re-querying TMDB from cold. */
function loadFeedCache() {
  try {
    const raw = JSON.parse(localStorage.getItem('mytv.feeds') || 'null');
    if (raw && raw.sig) feedCache = raw;
  } catch { /* ignore */ }
}
function persistFeedCache() {
  // Football rows carry a whole fixture object; persisting those blew the
  // localStorage quota, the write failed silently, and every launch ran cold.
  const slim = (rows) => (rows || []).map(r => ({
    id: r.id, name: r.name, poster: r.poster, backdrop: r.backdrop,
    code: r.code, epName: r.epName, date: r.date, src: r.src,
    movie: r.movie, kind: r.kind, matchday: r.matchday, match: r.match, airAt: r.airAt,
  }));
  try {
    const payload = JSON.stringify({ sig: feedCache.sig, ts: feedCache.ts,
      next: slim(feedCache.next), soon: slim(feedCache.soon) });
    if (payload.length > 1_500_000) return;      // too big to be worth caching
    localStorage.setItem('mytv.feeds', payload);
  } catch {
    try { localStorage.removeItem('mytv.feeds'); } catch { /* ignore */ }
  }
}
/** Mark the feeds stale WITHOUT throwing the rows away.

    This used to delete them, including the saved copy — so marking one episode
    watched destroyed the warm-start data, and the next cold launch had to
    rescan the whole library before showing anything. The rows are still worth
    painting while a fresh scan runs behind them; only their freshness is in
    question, not their usefulness. */
const invalidateFeeds = () => {
  feedCache = { ...feedCache, sig: null, ts: 0 };
  persistFeedCache();
};

/** Genuinely discard everything — only for an explicit "rebuild feeds". */
const clearFeeds = () => {
  feedCache = { sig: null, next: null, soon: null, ts: 0 };
  try { localStorage.removeItem('mytv.feeds'); } catch { /* ignore */ }
};

const DAY = 86400000;

/** How long is this response good for?

    A single 12-hour lifetime was applied to everything, so a 1990s film and
    tonight's episode list expired together. Almost nothing TMDB returns
    actually changes; the exception is a season still being broadcast.
    Deciding from the content means a cold start after weeks away mostly
    reads from cache instead of refetching the entire library. */
function tmdbLife(path, data) {
  const today = TODAY();

  if (/^(trending|discover|search)/.test(path)) return 6 * 3600 * 1000;
  if (/\/watch\/providers/.test(path)) return 7 * DAY;
  if (/\/(videos|recommendations)$/.test(path)) return 7 * DAY;
  if (/^collection\//.test(path)) return 30 * DAY;
  if (/\/credits/.test(path) || /^person\//.test(path)) return 30 * DAY;

  if (/^movie\//.test(path)) {
    const rel = data?.release_date || '';
    return rel && rel < today ? 30 * DAY : 2 * DAY;   // out already = settled
  }

  if (/^tv\//.test(path)) {
    // Anything still to come means the schedule can still move.
    if (data?.next_episode_to_air) return 6 * 3600 * 1000;

    let future = false, newest = '';
    for (const k of Object.keys(data || {})) {
      if (!k.startsWith('season/')) continue;
      for (const ep of (data[k]?.episodes || [])) {
        const air = (ep.air_date || '').trim();
        if (!air) continue;
        if (air > today) future = true;
        if (air > newest) newest = air;
      }
    }
    if (future) return 6 * 3600 * 1000;

    const ended = /ended|cancel/i.test(data?.status || '');
    if (ended) return 30 * DAY;                      // nothing more is coming

    // Returning, but nothing scheduled: a new season could be announced.
    if (newest && daysSince(newest) > 30) return 7 * DAY;
    return 2 * DAY;
  }
  return 12 * 3600 * 1000;
}

async function tmdb(path, params = {}) {
  const qs = new URLSearchParams({ api_key: cfg.tmdb, ...params }).toString();
  const key = 'tmdb:' + path + '?' + qs.replace(/api_key=[^&]*&?/, '');
  const hit = cacheGet(key, TMDB_TTL);   // TMDB_TTL is only a floor for old entries
  if (hit) return hit;
  const data = await fetchJson(`https://api.themoviedb.org/3/${path}?${qs}`);
  if (!data) return {};
  cacheSet(key, data, tmdbLife(path, data));
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
      release_date: m[4], runtime: m[5], dropped: !!m[6],
      status: m.length > 7 ? (m[7] || '') : '' })),                  // index 7
    shows: (p.s || []).map(s => ({
      id: s[0], name: s[1], watched_episodes: decodeEps(s[2]), poster_path: s[3],
      first_air_date: s[4], total_episodes: s[5], dropped: !!s[6],
      src: s.length > 7 ? (s[7] || 'tmdb') : 'tmdb',              // index 7
      cycles: s.length > 8 ? (s[8] || 1) : 1,                      // index 8
      status: s.length > 9 ? (s[9] || '') : '' })),                 // index 9
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
                          m.release_date || '', m.runtime || 0, m.dropped ? 1 : 0, m.status || '']),
    s: d.shows.map(s => [s.id, s.name, encodeEps(s.watched_episodes || []), s.poster_path || '',
                         s.first_air_date || '', s.total_episodes || 1, s.dropped ? 1 : 0,
                         s.src || 'tmdb', s.cycles || 1, s.status || '']),
    a: Object.fromEntries(Object.entries(d.analytics || {}).map(([k, v]) => [k, [v.tv || 0, v.movie || 0]])),
    r: d.seen_recaps || [],
    ...(d.legacy?.length ? {
      h: d.legacy.map(h => [h.type === 'tv' ? 1 : 0, h.item, h.code, h.at, h.rating, h.feeling, h.platform]) } : {}),
  };
}

/* Local-first library.

   The app blocked on Supabase before it would draw anything, so a slow first
   request on a cold start left you staring at "Loading…" — and the only way
   out was to force a retry by hand. The packed payload is about 400 KB, small
   enough to keep on the device, so we paint from that immediately and
   reconcile with the server behind the UI. */
const LOCAL_DB = 'mytv.db';

function saveLocalDb() {
  try { localStorage.setItem(LOCAL_DB, JSON.stringify({ t: Date.now(), p: pack(db) })); }
  catch { try { localStorage.removeItem(LOCAL_DB); } catch { /* ignore */ } }
}

function loadLocalDb() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_DB) || 'null');
    if (!raw || !raw.p) return false;
    db = unpack(raw.p);
    return true;
  } catch { return false; }
}

async function loadPayload() {
  const rows = await sb('tv_time_data?id=eq.1&select=payload');
  db = unpack(rows?.[0]?.payload || {});
  saveLocalDb();
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
  saveLocalDb();                     // keep the device copy in step
}

/** Load the first page, then keep going in the background.

    Up Next and the library need only the payload; history is for the diary,
    stats and recaps. Waiting for all nine pages before the first paint was
    most of the cold-start delay. */
async function loadHistoryFirstPage() {
  historyComplete = false;
  try {
    const rows = await fetchHistoryPage(0);
    history = rows.map(mapHistoryRow);
    historyTableMissing = false;
    if (rows.length < HISTORY_PAGE) historyComplete = true;
    return true;
  } catch (err) {
    if (/PGRST205|does not exist|schema cache/i.test(String(err.message || err))) {
      historyTableMissing = true; history = []; historyComplete = true; return false;
    }
    throw err;
  }
}

async function loadHistoryRest(onDone) {
  if (historyComplete || historyTableMissing) return;
  historyLoadError = '';
  try {
    for (let offset = history.length; ; offset += HISTORY_PAGE) {
      const rows = await withRetry(() => fetchHistoryPage(offset));
      history.push(...rows.map(mapHistoryRow));
      if (rows.length < HISTORY_PAGE) break;
    }
    historyComplete = true;
    if (onDone) onDone();
  } catch (e) {
    // No longer silent: everything reading history now knows it is partial.
    historyLoadError = String((e && e.message) || e).slice(0, 80);
    if (view === 'me') render();
  }
}

async function loadHistory(onProgress) {
  const ok = await loadHistoryFirstPage();
  if (!ok) return;
  if (onProgress) onProgress(history.length);
  await loadHistoryRest();
  if (onProgress) onProgress(history.length);
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
  const before = { rating: entry.rating, feeling: entry.feeling, platform: entry.platform, favorite: entry.favorite };
  Object.assign(entry, fields);
  if (historyTableMissing) { toast("Notes can't save — history table missing"); return false; }
  if (!entry.id) { toast("This entry predates note support — re-mark it to enable notes"); return false; }
  try {
    await sb(`watch_history?id=eq.${entry.id}`, { method: 'PATCH',
      body: JSON.stringify(Object.assign(
        { rating: entry.rating, feeling: entry.feeling, platform: entry.platform },
        historyHasFavorite ? { favorite: entry.favorite || '' } : {})),
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

/* ------------------------------------------------------------------
   STATUS — something you choose, not something the app guesses.
   An empty status means "not set yet", and falls back to the old
   inference from progress so nothing in your library changes until
   you decide it should. 'dropped' stays mirrored in the dropped flag
   because older code and the Streamlit app both read that flag.
   ------------------------------------------------------------------ */
const STATUSES = [
  ['watching',  'Watching'],
  ['plan',      'Plan to watch'],
  ['hold',      'On hold'],
  ['completed', 'Completed'],
  ['dropped',   'Dropped'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);

function effectiveStatus(item, kind) {
  if (!item) return 'plan';
  if (item.dropped) return 'dropped';
  if (item.status) return item.status;
  if (kind === 'movie') return item.watched ? 'completed' : 'plan';
  const w = (item.watched_episodes || []).filter(c => !c.startsWith('S0E')).length;
  const t = item.total_episodes || 0;
  if (!w) return 'plan';
  if (t > 0 && w >= t) return 'completed';
  return 'watching';
}

function setStatus(item, value) {
  item.status = value;
  item.dropped = value === 'dropped';
}

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
  // For a show you own, the payload decides. Falling back to history here would
  // make "Start again" do nothing, since the old rows still exist by design.
  if (s) return s.watched_episodes.includes(code);
  return !!findLog('tv', showId, code);
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
    const wasDone = s.total_episodes > 0 && countedEps(s) >= s.total_episodes;
    if (!s.watched_episodes.includes(code)) s.watched_episodes.push(code);
    await addHistory('tv', showId, code);
    if (!meta.quiet) setTimeout(() => postWatch(isFootballShow(s) ? 'football' : 'tv', showId, code, s.name), 280);
    if (!wasDone && !isFootballShow(s) && s.total_episodes > 0 && countedEps(s) >= s.total_episodes) {
      setTimeout(() => celebrate(s.name), 350);
    }
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
  if (on && !meta.quiet) setTimeout(() => postWatch('movie', id, '', m.name), 280);
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
  // Finishing a series via "Mark season" deserves the moment as well.
  if (on && changed && !isFootballShow(s) && s.total_episodes > 0
      && countedEps(s) >= s.total_episodes) setTimeout(() => celebrate(s.name), 350);
  return changed;
}

/* ---------------- TMDB bundles ---------------- */

const EP_KEEP = ['episode_number', 'season_number', 'air_date', 'name',
                 'still_path', 'vote_average', 'overview'];

/** Keep only the episode fields the UI renders. A full TMDB episode carries
    crew and guest_stars; across 34 seasons of a weekly show that is megabytes,
    which overflowed localStorage and wiped the whole cache. */
function trimSeason(season) {
  return { episodes: (season?.episodes || []).map(e => {
    const o = {};
    for (const k of EP_KEEP) if (e[k] != null) o[k] = e[k];
    return o;
  }) };
}

async function showBundle(id, wantSeasons) {
  const base = await tmdb(`tv/${id}`);
  if (!base.seasons) return base;
  let nums = base.seasons.filter(s => s.season_number > 0).map(s => s.season_number);
  if (wantSeasons && wantSeasons.length) {
    const want = new Set(wantSeasons);
    nums = nums.filter(n => want.has(n));
  }
  const bundle = { ...base };
  for (let i = 0; i < nums.length; i += 20) {
    const chunk = nums.slice(i, i + 20);
    const data = await tmdb(`tv/${id}`, { append_to_response: chunk.map(n => `season/${n}`).join(',') });
    for (const n of chunk) if (data[`season/${n}`]) bundle[`season/${n}`] = trimSeason(data[`season/${n}`]);
  }
  return bundle;
}

/** Furthest point reached, so long-running shows resume instead of restarting
    at season 1 — Raw would otherwise offer an episode from 1993. */
function furthestWatched(show) {
  let season = 0, ep = 0;
  for (const c of (show.watched_episodes || [])) {
    const m = /^S(\d+)E(\d+)$/.exec(c);
    if (!m) continue;
    const sn = +m[1], en = +m[2];
    if (sn > season || (sn === season && en > ep)) { season = sn; ep = en; }
  }
  return { season, ep };
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
                airAt: pick[1].kickoff || '',
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
  if (g.home_crest) inner += `<img loading="lazy" decoding="async" src="${g.home_crest}" style="${c}">`;
  inner += '<span style="color:var(--accent);font-size:.62rem;font-weight:900;margin:0 3px;opacity:.85">v</span>';
  if (g.away_crest) inner += `<img loading="lazy" decoding="async" src="${g.away_crest}" style="${c}">`;
  return `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 32%,#232A3A,#0B0E14 78%);
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:10px 8px 34px">
    <div style="font-size:.5rem;font-weight:900;letter-spacing:.16em;color:var(--accent);text-transform:uppercase;opacity:.9">
    Matchday ${row.matchday ?? ''}</div>
    <div style="display:flex;align-items:center;justify-content:center;width:100%">${inner}</div></div>`;
}

/* ------------------------------------------------------------------
   REAL AIR TIMES (TVmaze)

   TMDB only gives a calendar date, so a US show airing 9pm Thursday in New
   York appeared as "Thursday" here when it actually lands at 5am Friday in
   Dubai. TVmaze publishes an exact UTC timestamp per episode, is free,
   needs no key and allows browser requests.

   Joining the two: TMDB external ids -> IMDb/TVDB id -> TVmaze show ->
   episode list. The show id never changes, so it is cached for a year;
   a failed lookup is remembered for a month so we don't keep asking.
   Air times: data provided by TVmaze (CC BY-SA 4.0).
   ------------------------------------------------------------------ */
const TVM = 'https://api.tvmaze.com';
let tvmNext = 0;

/** TVmaze allows ~20 calls per 10s per IP. Spacing at 600ms stays well under. */
async function tvmFetch(path) {
  const wait = tvmNext - Date.now();
  tvmNext = Math.max(Date.now(), tvmNext) + 600;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  return fetchJson(TVM + path, {}, 10000);
}

async function tvmazeId(tmdbId) {
  const key = 'tvm:id:' + tmdbId;
  const hit = cacheGet(key, 365 * DAY);
  if (hit !== null) return hit.id || null;
  const ext = await tmdb(`tv/${tmdbId}/external_ids`);
  let show = null;
  if (ext && ext.imdb_id) show = await tvmFetch(`/lookup/shows?imdb=${encodeURIComponent(ext.imdb_id)}`);
  if (!show && ext && ext.tvdb_id) show = await tvmFetch(`/lookup/shows?thetvdb=${ext.tvdb_id}`);
  const id = (show && show.id) || 0;
  cacheSet(key, { id }, id ? 365 * DAY : 30 * DAY);
  return id || null;
}

/** { "S2E4": "2026-10-16T01:00:00+00:00", ... } for one show, or null. */
async function tvmazeAirstamps(tmdbId) {
  const id = await tvmazeId(tmdbId);
  if (!id) return null;
  const key = 'tvm:eps:' + id;
  const hit = cacheGet(key, DAY);
  if (hit) return hit;
  const eps = await tvmFetch(`/shows/${id}/episodes`);
  if (!Array.isArray(eps)) return null;
  const map = {};
  let future = false;
  for (const e of eps) {
    if (e.season == null || e.number == null || !e.airstamp) continue;
    map[`S${e.season}E${e.number}`] = e.airstamp;
    if (new Date(e.airstamp) > new Date()) future = true;
  }
  cacheSet(key, map, future ? 12 * 3600 * 1000 : 14 * DAY);
  return map;
}

/** Exact Dubai time for a TMDB row, if TVmaze agrees about which episode it is.

    Numbering occasionally differs between the two databases (anime, some
    K-dramas). If TVmaze's date is more than two days from TMDB's we assume a
    mismatch and keep the plain date rather than show a confident wrong time. */
function airLocalFor(row, stamps) {
  const at = stamps && stamps[row.code];
  if (!at) return null;
  const local = kickoffLocal(at);
  if (!local) return null;
  const localDay = stamp(local).slice(0, 10);
  if (row.date && Math.abs(daysSince(localDay) - daysSince(row.date)) > 2) return null;
  return stamp(local).slice(0, 16);          // "YYYY-MM-DD HH:MM", Dubai
}

/** Countdown to an exact Dubai time. */
function countdownAt(local) {
  const t = new Date(local.replace(' ', 'T') + ':00Z');
  const mins = Math.round((t - now()) / 60000);
  if (mins <= 0) return 'Out now';
  if (mins < 60) return `In ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `In ${h}h ${mins % 60 ? (mins % 60) + 'm' : ''}`.trim();
  const d = Math.floor(h / 24);
  return d < 14 ? `In ${d}d ${h % 24}h` : `In ${Math.round(d / 7)}w`;
}

/** Add exact times to Upcoming rows, a few shows at a time. */
async function enrichAirTimes(rows) {
  let changed = false;
  const shows = [...new Set(rows.filter(r => !r.movie && r.src !== 'football' && !r.airAt)
                                 .map(r => String(r.id)))].slice(0, 40);
  for (const id of shows) {
    const stamps = await tvmazeAirstamps(id).catch(() => null);
    for (const r of rows) {
      if (String(r.id) !== id || r.airAt) continue;
      const at = airLocalFor(r, stamps);
      if (at) { r.airAt = at; r.date = at.slice(0, 10); changed = true; }
      else r.airAt = '';                     // looked, nothing reliable: date only
    }
  }
  return changed;
}

/* ---------------- feeds ---------------- */

async function computeNext(onProgress, onBatch) {
  const sig = libSignature();
  if (feedCache.sig === sig && feedCache.next) return feedCache.next;

  const today = TODAY();
  // Scan in the order you care about. Shows watched recently resolve first, so
  // useful rows appear within a second instead of after the whole library.
  const lastIdx = lastWatchedIndex();
  // On Hold means paused; Completed means you've said you're done.
  const candidates = db.shows
    .filter(x => !x.dropped && !isFootballShow(x) && !['hold', 'completed'].includes(x.status))
    .map(x => ({ x, seen: lastIdx[String(x.id)] || '', started: x.watched_episodes.length > 0 }))
    .sort((a, b) => (b.seen || '').localeCompare(a.seen || '') || (b.started - a.started))
    .map(o => o.x);

  const streamed = [];

  const found = await mapLimit(candidates, 6, async (s) => {
    const mark = furthestWatched(s);
    const head = await tmdb(`tv/${s.id}`);
    const allSeasons = (head.seasons || []).filter(x => x.season_number > 0)
      .map(x => x.season_number).sort((a, b) => a - b);
    // Only pull the seasons from where you are onward; a 34-season show does
    // not need its whole history fetched to find the next episode.
    const from = allSeasons.filter(n => n >= mark.season);
    const b = await showBundle(s.id, from.length ? from.slice(0, 6) : allSeasons.slice(0, 6));
    const total = b.number_of_episodes || s.total_episodes || 0;
    if (total && countedEps(s) >= total) return null;
    const seen = new Set(s.watched_episodes);

    for (const n of (from.length ? from : allSeasons)) {
      for (const ep of seasonEps(b, n)) {
        const code = `S${n}E${ep.episode_number}`;
        const air = (ep.air_date || '').trim();
        if (seen.has(code) || !air || air > today) continue;
        // Skip anything behind the furthest point already reached.
        if (n < mark.season || (n === mark.season && ep.episode_number < mark.ep)) continue;
        const row = { id: s.id, name: s.name, poster: s.poster_path || b.poster_path,
                      backdrop: b.backdrop_path, code, epName: ep.name || 'Episode',
                      date: air, kind: 'tv' };
        streamed.push(row);
        if (onBatch) onBatch(streamed.slice());   // paint what we have so far
        return row;
      }
    }
    return null;
  }, onProgress, 30000);                 // 30s ceiling — partial beats spinning

  const rows = found.filter(Boolean);
  rows.push(...(await computeFootballRows('next')).map(r => ({ ...r, kind: 'tv' })));
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  rows.partial = !!found.timedOut;
  feedCache.next = rows;
  if (!found.timedOut) { feedCache.sig = sig; feedCache.ts = Date.now(); }
  persistFeedCache();
  return rows;
}

async function computeSoon(onProgress) {
  const sig = libSignature();
  if (feedCache.sig === sig && feedCache.soon) return feedCache.soon;

  const today = TODAY();
  const candidates = db.shows.filter(x => !x.dropped && !isFootballShow(x));

  const found = await mapLimit(candidates, 6, async (s) => {
    const mark = furthestWatched(s);
    const head = await tmdb(`tv/${s.id}`);
    const all = (head.seasons || []).filter(x => x.season_number > 0)
      .map(x => x.season_number).sort((a, b) => a - b);
    const from = all.filter(n => n >= mark.season);
    const b = await showBundle(s.id, (from.length ? from : all).slice(-4));
    const seen = new Set(s.watched_episodes);
    for (const info of (b.seasons || []).filter(x => x.season_number > 0)) {
      for (const ep of seasonEps(b, info.season_number)) {
        const code = `S${info.season_number}E${ep.episode_number}`;
        const air = (ep.air_date || '').trim();
        if (!seen.has(code) && air && air > today) {
          return { id: s.id, name: s.name, poster: s.poster_path || b.poster_path,
                   backdrop: b.backdrop_path,
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
  if (!partial) { feedCache.sig = sig; feedCache.ts = Date.now(); }
  persistFeedCache();
  return rows;
}

/* Sorting shared by both feeds. */
/** When did you last watch anything from this show? Built once per sort. */
function lastWatchedIndex() {
  const idx = {};
  for (const h of history) {
    const cur = idx[h.item];
    if (!cur || h.at > cur) idx[h.item] = h.at;
  }
  return idx;
}

const daysSince = (isoish) => {
  if (!isoish) return 9999;
  const t = new Date(String(isoish).slice(0, 10) + 'T00:00:00Z');
  return isNaN(t) ? 9999 : Math.max(0, (now() - t) / 86400000);
};

/** Smart priority.

    "Newest" sorts by the EPISODE's air date, so a 2024 series you started
    yesterday ranks below anything that aired last week — which is why a
    current binge could sit far down the list.

    This scores two things instead:
      activity  — how recently YOU watched that show (weighted highest)
      freshness — how recently the next episode aired
    An active binge rises to the top without permanently outranking a show
    whose new episode just dropped. */
function smartScore(row, lastIdx) {
  const mine = daysSince(lastIdx[String(row.id)]);
  const aired = daysSince(row.date);
  const activity = mine >= 9999 ? 0 : 100 * Math.exp(-mine / 21);   // ~3 week half-life
  const freshness = aired >= 9999 ? 0 : 60 * Math.exp(-aired / 30);
  const started = mine < 9999 ? 15 : 0;          // continuing beats never-started
  return activity * 2 + freshness + started;
}

function sortFeed(rows, mode, desc) {
  const out = [...rows];
  if (mode === 'alpha') {
    out.sort((a, b) => a.name.localeCompare(b.name));
  } else if (mode === 'smart') {
    const lastIdx = lastWatchedIndex();
    out.forEach(r => { r._score = smartScore(r, lastIdx); });
    out.sort((a, b) => b._score - a._score || (b.date || '').localeCompare(a.date || ''));
  } else {
    out.sort((a, b) => desc ? (b.date || '').localeCompare(a.date || '')
                            : (a.date || '9999').localeCompare(b.date || '9999'));
  }
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
  b.addEventListener('click', (e) => {
    if (b._suppress) { b._suppress = false; return; }   // long-press handled it
    onOpen(e);
  });

  if (quick) {
    // Hold a poster for quick actions, so the commonest job skips a screen.
    let timer = null, moved = false;
    const start = () => { moved = false; timer = setTimeout(() => {
      if (!moved) { b._suppress = true; buzz(20); quickMenu(quick); } }, 480); };
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

/** Quick actions for any row, so long-press works everywhere — previously
    only library posters had them, which is why it seemed to do nothing. */
function quickFor(kind, id, name, opts = {}) {
  const actions = [['Open', opts.open]];
  if (kind === 'movie') {
    const on = movieWatched(id);
    actions.push([on ? 'Unmark watched' : 'Mark watched', async () => {
      if (await guardedWrite('toggle film', () => setMovie(id, !on, { name }))) {
        buzz(); toast(on ? 'Unmarked' : 'Logged'); render();
      }
    }]);
  } else if (opts.code) {
    const on = epWatched(id, opts.code);
    actions.push([on ? `Unmark ${opts.code}` : `Mark ${opts.code} watched`, async () => {
      if (await guardedWrite('toggle episode', () => setEpisode(id, opts.code, !on, { name }))) {
        buzz(); toast(on ? 'Unmarked' : `${opts.code} logged`); render();
      }
    }]);
    if (on) actions.push(['\u21bb Watch again', async () => {
      if (await guardedWrite('rewatch', () => rewatchEpisode(id, opts.code, { name }))) {
        buzz(); toast(`${opts.code} logged again`); render();
      }
    }]);
    actions.push(['Open series', () => openShow(id, name)]);
  }
  return { title: name, actions };
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
      .map(p => `<img loading="lazy" decoding="async" src="${imgUrl(p.logo_path, 'w92')}" title="${esc(p.provider_name)}">`).join('') +
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
  const fresh = feedFresh();
  const cached = feedCache.next;

  // Paint as results arrive rather than after the whole library is scanned.
  // A cold start used to sit on "Checking your shows…" for up to 40 seconds
  // because every unfinished show had to resolve before the first pixel.
  let painted = false;
  let scanning = !cached;
  const draw = (rows) => { paintNext(v, rows, scanning); painted = true; };

  if (!cached) {
    v.innerHTML = '<div class="spinner">Checking your shows… <b class="prog"></b></div>';
    v.appendChild(skeletonGrid(6));
  }
  const progEl = v.querySelector('.prog');

  const all = cached || await computeNext(
    (d, t) => { if (!painted && progEl) progEl.textContent = `${d}/${t}`; },
    (partial) => {
      // First few hits are enough to show something useful.
      if (partial.length >= 3 || painted) draw(partial);
    });

  scanning = false;
  draw(all);

  if (cached && !fresh) {
    const note = el('div', 'refreshing', 'Updating in the background…');
    v.prepend(note);
    computeNext().then(() => { if (view === 'next') render(); }).catch(() => {});
  }
}

/** Draws the Up Next view. Called repeatedly while a scan is still running. */
/** Wide backdrop card for Continue Watching (Apple TV, Netflix).
    Swipe right to mark the episode watched — the tracker's most common action
    in one thumb movement, with Undo in the toast. */
function cwCard(r, opts = {}) {
  const show = getShow(r.id);
  const total = show?.total_episodes || 0;
  const pct = total ? Math.min(1, countedEps(show) / total) : 0;
  const art = r.src === 'football' ? null : (r.backdrop || r.poster);
  const wide = !!r.backdrop;

  const wrap = el('div', 'cw');
  wrap.innerHTML = `
    <div class="cw-under"><span>✓</span><b>Watched</b></div>
    <div class="cw-card" role="button" tabindex="0">
      ${r.src === 'football' ? fixturePosterHtml(r)
        : art ? `<img loading="lazy" decoding="async" class="cw-art${wide ? '' : ' cw-poster'}" src="${imgUrl(art, wide ? 'w780' : 'w500')}" alt="">` : ''}
      <span class="cw-shade"></span>
      <span class="cw-text">
        <span class="cw-code">${esc(r.src === 'football' ? 'Matchday ' + (r.matchday ?? '') : r.movie ? 'Film' : (r.code || ''))}
          ${r.date ? `<i>${esc(r.date > TODAY() ? countdown(r.date) : relDay(r.date))}</i>` : ''}</span>
        ${opts.badge ? `<span class="cw-badge">${esc(opts.badge)}</span>` : ''}
        <span class="cw-title">${esc(r.name)}</span>
        <span class="cw-ep">${esc(r.epName || '')}</span>
      </span>
      ${total && r.src !== 'football' ? `<span class="cw-prog"><span style="width:${(pct * 100).toFixed(1)}%"></span></span>` : ''}
    </div>`;

  const card = wrap.querySelector('.cw-card');
  let x0 = 0, y0 = 0, dx = 0, axis = null, moved = false;

  card.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; axis = null; moved = false;
    card.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (axis === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    if (axis !== 'x' || opts.swipe === false) return;
    moved = true;
    dx = Math.max(0, mx);
    card.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle('armed', dx > card.offsetWidth * .32);
  }, { passive: true });

  card.addEventListener('touchend', async () => {
    card.style.transition = 'transform .3s cubic-bezier(.2,.9,.25,1)';
    const swipeable = opts.swipe !== false;
    if (swipeable && axis === 'x' && dx > card.offsetWidth * .32) {
      card.style.transform = 'translateX(110%)';
      buzz(14);
      const mark = (on) => r.movie ? setMovie(r.id, on, { name: r.name })
                                   : setEpisode(r.id, r.code, on, { name: r.name });
      const ok = await guardedWrite('swipe mark', () => mark(true));
      if (ok) {
        invalidateFeeds();
        toastAction(`${r.movie ? r.name : r.code} watched`, 'Undo', async () => {
          if (await guardedWrite('undo', () => mark(false))) { invalidateFeeds(); render(); }
        });
        setTimeout(() => render(), 260);
      } else {
        card.style.transform = '';
      }
    } else {
      card.style.transform = '';
      wrap.classList.remove('armed');
    }
  });

  card.addEventListener('click', () => { if (!moved) openRow(r); });

  // Films and some cached rows arrive with only a poster. Show that blurred at
  // once, then swap in the real backdrop when TMDB returns it.
  if (!r.backdrop && r.src !== 'football') {
    tmdb(`${r.movie ? 'movie' : 'tv'}/${r.id}`).then(d => {
      if (!d || !d.backdrop_path) return;
      r.backdrop = d.backdrop_path;
      const img = wrap.querySelector('.cw-art');
      if (img) { img.src = imgUrl(d.backdrop_path, 'w780'); img.classList.remove('cw-poster'); }
    }).catch(() => {});
  }
  return wrap;
}

/** "Yesterday", "3 days ago" — friendlier than a raw date. */
function relDay(date) {
  const d = Math.round(daysSince(date));
  if (d <= 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 30) return `${Math.round(d / 7)} wk ago`;
  if (d < 365) return `${Math.round(d / 30)} mo ago`;
  return `${Math.round(d / 365)} yr ago`;
}

function paintNext(v, all, scanning) {
  v.innerHTML = '';

  if (scanning) {
    v.appendChild(el('div', 'refreshing', 'Still checking the rest of your library…'));
  } else if (all.partial) {
    v.appendChild(el('div', 'banner', `<strong>Partial results</strong>
      Some shows took too long to load. Pull down to refresh, or check your connection.`));
  }

  v.appendChild(segmented([['Series', 'tv'], ['Films', 'movie']], feedKind,
    k => { feedKind = k; render(); }, 2));
  v.appendChild(segmented([['Smart', 'smart'], ['Newest', 'date'], ['A–Z', 'alpha']], nextSort,
    m => { nextSort = m; render(); }, 2));

  let rows = all.filter(r => (r.kind || 'tv') === feedKind);
  if (feedKind === 'movie') {
    rows = db.movies.filter(m => !m.dropped && !movieWatched(m.id) && m.status !== 'hold'
        && (m.release_date || '') && (m.release_date || '') <= TODAY())
      .map(m => ({ id: m.id, name: m.name, poster: m.poster_path, movie: true,
                   date: m.release_date, kind: 'movie' }));
  }
  rows = sortFeed(rows, nextSort, true);

  if (!rows.length) {
    v.appendChild(emptyState(scanning ? 'Looking…' : 'All caught up',
      scanning ? 'Checking your library for episodes you have not seen.'
      : feedKind === 'tv' ? 'Nothing waiting. Add a show and it will show up here.'
                          : 'No unwatched films in your library.',
      scanning ? null : { label: 'Find something', onClick: () => { view = 'search'; render(); } }));
    return;
  }

  v.appendChild(el('div', 'cw-hint', 'Swipe right to mark watched'));
  if (feedKind === 'tv') {
    const list = el('div', 'cw-list');
    rows.slice(0, nextLimit).forEach(r => list.appendChild(cwCard(r)));
    v.appendChild(list);
    if (rows.length > nextLimit) {
      const more = el('button', 'btn', `Show ${Math.min(30, rows.length - nextLimit)} more`);
      more.style.cssText = 'width:100%;margin-top:12px';
      more.onclick = () => { nextLimit += 30; render(); };
      v.appendChild(more);
    }
    return;
  }

  // Films get the same cards — consistency beats a separate poster grid.
  const list = el('div', 'cw-list');
  rows.slice(0, nextLimit).forEach(r => list.appendChild(cwCard({ ...r, movie: true })));
  v.appendChild(list);
  if (rows.length > nextLimit) {
    const more = el('button', 'btn', `Show ${Math.min(30, rows.length - nextLimit)} more`);
    more.style.cssText = 'width:100%;margin-top:12px';
    more.onclick = () => { nextLimit += 30; render(); };
    v.appendChild(more);
  }
}

let calDay = null;            // selected day in the week strip; null = everything
let airEnriching = false;

async function renderSoon(v) {
  const fresh = feedFresh();
  const cached = feedCache.soon;
  if (!cached) {
    v.innerHTML = '<div class="spinner">Checking schedules… <b class="prog"></b></div>';
    v.appendChild(skeletonGrid(4));
  }
  const progEl = v.querySelector('.prog');
  const all = cached || await computeSoon(
    (d, t) => { if (progEl) progEl.textContent = `${d}/${t}`; });
  v.innerHTML = '';

  if (cached && !fresh) {
    v.appendChild(el('div', 'refreshing', 'Updating in the background…'));
    computeSoon().then(() => { if (view === 'soon') render(); }).catch(() => {});
  }

  // Exact air times arrive after the first paint, then the view repaints once.
  if (!airEnriching && all.some(r => !r.movie && r.src !== 'football' && r.airAt === undefined)) {
    airEnriching = true;
    enrichAirTimes(all).then(changed => {
      airEnriching = false;
      if (changed) { persistFeedCache(); if (view === 'soon') render(); }
    }).catch(() => { airEnriching = false; });
  }

  v.appendChild(segmented([['Series', 'tv'], ['Films', 'movie']], feedKind,
    k => { feedKind = k; calDay = null; render(); }, 2));

  const pool = all.filter(r => (r.kind || 'tv') === feedKind)
    .map(r => ({ ...r, _at: r.airAt || `${(r.date || '9999-12-31').slice(0, 10)} 99:99` }))
    .sort((a, b) => a._at.localeCompare(b._at));

  if (!pool.length) {
    v.appendChild(emptyState('Nothing scheduled',
      'When something in your library has a release date, it lands here.'));
    return;
  }

  // ---- week strip: today plus the next 13 days, in Dubai time ----
  const counts = {};
  pool.forEach(r => { const d = (r.airAt || r.date || '').slice(0, 10); counts[d] = (counts[d] || 0) + 1; });
  const strip = el('div', 'cal-strip');
  const base = new Date(TODAY() + 'T00:00:00Z');
  const allBtn = el('button', 'cal-day cal-all' + (calDay ? '' : ' on'), '<b>All</b><i>' + pool.length + '</i>');
  allBtn.onclick = () => { calDay = null; render(); };
  strip.appendChild(allBtn);
  for (let k = 0; k < 14; k++) {
    const d = new Date(base.getTime() + k * 86400000);
    const key = d.toISOString().slice(0, 10);
    const n = counts[key] || 0;
    const b = el('button', 'cal-day' + (calDay === key ? ' on' : '') + (n ? '' : ' empty'));
    b.innerHTML = `<span>${k === 0 ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span>
      <b>${d.getUTCDate()}</b><i>${n ? '•'.repeat(Math.min(n, 3)) : ''}</i>`;
    b.onclick = () => { calDay = calDay === key ? null : key; buzz(6); render(); };
    strip.appendChild(b);
  }
  v.appendChild(strip);

  const rows = calDay ? pool.filter(r => (r.airAt || r.date || '').slice(0, 10) === calDay) : pool;
  if (!rows.length) {
    v.appendChild(emptyState('Nothing that day', 'Pick another day, or tap All.'));
    return;
  }

  const dayLabel = (d) => {
    const n = Math.round((new Date(d + 'T00:00:00Z') - base) / 86400000);
    if (n <= 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    if (n < 7) return new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    return new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  };

  const shown = rows.slice(0, soonLimit);
  let lastDay = '';
  const list = el('div', 'cw-list');
  for (const r of shown) {
    const d = (r.airAt || r.date || '').slice(0, 10);
    if (d && d !== lastDay) { lastDay = d; list.appendChild(el('div', 'day-head', esc(dayLabel(d)))); }
    const badge = r.airAt ? `${r.airAt.slice(11, 16)} · ${countdownAt(r.airAt)}` : countdown(r.date);
    list.appendChild(cwCard(r.src === 'football' ? r : { ...r, movie: !!r.movie },
      { swipe: false, badge }));
  }
  v.appendChild(list);

  if (rows.length > soonLimit) {
    const more = el('button', 'btn', `Show ${Math.min(30, rows.length - soonLimit)} more`);
    more.style.cssText = 'width:100%;margin-top:12px';
    more.onclick = () => { soonLimit += 30; render(); };
    v.appendChild(more);
  }

  const timed = rows.filter(r => r.airAt).length;
  v.appendChild(el('div', 'attrib',
    `Times are Dubai time · ${timed} of ${rows.length} exact, the rest by date · air times from TVmaze`));
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

  /* Discover as shelves: several categories visible at once, each scrolling
     sideways, instead of one grid chosen by pill. Shelves fill in as their
     data arrives, so a slow one never holds up the rest. */
  const showDiscover = async () => {
    results.innerHTML = '';
    const m = now(), y = m.getUTCFullYear(), mo = m.getUTCMonth() + 1;
    const first = `${y}-${String(mo).padStart(2, '0')}-01`;
    const last = `${y}-${String(mo).padStart(2, '0')}-${new Date(Date.UTC(y, mo, 0)).getUTCDate()}`;
    const monthName = m.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

    const SHELVES = [
      ['Trending series',            'tv',    () => tmdb('trending/tv/week')],
      ['Trending films',             'movie', () => tmdb('trending/movie/week')],
      [`K-dramas · ${monthName}`,    'tv',    () => tmdb('discover/tv', { with_original_language: 'ko', sort_by: 'popularity.desc', 'first_air_date.gte': first, 'first_air_date.lte': last })],
      [`K-movies · ${monthName}`,    'movie', () => tmdb('discover/movie', { with_original_language: 'ko', sort_by: 'popularity.desc', 'primary_release_date.gte': first, 'primary_release_date.lte': last })],
      ['Top rated series',           'tv',    () => tmdb('tv/top_rated')],
      ['Top rated films',            'movie', () => tmdb('movie/top_rated')],
      ['Comedy',                     'tv',    () => tmdb('discover/tv', { with_genres: 35, sort_by: 'popularity.desc' })],
      ['Crime & thrillers',          'tv',    () => tmdb('discover/tv', { with_genres: 80, sort_by: 'popularity.desc' })],
      ['Sci-fi & fantasy',           'tv',    () => tmdb('discover/tv', { with_genres: 10765, sort_by: 'popularity.desc' })],
      ['Action films',               'movie', () => tmdb('discover/movie', { with_genres: 28, sort_by: 'popularity.desc' })],
      ['Horror films',               'movie', () => tmdb('discover/movie', { with_genres: 27, sort_by: 'popularity.desc' })],
    ];

    for (const [title, kind, load] of SHELVES) {
      const shelf = el('section', 'shelf');
      shelf.innerHTML = `<div class="shelf-h">${esc(title)}</div><div class="shelf-row"></div>`;
      const row = shelf.querySelector('.shelf-row');
      for (let k = 0; k < 6; k++) row.appendChild(el('div', 'skel shelf-skel'));
      results.appendChild(shelf);

      load().then(res => {
        const items = (res && res.results || []).filter(x => x.poster_path).slice(0, 16);
        if (!items.length) { shelf.remove(); return; }
        row.innerHTML = '';
        items.forEach(i => {
          const name = i.name || i.title;
          const open = () => kind === 'tv' ? openShow(i.id, name) : openMovie(i.id, name);
          const owned = kind === 'tv' ? getShow(i.id) : getMovie(i.id);
          const tile = posterEl({ title: name, poster: i.poster_path, onOpen: open,
            badge: owned ? 'In library' : null,
            quick: quickFor(kind, i.id, name, { open }) });
          tile.classList.add('shelf-tile');
          row.appendChild(tile);
        });
      }).catch(() => shelf.remove());
    }

    if (footballEnabled()) {
      const fb = el('section', 'shelf');
      fb.appendChild(el('div', 'shelf-h', 'Football'));
      const body = el('div');
      fb.appendChild(body);
      results.appendChild(fb);
      renderFootballDiscover(body).catch(() => fb.remove());
    }
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
      onOpen: () => i.kind === 'tv' ? openShow(i.id, i.name) : openMovie(i.id, i.title),
      quick: quickFor(i.kind, i.id, i.name || i.title,
        { open: () => i.kind === 'tv' ? openShow(i.id, i.name) : openMovie(i.id, i.title) }) }))));
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
    body.appendChild(el('div', 'section-head', `K-dramas · ${monthName}`));
    body.appendChild(gridOf(tvList.map(i => ({
      title: i.name, poster: i.poster_path,
      badge: (i.first_air_date || '').slice(5) || null,
      onOpen: () => openShow(i.id, i.name) }))));
  }
  if (mvList.length) {
    body.appendChild(el('div', 'section-head', `K-movies · ${monthName}`));
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
  // One toolbar: search, sort and Series/Films together. This used to be four
  // stacked rows of controls before the first poster.
  const bar = el('div', 'lib-bar');
  const input = el('input');
  input.type = 'search';
  input.placeholder = libKind === 'tv' ? 'Search your shows' : 'Search your films';
  input.value = libQuery;
  bar.appendChild(input);

  const SORTS = [['date', 'Recent'], ['alpha', 'A–Z'], ['prog', 'Progress']];
  const sortBtn = el('button', 'lib-sort', esc((SORTS.find(x => x[0] === libSort) || SORTS[0])[1]));
  sortBtn.onclick = () => {
    const k = SORTS.findIndex(x => x[0] === libSort);
    libSort = SORTS[(k + 1) % (libKind === 'tv' ? 3 : 2)][0];
    buzz(5); renderLibrary(v);
  };
  bar.appendChild(sortBtn);

  const kind = el('div', 'lib-kind');
  [['tv', 'Series'], ['movie', 'Films']].forEach(([k, label]) => {
    const b = el('button', libKind === k ? 'on' : '', label);
    b.onclick = () => { if (libKind === k) return; libKind = k; libLimit = 60; buzz(5); renderLibrary(v); };
    kind.appendChild(b);
  });
  bar.appendChild(kind);
  v.appendChild(bar);

  input.addEventListener('input', () => {
    libQuery = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { libLimit = 60; renderLibrary(v); const b = v.querySelector('input'); if (b) { b.focus(); b.setSelectionRange(999, 999); } }, 250);
  });

  // Legacy filter names from older builds map onto statuses.
  libFilter = { WATCHLIST: 'plan', WATCHING: 'watching', WATCHED: 'completed', DROPPED: 'dropped' }[libFilter] || libFilter;
  const statusCounts = {};
  (libKind === 'tv' ? db.shows : db.movies).forEach(x => {
    const st = effectiveStatus(x, libKind === 'tv' ? 'tv' : 'movie');
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  });
  const pills = el('div', 'status-pills');
  STATUSES.forEach(([key, label]) => {
    const b = el('button', 'spill' + (libFilter === key ? ' on' : ''),
      `${esc(label)}<i>${statusCounts[key] || 0}</i>`);
    b.onclick = () => { libFilter = key; libLimit = 60; buzz(6); renderLibrary(v); };
    pills.appendChild(b);
  });
  v.appendChild(pills);


  const today = TODAY();
  const q = libQuery.trim().toLowerCase();
  let items;

  if (libKind === 'tv') {
    items = db.shows.filter(s => {
      if (q && !String(s.name).toLowerCase().includes(q)) return false;
      const w = countedEps(s), t = s.total_episodes || 0;
      const done = t > 0 && w >= t;
      return effectiveStatus(s, 'tv') === libFilter;
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
      return effectiveStatus(m, 'movie') === libFilter;
    });
    if (libSort === 'alpha') items.sort((a, b) => a.name.localeCompare(b.name));
    else items.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
  }

  if (!items.length) {
    v.appendChild(emptyState(q ? 'No matches' : 'Nothing here yet',
      q ? `Nothing in this tab matches “${libQuery}”.`
: ({ dropped: 'Anything you drop collects here.', hold: 'Shows you pause collect here.',
                   completed: 'Finished shows collect here.' }[libFilter] || 'Search for something to add it.'),
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

const CHART_COLORS = ['#8FA8FF', '#FF8A65', '#4FC3F7', '#AED581', '#BA68C8',
                      '#F06292', '#4DB6AC', '#9FA8DA', '#90A4AE', '#A1887F'];

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

/** You: three tabs instead of seven.

    Stats, Year, Records and Health were four views of the same history and read
    like a settings menu. They are now one scrolling Insights page. Recaps appear
    as a banner when one is ready, and the archive sits at the foot of Insights. */
/* ------------------------------------------------------------------
   RECAP ENGINE (v2)
   One pure function over your history and library that turns a period —
   "2025" or "2026-09" — into findings worth a card each. Borrowed ideas:
   Discovery / Loyalty / Comebacks and milestones (Apple Replay), viewer
   style and era (Spotify), busiest week and weekday (Letterboxd). Every
   number is computed from what you actually watched; nothing generated.
   ------------------------------------------------------------------ */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function recapInsights(prefix) {
  const isYear = prefix.length === 4;
  const rows = history.filter(h => h.at && h.at.startsWith(prefix)).sort((a, b) => a.at.localeCompare(b.at));
  if (!rows.length) return null;
  const all = history.filter(h => h.at).sort((a, b) => a.at.localeCompare(b.at));
  const start = rows[0].at, nameOf = (h) => (h.type === 'tv' ? getShow(h.item) : getMovie(h.item))?.name || '';
  const minutesOf = (h) => h.type === 'movie' ? (getMovie(h.item)?.runtime || MOVIE_MINUTES)
                          : isFootballShow(getShow(h.item)) ? MATCH_MINUTES : EPISODE_MINUTES;

  // ---- totals ----
  const eps = rows.filter(h => h.type === 'tv').length, films = rows.length - eps;
  const minutes = rows.reduce((n, h) => n + minutesOf(h), 0);
  const days = {}; rows.forEach(h => { (days[h.at.slice(0, 10)] ||= []).push(h); });

  // ---- top shows ----
  const perShow = {};
  rows.forEach(h => { if (h.type === 'tv') perShow[h.item] = (perShow[h.item] || 0) + 1; });
  const top = Object.entries(perShow).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, n]) => ({ id, n, show: getShow(id) })).filter(x => x.show);

  // ---- discovery / loyalty / comebacks ----
  const firstSeen = {}, lastBefore = {}, yearsBefore = {};
  for (const h of all) {
    if (h.type !== 'tv') continue;
    if (!firstSeen[h.item]) firstSeen[h.item] = h.at;
    if (h.at < start) { lastBefore[h.item] = h.at; (yearsBefore[h.item] ||= new Set()).add(h.at.slice(0, 4)); }
  }
  const inPeriod = Object.keys(perShow);
  const discovered = inPeriod.filter(id => firstSeen[id] && firstSeen[id].startsWith(prefix))
    .map(id => ({ id, show: getShow(id), n: perShow[id] })).filter(x => x.show).sort((a, b) => b.n - a.n);
  const loyal = inPeriod.map(id => ({ id, show: getShow(id), years: (yearsBefore[id] || new Set()).size }))
    .filter(x => x.show && x.years >= 2).sort((a, b) => b.years - a.years);
  const comebacks = inPeriod.filter(id => lastBefore[id]).map(id => {
      const back = rows.find(h => h.item === id).at;
      return { id, show: getShow(id), gap: Math.round((new Date(back.slice(0, 10)) - new Date(lastBefore[id].slice(0, 10))) / 86400000), back };
    }).filter(x => x.show && x.gap >= 180).sort((a, b) => b.gap - a.gap);

  // ---- rhythm ----
  const wd = Array(7).fill(0);
  rows.forEach(h => { wd[new Date(h.at.slice(0, 10) + 'T12:00:00Z').getUTCDay()]++; });
  const favDay = wd.indexOf(Math.max(...wd));
  const weeks = {};
  rows.forEach(h => {
    const d = new Date(h.at.slice(0, 10) + 'T12:00:00Z');
    const mon = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    weeks[mon] = (weeks[mon] || 0) + 1;
  });
  const busyWeek = Object.entries(weeks).sort((a, b) => b[1] - a[1])[0];
  const bigDay = Object.entries(days).sort((a, b) => b[1].length - a[1].length)[0];
  const bigDayShow = bigDay ? Object.entries(bigDay[1].reduce((m, h) => (m[h.item] = (m[h.item] || 0) + 1, m), {}))
    .sort((a, b) => b[1] - a[1])[0] : null;
  // ---- era: when was what you watched made? ----
  const yearsMade = rows.map(h => {
    const it = h.type === 'tv' ? getShow(h.item) : getMovie(h.item);
    return +String((it && (it.first_air_date || it.release_date)) || '').slice(0, 4);
  }).filter(y => y > 1900);
  const era = yearsMade.length ? Math.round(yearsMade.reduce((a, b) => a + b, 0) / yearsMade.length) : null;
  const decades = {};
  yearsMade.forEach(y => { const d = `${Math.floor(y / 10) * 10}s`; decades[d] = (decades[d] || 0) + 1; });

  // ---- milestones crossed inside the period ----
  const MARKS = [100, 250, 500, 1000, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 8000, 9000, 10000, 12500, 15000];
  const milestones = [];
  all.forEach((h, i) => {
    if (MARKS.includes(i + 1) && h.at.startsWith(prefix)) milestones.push({ n: i + 1, at: h.at, name: nameOf(h), code: h.code });
  });

  // ---- you versus you ----
  let versus = null;
  if (isYear) {
    const byYear = {}; all.forEach(h => { byYear[h.at.slice(0, 4)] = (byYear[h.at.slice(0, 4)] || 0) + 1; });
    const ranked = Object.entries(byYear).sort((a, b) => b[1] - a[1]);
    const rank = ranked.findIndex(([y]) => y === prefix) + 1;
    versus = { rank, of: ranked.length, best: ranked[0] };
  } else {
    const mm = prefix.slice(5), sameMonth = {};
    all.forEach(h => { if (h.at.slice(5, 7) === mm) sameMonth[h.at.slice(0, 4)] = (sameMonth[h.at.slice(0, 4)] || 0) + 1; });
    const mine = sameMonth[prefix.slice(0, 4)] || 0;
    const beatenSince = Object.entries(sameMonth).filter(([y, n]) => y < prefix.slice(0, 4) && n >= mine)
      .map(([y]) => +y).sort((a, b) => b - a)[0];
    const byMonth = {}; all.forEach(h => { byMonth[h.at.slice(0, 7)] = (byMonth[h.at.slice(0, 7)] || 0) + 1; });
    const monthRank = Object.values(byMonth).filter(n => n > mine).length + 1;
    versus = { mine, beatenSince: beatenSince || null, monthRank, months: Object.keys(byMonth).length };
  }

  // ---- viewer style: what was distinctive about THIS period, judged against
  //      your own baseline. Absolute thresholds made you "The Night Owl" every
  //      single month, because you are one — true, but not an insight. ----
  const traits = (list) => {
    const d = {}; list.forEach(h => { (d[h.at.slice(0, 10)] ||= 0); d[h.at.slice(0, 10)]++; });
    const active = Object.keys(d).length || 1;
    const showsSet = new Set(list.filter(h => h.type === 'tv').map(h => h.item));
    const nightN = list.filter(h => { const hr = +h.at.slice(11, 13); return hr < 5; }).length;
    const made = list.map(h => {
      const it = h.type === 'tv' ? getShow(h.item) : getMovie(h.item);
      return +String((it && (it.first_air_date || it.release_date)) || '').slice(0, 4);
    }).filter(y => y > 1900);
    return {
      night: nightN / Math.max(1, list.length),
      binge: list.length / active,
      juggle: showsSet.size / Math.max(1, active / 7),            // shows per active week
      films: list.filter(h => h.type === 'movie').length / Math.max(1, list.length),
      old: made.length ? made.filter(y => y < 2012).length / made.length : 0,
    };
  };
  // Compare like with like: a year against your other years, a month against
  // your other months. Measuring one year against the whole decade made every
  // year look like juggling, because over ten years each show counts once.
  const groups = {};
  all.forEach(h => { const k = h.at.slice(0, isYear ? 4 : 7); (groups[k] ||= []).push(h); });
  const peers = Object.entries(groups).filter(([k, list]) => k !== prefix && list.length >= (isYear ? 100 : 20))
    .map(([, list]) => traits(list));
  const mineT = traits(rows);
  const avg = (key, onlyIf) => {
    const xs = peers.filter(t => !onlyIf || onlyIf(t)).map(t => t[key]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : mineT[key];
  };
  // Films only count against periods where films were actually logged — the
  // TV Time import carried no film dates, so older periods would skew it.
  const baseT = { night: avg('night'), binge: avg('binge'), juggle: avg('juggle'),
                  films: avg('films', t => t.films > 0), old: avg('old') };
  const activeDays = Object.keys(days).length;
  const STYLES = {
    night:  ['The Night Owl',      (r) => `${Math.round(mineT.night * 100)}% after midnight, against your usual ${Math.round(baseT.night * 100)}%.`],
    binge:  ['The Binger',         (r) => `${mineT.binge.toFixed(1)} a sitting, against your usual ${baseT.binge.toFixed(1)}.`],
    juggle: ['The Juggler',        (r) => `${inPeriod.length} shows on the go — more spread out than your typical ${isYear ? 'year' : 'month'}.`],
    films:  ['The Cinephile',      (r) => `Films made up ${Math.round(mineT.films * 100)}% of what you watched.`],
    old:    ['The Time Traveller', (r) => `Older shows than you usually reach for.`],
  };
  let bestKey = null, bestLift = 1.15;               // must stand out by at least 15%
  for (const k of Object.keys(STYLES)) {
    const base = Math.max(baseT[k], 0.01), lift = mineT[k] / base;
    if (mineT[k] > 0 && lift > bestLift) { bestLift = lift; bestKey = k; }
  }
  const style = bestKey ? [STYLES[bestKey][0], STYLES[bestKey][1]()]
                        : ['The Steady Viewer', `${activeDays} days with something on — classic you.`];
  const night = rows.filter(h => +h.at.slice(11, 13) < 5).length;

  return {
    prefix, isYear, total: rows.length, eps, films, hours: Math.round(minutes / 60), activeDays,
    top, first: { at: rows[0].at, name: nameOf(rows[0]), code: rows[0].code },
    last: { at: rows[rows.length - 1].at, name: nameOf(rows[rows.length - 1]), code: rows[rows.length - 1].code },
    discovered, loyal, comebacks, favDay: WEEKDAYS[favDay], weekdayCounts: wd,
    busyWeek: busyWeek ? { from: busyWeek[0], n: busyWeek[1] } : null,
    bigDay: bigDay ? { at: bigDay[0], n: bigDay[1].length, show: getShow(bigDayShow && bigDayShow[0]), showN: bigDayShow && bigDayShow[1] } : null,
    night, era, decades, milestones, versus, style, days,
  };
}

/* ------------------------------------------------------------------
   RECAP v2 — the screens.
   Magazine pacing from Spotify (you move at your own speed, with a
   contents page to jump around), the long view from Apple, the detail
   from Letterboxd — and two things only this app can do: a palette
   sampled from the posters you watched, and a barcode of your days.
   ------------------------------------------------------------------ */
function colourName([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn, l = (mx + mn) / 2;
  if (d < .09) return l > .72 ? 'silver' : l > .35 ? 'slate' : 'charcoal';
  let h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return [[14, 'red'], [32, 'coral'], [48, 'amber'], [64, 'gold'], [95, 'olive'], [150, 'green'], [182, 'teal'],
          [205, 'cyan'], [238, 'blue'], [262, 'indigo'], [290, 'violet'], [335, 'magenta'], [361, 'red']].find(([m]) => h < m)[1];
}

const dayKey = (rows) => {
  if (!rows || !rows.length) return '';
  const c = {}; rows.forEach(h => { const k = h.type + ':' + h.item; c[k] = (c[k] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
};

function periodDates(prefix) {
  const out = [], today = TODAY();
  const start = prefix.length === 4 ? `${prefix}-01-01` : `${prefix}-01`;
  const d = new Date(start + 'T00:00:00Z');
  while (true) {
    const k = d.toISOString().slice(0, 10);
    if (!k.startsWith(prefix) || k > today) break;
    out.push(k);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function colourFor(key) {
  const [type, id] = key.split(':');
  const it = type === 'tv' ? getShow(id) : getMovie(id);
  if (!it || !it.poster_path || isAbs(it.poster_path)) return null;
  return posterColour(it.poster_path).catch(() => null);
}

/** Palette: the colours of what you watched most, near-duplicates merged. */
function buildPalette(ins, colours) {
  const weight = {};
  Object.values(ins.days).flat().forEach(h => { const k = h.type + ':' + h.item; weight[k] = (weight[k] || 0) + 1; });
  const out = [];
  for (const [k, w] of Object.entries(weight).sort((a, b) => b[1] - a[1])) {
    const c = colours[k];
    if (!c) continue;
    if (out.some(o => Math.hypot(o.rgb[0] - c[0], o.rgb[1] - c[1], o.rgb[2] - c[2]) < 60)) continue;
    out.push({ rgb: c, name: colourName(c), w });
    if (out.length === 4) break;
  }
  return out.length ? out : [{ rgb: [143, 168, 255], name: 'blue', w: 1 }];
}

function barcodeHtml(ins, colours) {
  return `<div class="barcode${ins.isYear ? ' year' : ''}">${periodDates(ins.prefix).map((d, n) => {
    const k = dayKey(ins.days[d]); const c = k && colours[k];
    return `<i data-k="${esc(k)}" class="${!k ? 'off' : c ? '' : 'pending'}" style="--i:${n}${c ? `;background:rgb(${c.join(',')})` : ''}"></i>`;
  }).join('')}</div>`;
}

/** Most-watched actor in the period, from credits you've already cached. */
async function recapPeople(ins) {
  const weight = {};
  Object.values(ins.days).flat().forEach(h => {
    const it = h.type === 'tv' ? getShow(h.item) : getMovie(h.item);
    if (!it || (h.type === 'tv' && isFootballShow(it))) return;
    weight[h.type + ':' + h.item] = (weight[h.type + ':' + h.item] || 0) + 1;
  });
  const top = Object.entries(weight).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const actors = {};
  await mapLimit(top, 4, async ([k, w]) => {
    const [type, id] = k.split(':');
    const cr = await tmdb(`${type === 'tv' ? 'tv' : 'movie'}/${id}/credits`).catch(() => ({}));
    (cr.cast || []).slice(0, 8).forEach((p, rank) => {
      const a = (actors[p.id] ||= { id: p.id, name: p.name, p: p.profile_path, score: 0, titles: new Set() });
      a.score += w * (1 - rank * .08);
      a.titles.add((type === 'tv' ? getShow(id) : getMovie(id))?.name || '');
    });
  });
  const best = Object.values(actors).sort((a, b) => b.score - a.score)[0];
  return best ? { ...best, titles: [...best.titles].filter(Boolean) } : null;
}

function countUp(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('[data-count]').forEach(n => {
    const end = +n.dataset.count || 0, fmt = (v) => Math.round(v).toLocaleString();
    if (reduce || end < 2) { n.textContent = fmt(end); return; }
    const t0 = performance.now(), dur = Math.min(1400, 500 + end * 2);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      n.textContent = fmt(end * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function recapSlidesV2(ins, colours, palette, people, art = {}) {
  // ---- imagery: a shuffled pool of what you watched, so every page shows
  //      something different and no title appears twice in a row ----
  const weightOf = {};
  Object.values(ins.days).flat().forEach(h => { const k = h.type + ':' + h.item; weightOf[k] = (weightOf[k] || 0) + 1; });
  const ranked = Object.keys(weightOf).sort((a, b) => weightOf[b] - weightOf[a]);
  const wide = (k) => art[k] && art[k].backdrop ? imgUrl(art[k].backdrop, 'w1280') : '';
  const tall = (k) => { const it = k.startsWith('tv:') ? getShow(k.slice(3)) : getMovie(k.slice(6));
                        return it && it.poster_path && !isAbs(it.poster_path) ? imgUrl(it.poster_path, 'w500') : ''; };
  const pool = ranked.slice(0, 14).filter(k => wide(k));
  for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
  let lastUrl = '';
  const pickFromPool = () => {
    for (let tries = 0; tries < pool.length; tries++) {
      const k = pool.shift(); pool.push(k);
      const u = wide(k);
      if (u && u !== lastUrl) return u;
    }
    return '';
  };
  const keyOf = (show) => show ? 'tv:' + show.id : '';
  const mosaic = ranked.slice(0, 12).map(tall).filter(Boolean).map(u => u.replace('/w500/', '/w185/'));

  const label = ins.isYear ? ins.prefix : prettyMonth(ins.prefix);
  const P = (it, size = 'w342') => it && it.poster_path ? `<img loading="lazy" decoding="async" src="${imgUrl(it.poster_path, size)}" alt="">` : '';
  const gap = (d) => { const y = Math.floor(d / 365), m = Math.floor((d % 365) / 30);
    return [y ? `${y} year${y > 1 ? 's' : ''}` : '', m ? `${m} month${m > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ') || `${d} days`; };
  const fmtDay = (d) => new Date(d.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const v = ins.versus;
  const versusLine = !v ? '' : ins.isYear
    ? (v.rank === 1 ? `Your biggest year of all ${v.of}.`
       : `Your ${['', '', 'second', 'third', 'fourth', 'fifth'][v.rank] || v.rank + 'th'}-biggest year of ${v.of}${v.best ? ` — ${(v.best[1] - ins.total).toLocaleString()} short of ${v.best[0]}` : ''}.`)
    : (v.monthRank === 1 ? 'Your biggest month ever.'
       : v.beatenSince ? `Your biggest ${prettyMonth(ins.prefix).split(' ')[0]} since ${v.beatenSince}.`
       : `Your ${prettyMonth(ins.prefix).split(' ')[0]} record.`);
  const favs = {};
  Object.values(ins.days).flat().forEach(h => { const f = favOf(h); if (f) (favs[f.a] ||= { ...f, count: 0 }).count++; });
  const fav = Object.values(favs).sort((a, b) => b.count - a.count)[0];
  const maxWd = Math.max(1, ...ins.weekdayCounts);
  const decades = Object.entries(ins.decades).sort((a, b) => a[0].localeCompare(b[0]));
  const maxDec = Math.max(1, ...decades.map(d => d[1]));

  const top1 = ins.top[0] && ins.top[0].show;
  const back1 = ins.comebacks[0] && ins.comebacks[0].show;
  const ghost = ins.isYear ? ins.prefix : prettyMonth(ins.prefix).slice(0, 3);
  const serif = (t) => `<span class="sv-serif">${esc(t)}</span>`;

  return [
    { chapter: 'Cover', cls: 'sv-cover', html: () => `
      ${mosaic.length >= 4 ? `<div class="sv-mosaic">${mosaic.concat(mosaic).slice(0, 15).map(u => `<img loading="lazy" decoding="async" src="${u}" alt="">`).join('')}</div>` : ''}
      <div class="sv-ghost">${esc(ghost)}</div>
      <div class="sv-eyebrow">${ins.isYear ? 'Your year on screen' : 'Your month on screen'}</div>
      <div class="sv-title">${esc(label)}</div>
      ${barcodeHtml(ins, colours)}
      <div class="sv-palette">${palette.map((p, k) => `<span style="--k:${k}"><i style="background:rgb(${p.rgb.join(',')})"></i>${esc(p.name)}</span>`).join('')}</div>
      <div class="sv-sub">Every stripe is a day, coloured by the poster of what you watched most.</div>` },

    { chapter: 'The total', page: 'ink', pc: 0, html: `
      <div class="sv-eyebrow">The total</div>
      <div class="sv-huge mega" data-count="${ins.total}">0</div>
      <div class="sv-lede">${serif('things watched')}</div>
      <div class="sv-trio"><div><b data-count="${ins.hours}">0</b><span>hours</span></div>
        <div><b data-count="${ins.activeDays}">0</b><span>days with something on</span></div>
        <div><b data-count="${new Set(Object.values(ins.days).flat().map(h => h.item)).size}">0</b><span>titles</span></div></div>
      ${versusLine ? `<div class="sv-note">${esc(versusLine)}</div>` : ''}` },

    ins.top.length ? { chapter: 'Your shows', bg: wide(keyOf(top1)), html: `
      <div class="sv-eyebrow">On repeat</div>
      <div class="sv-h big">${esc(top1.name)}</div>
      <div class="sv-lede">${serif(`${ins.top[0].n} episodes — your most-watched show`)}</div>
      <div class="sv-podium">${ins.top.slice(0, 5).map((t, k) => `
        <div class="sv-pod${k === 0 ? ' first' : ''}" style="--k:${k}"><span class="sv-rank">${k + 1}</span>${P(t.show)}
          <b>${esc(t.show.name)}</b><i>${t.n}</i></div>`).join('')}</div>` } : null,

    ins.discovered.length ? { chapter: 'Discovery', html: `
      <div class="sv-eyebrow">Discovery</div>
      <div class="sv-huge" data-count="${ins.discovered.length}">0</div>
      <div class="sv-lede">${serif('new shows started')}</div>
      <div class="sv-row">${ins.discovered.slice(0, 4).map((x, k) => `<div class="sv-mini" style="--k:${k}">${P(x.show, 'w185')}<b>${esc(x.show.name)}</b></div>`).join('')}</div>
      ${ins.loyal.length ? `<div class="sv-note">Loyal as ever: <b>${esc(ins.loyal[0].show.name)}</b>, with you across ${ins.loyal[0].years + 1} different years.</div>` : ''}` } : null,

    ins.comebacks.length ? { chapter: 'Comeback', cls: 'sv-comeback', bg: wide(keyOf(back1)), html: `
      <div class="sv-eyebrow">The comeback</div>
      <div class="sv-poster">${P(back1, 'w500')}</div>
      <div class="sv-h big">${esc(back1.name)}</div>
      <div class="sv-lede">${serif(`back after ${gap(ins.comebacks[0].gap)}`)}</div>
      ${ins.comebacks[1] ? `<div class="sv-note">Also back: ${ins.comebacks.slice(1, 3).map(c => `<b>${esc(c.show.name)}</b> after ${esc(gap(c.gap))}`).join(', ')}.</div>` : ''}` } : null,

    { chapter: 'Your rhythm', page: 'ink', pc: 1, html: `
      <div class="sv-eyebrow">Your rhythm</div>
      <div class="sv-h big">${esc(ins.favDay)}s</div>
      <div class="sv-lede">${serif('were your day')}</div>
      <div class="sv-week">${ins.weekdayCounts.map((n, k) => `<div class="${WEEKDAYS[k] === ins.favDay ? 'on' : ''}" style="--k:${k}">
        <span style="height:${Math.max(6, n / maxWd * 100)}%"></span><i>${WEEKDAYS[k].slice(0, 3)}</i></div>`).join('')}</div>
      ${ins.bigDay ? `<div class="sv-note">Biggest day: <b>${ins.bigDay.n}</b> on ${esc(fmtDay(ins.bigDay.at))}${ins.bigDay.show ? ` — ${ins.bigDay.showN} of them ${esc(ins.bigDay.show.name)}` : ''}.</div>` : ''}` },

    ins.era ? { chapter: 'Your era', html: `
      <div class="sv-eyebrow">Your era</div>
      <div class="sv-lede">${serif('Your watching lived in')}</div>
      <div class="sv-huge era mega" data-count="${ins.era}">0</div>
      <div class="sv-dec">${decades.map(([d, n], k) => `<div style="--k:${k}"><i>${esc(d)}</i><span><b style="width:${n / maxDec * 100}%"></b></span><em>${n}</em></div>`).join('')}</div>` } : null,

    (people || fav) ? { chapter: 'Faces', html: `
      <div class="sv-eyebrow">Faces</div>
      ${people ? `<div class="sv-face duo">${people.p ? `<img loading="lazy" decoding="async" src="${imgUrl(people.p, 'w342')}" alt="">` : ''}</div>
        <div class="sv-h big">${esc(people.name)}</div>
        <div class="sv-lede">${serif(`on your screen the most${people.titles.length ? ` — in ${people.titles.slice(0, 2).join(' and ')}` : ''}`)}</div>` : ''}
      ${fav ? `<div class="sv-note">Your favourite character: <b>${esc(fav.c)}</b>, picked ${fav.count}×.</div>` : ''}` } : null,

    ins.milestones.length ? { chapter: 'Milestones', html: `
      <div class="sv-eyebrow">Milestones</div>
      ${ins.milestones.slice(-3).reverse().map((m, k) => `<div class="sv-mile" style="--k:${k}"><b>#${m.n.toLocaleString()}</b>
        <span>${esc(m.name)}${m.code ? ' ' + esc(m.code) : ''}<i>${esc(fmtDay(m.at))}</i></span></div>`).join('')}` } : null,

    { chapter: 'Your style', cls: 'sv-style', page: 'ink', pc: 2, html: `
      <div class="sv-eyebrow">Your style</div>
      <div class="sv-h mega">${esc(ins.style[0])}</div>
      <div class="sv-lede">${serif(ins.style[1])}</div>` },

    { chapter: 'Share', cls: 'sv-share', html: `
      <div class="sv-eyebrow">That was ${esc(label)}</div>
      <div class="sv-sharebox"><div class="sv-spinner">Building your card…</div></div>` },
  ].filter(Boolean).map(sl => {
    // The share page stays clean so the card itself is the picture.
    if (sl.chapter === 'Share' || sl.chapter === 'Cover') return sl;
    // Featured pages set their own still; anything else, or a featured page
    // whose still would repeat the previous page, draws from the pool. One
    // tracker covers both, so no image ever appears twice in a row.
    if (!sl.bg || sl.bg === lastUrl) sl.bg = pickFromPool();
    lastUrl = sl.bg || lastUrl;
    sl.bgMode = sl.page === 'ink' ? 'tint' : 'photo';
    return sl;
  });
}

/** Paged story with a contents page — at your own pace, as Spotify settled on. */
function openStoryV2(items, { palette, onShare, onReady }) {
  let i = 0;
  const body = openSheet('');
  const sheet = $('#sheet');
  sheet.classList.add('story-mode', 'story-v2');
  $('#tabbar').style.display = 'none';
  const [a, b2] = [palette[0], palette[1] || palette[0]];
  sheet.style.setProperty('--rc', a.rgb.join(','));
  sheet.style.setProperty('--rc2', b2.rgb.join(','));

  const wrap = el('div', 'story sv');
  wrap.innerHTML = `<div class="story-bars"></div>
    <div class="sv-top"><button class="sv-contents" aria-label="Contents">${ico('library')}</button><span class="sv-chapter"></span></div>
    <div class="story-stage"></div>
    <div class="story-nav"><button class="sn prev" aria-label="Back"></button><button class="sn next" aria-label="Next"></button></div>
    <div class="story-foot"></div>`;
  body.appendChild(wrap);
  const bars = wrap.querySelector('.story-bars'), stage = wrap.querySelector('.story-stage'), foot = wrap.querySelector('.story-foot');
  bars.innerHTML = items.map(() => '<span><i></i></span>').join('');

  const paint = () => {
    [...bars.children].forEach((x, n) => { x.firstChild.style.width = n <= i ? '100%' : '0%'; });
    const it = items[i];
    // Full-bleed colour pages and poster backdrops, as in a magazine spread.
    wrap.classList.toggle('ink', it.page === 'ink');
    if (it.page === 'ink') wrap.style.setProperty('--pc', (palette[it.pc] || palette[it.pc % palette.length] || palette[0]).rgb.join(','));
    if (it.bg) { wrap.style.setProperty('--svbg', `url("${it.bg}")`); wrap.classList.add('has-bg'); }
    else { wrap.classList.remove('has-bg'); wrap.style.removeProperty('--svbg'); }
    wrap.classList.toggle('tint', it.bgMode === 'tint' && !!it.bg);
    stage.innerHTML = `<div class="story-card sv-card ${it.cls || ''}">${typeof it.html === 'function' ? it.html() : it.html}</div>`;
    stage.firstChild.classList.add('in');
    wrap.querySelector('.sv-chapter').textContent = `${i + 1} / ${items.length} · ${it.chapter}`;
    countUp(stage);
    stage.querySelectorAll('.barcode').forEach(b => b.style.setProperty('--step', b.classList.contains('year') ? '2.2ms' : '22ms'));
    foot.innerHTML = '';
    if (it.chapter === 'Share') {
      const sh = el('button', 'btn gold', 'Share image'); sh.style.width = '100%';
      sh.onclick = () => onShare(sh);
      const dn = el('button', 'btn', 'Done'); dn.style.cssText = 'width:100%;margin-top:8px';
      dn.onclick = () => closeSheet();
      foot.append(sh, dn);
      if (onReady) onReady(stage);
    } else foot.appendChild(el('div', 'story-hint', 'Tap to continue · ' + ico('library') + ' for contents'));
    buzz(5);
  };
  const go = (d) => { const n = i + d; if (n < 0 || n >= items.length) return; i = n; paint(); };
  wrap.querySelector('.sn.next').onclick = () => go(1);
  wrap.querySelector('.sn.prev').onclick = () => go(-1);
  let sx = 0;
  wrap.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  wrap.addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1); });
  wrap.querySelector('.sv-contents').onclick = () => quickMenu({ title: 'Jump to',
    actions: items.map((it, n) => [`${n + 1}. ${it.chapter}`, () => { i = n; paint(); }]) });
  paint();
  return { repaintBarcode: (key, rgb) => {
    // keys look like "tv:1399" — safe inside a quoted attribute selector
    wrap.querySelectorAll(`.barcode i[data-k="${key}"]`).forEach(x => {
      x.style.background = `rgb(${rgb.join(',')})`; x.classList.remove('pending');
    });
  } };
}

/** The share image: 1080×1920, Instagram-story shaped, drawn directly. */
async function renderShareCard(ins, colours, palette) {
  const W = 1080, H = 1920;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  try {
    await Promise.all([document.fonts.load('800 120px "Bricolage Grotesque"'), document.fonts.load('600 40px "Inter"'),
                       document.fonts.load('italic 400 60px "Instrument Serif"')]);
  } catch { /* fall back to system fonts */ }
  const F = (w, px) => `${w} ${px}px "Bricolage Grotesque", system-ui, sans-serif`;
  const UI = (w, px) => `${w} ${px}px "Inter", system-ui, sans-serif`;
  const SERIF = (px) => `italic 400 ${px}px "Instrument Serif", Georgia, serif`;
  const rgb = (p, a = 1) => `rgba(${p.rgb.join(',')},${a})`;

  x.fillStyle = '#07080A'; x.fillRect(0, 0, W, H);
  let g = x.createRadialGradient(W * .2, 0, 0, W * .2, 0, W * 1.1); g.addColorStop(0, rgb(palette[0], .55)); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  g = x.createRadialGradient(W, H, 0, W, H, W * 1.1); g.addColorStop(0, rgb(palette[1] || palette[0], .45)); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);

  const label = ins.isYear ? ins.prefix : prettyMonth(ins.prefix);
  x.fillStyle = 'rgba(255,255,255,.7)'; x.font = UI(700, 32);
  x.fillText((ins.isYear ? 'MY YEAR ON SCREEN' : 'MY MONTH ON SCREEN').split('').join(String.fromCharCode(8202)), 90, 170);
  x.fillStyle = '#fff'; x.font = F(800, ins.isYear ? 210 : 120); x.fillText(label, 80, ins.isYear ? 360 : 320);

  // barcode band
  const dates = periodDates(ins.prefix), bx = 90, bw = W - 180, by = 430, bh = 230, sw = bw / Math.max(1, dates.length);
  x.fillStyle = 'rgba(255,255,255,.05)'; x.fillRect(bx, by, bw, bh);
  dates.forEach((d, k) => {
    const key = dayKey(ins.days[d]); if (!key) return;
    const col = colours[key];
    x.fillStyle = col ? `rgb(${col.join(',')})` : 'rgba(255,255,255,.35)';
    x.fillRect(bx + k * sw, by, Math.max(1, sw - (sw > 6 ? 2 : 0)), bh);
  });

  // headline number
  x.fillStyle = '#fff'; x.font = F(800, 270); x.fillText(ins.total.toLocaleString(), 72, 965);
  x.fillStyle = 'rgba(255,255,255,.85)'; x.font = SERIF(68); x.fillText('things watched', 90, 1045);

  // three stats
  [[ins.hours, 'hours'], [ins.activeDays, 'days active'], [ins.top.length ? ins.top[0].n : 0, ins.top.length ? 'of ' + ins.top[0].show.name : 'top show']]
    .forEach(([n, l], k) => {
      const sx2 = 90 + k * 310;
      x.fillStyle = '#fff'; x.font = F(800, 86); x.fillText(Number(n).toLocaleString(), sx2, 1200);
      x.fillStyle = 'rgba(255,255,255,.6)'; x.font = UI(600, 29);
      x.fillText(l.length > 18 ? l.slice(0, 17) + '…' : l, sx2, 1248);
    });

  // top posters
  const posters = ins.top.slice(0, 3);
  await Promise.all(posters.map((t, k) => new Promise(res => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const pw = 270, ph = 405, px = 90 + k * 310, py = 1330;
      x.save(); x.beginPath();
      if (x.roundRect) x.roundRect(px, py, pw, ph, 22); else x.rect(px, py, pw, ph);
      x.clip(); x.drawImage(img, px, py, pw, ph); x.restore(); res();
    };
    img.onerror = () => res();
    img.src = imgUrl(t.show.poster_path, 'w342');
  })));

  // style + palette
  x.fillStyle = '#fff'; x.font = F(800, 62); x.fillText(ins.style[0], 90, 1815);
  x.font = UI(600, 29); x.fillStyle = 'rgba(255,255,255,.6)';
  x.fillText(palette.map(p => p.name).join(' · ') + '  ·  My TV Time', 90, 1870);

  // film grain, drawn as fine speckle so the image matches the screens
  for (let k = 0; k < 14000; k++) {
    x.fillStyle = k % 2 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.05)';
    x.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  return new Promise((res, rej) => {
    try { c.toBlob(b => b ? res(b) : rej(new Error('Could not draw the image')), 'image/png'); }
    catch (e) { rej(e); }   // a poster the browser refused to share would taint the canvas
  });
}

async function shareBlob(blob, name) {
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'My TV Time' }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

async function openRecapV2(prefix, recapId) {
  const body = openSheet('<div class="spinner">Preparing your recap…</div>');
  // A recap must never be built on half a history — that was the backup bug.
  if (!historyComplete && !historyTableMissing) {
    body.innerHTML = '<div class="spinner">Loading your full history first…</div>';
    await loadHistoryRest();
    if (!historyComplete) { closeSheet(); toast('History is still incomplete — try again in a moment'); return; }
  }
  const ins = recapInsights(prefix);
  if (!ins) {
    // Nothing to show — still mark it seen, or its banner could never clear.
    if (recapId) await markRecapSeen(recapId).catch(() => {});
    closeSheet(); toast('Nothing logged in that period'); if (view === 'me') render(); return;
  }

  // Colours for the shows that matter most first; the rest fill in live.
  const colours = {};
  const weights = {};
  Object.values(ins.days).flat().forEach(h => { const k = h.type + ':' + h.item; weights[k] = (weights[k] || 0) + 1; });
  const keys = Object.keys(weights).sort((a, b) => weights[b] - weights[a]);
  const firstWave = keys.slice(0, 10);
  const timeout = (ms) => new Promise(r => setTimeout(() => r(null), ms));
  await Promise.race([mapLimit(firstWave, 5, async k => { const c = await colourFor(k); if (c) colours[k] = c; }), timeout(3500)]);
  const people = await Promise.race([recapPeople(ins).catch(() => null), timeout(3000)]);
  // Wide backdrops for the titles you watched most — cached, and never
  // allowed to hold the recap up for more than a few seconds.
  const art = {};
  const featured = [ins.top[0], ...ins.comebacks.slice(0, 3), ...ins.discovered.slice(0, 2)]
    .filter(Boolean).map(x => 'tv:' + x.id);
  const wanted = [...new Set([...featured, ...keys.slice(0, 14)])];
  await Promise.race([mapLimit(wanted, 5, async k => {
    const [type, id] = k.split(':');
    const it = type === 'tv' ? getShow(id) : getMovie(id);
    if (!it || (type === 'tv' && isFootballShow(it))) return;
    const d = await tmdb(`${type === 'tv' ? 'tv' : 'movie'}/${id}`).catch(() => null);
    if (d && d.backdrop_path) art[k] = { backdrop: d.backdrop_path };
  }), timeout(3500)]);
  const palette = buildPalette(ins, colours);

  let cardBlob = null;
  const story = openStoryV2(recapSlidesV2(ins, colours, palette, people, art), {
    palette,
    onReady: async (stage) => {
      // Reaching the last chapter counts as having seen it.
      if (recapId) markRecapSeen(recapId).then(() => { if (view === 'me') render(); }).catch(() => {});
      const box = stage.querySelector('.sv-sharebox');
      try {
        cardBlob = await renderShareCard(ins, colours, palette);
        if (box) {
          box.innerHTML = '';
          const im = new Image(); const url = URL.createObjectURL(cardBlob);
          im.src = url; im.alt = 'Your share card'; box.appendChild(im);
          setTimeout(() => URL.revokeObjectURL(url), 60000);   // don't hold an 8 MB image forever
        }
      } catch (e) {
        if (box) box.innerHTML = `<div class="sv-spinner">Couldn't build the image — ${esc(String(e.message || e).slice(0, 50))}</div>`;
      }
    },
    onShare: async (btn) => {
      if (!cardBlob) { toast('Still building the image…'); return; }
      btn.disabled = true;
      const r = await shareBlob(cardBlob, `my-tv-${prefix}.png`);
      btn.disabled = false;
      if (r === 'downloaded') toast('Saved to your downloads');
    },
  });

  // second wave: everything else, painting barcode stripes as each colour lands
  // Bounded: a year can involve hundreds of titles, each one an image to
  // decode. Sixty is plenty to colour a barcode; the rest stay neutral.
  if (!safeMode) mapLimit(keys.slice(10, 70), 2, async k => {
    if (colours[k]) return;
    const c = await colourFor(k);
    if (c) { colours[k] = c; story.repaintBarcode(k, c); }
  }).catch(() => {});
}

/* ------------------------------------------------------------------
   BADGES — tiers you climb, with progress toward the next one.
   Everything is computed from your own history and library, so the
   eleven restored years count from day one.
   ------------------------------------------------------------------ */
const BADGES = [
  { key: 'episodes', name: 'Binge Master',   icon: 'tv',       unit: 'episodes',      tiers: [100, 500, 1000, 2500, 5000, 10000] },
  { key: 'done',     name: 'Completionist',  icon: 'flag',     unit: 'shows finished', tiers: [5, 10, 25, 50, 100, 200] },
  { key: 'films',    name: 'Cinephile',      icon: 'film',     unit: 'films',         tiers: [25, 100, 250, 500, 750, 1000] },
  { key: 'bestDay',  name: 'Marathoner',     icon: 'flame',    unit: 'in one day',    tiers: [5, 10, 15, 20, 30, 40] },
  { key: 'streak',   name: 'Daily Habit',    icon: 'link',     unit: 'day streak',    tiers: [7, 14, 30, 60, 100, 200] },
  { key: 'night',    name: 'Night Owl',      icon: 'moon',     unit: 'after 1am',     tiers: [10, 50, 100, 250, 500, 1000] },
  { key: 'rated',    name: 'Critic',         icon: 'star',     unit: 'rated',         tiers: [10, 50, 100, 250, 500, 1000] },
  { key: 'years',    name: 'Veteran',        icon: 'calendar', unit: 'years tracked', tiers: [2, 3, 5, 8, 10, 15] },
  { key: 'loyal',    name: 'Loyal Fan',      icon: 'heart',    unit: 'picks of one character', tiers: [5, 10, 25, 50, 100, 200] },
  { key: 'football', name: 'Matchday',       icon: 'ball',     unit: 'matches',       tiers: [10, 38, 76, 150, 300, 500] },
];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

function badgeValues() {
  const byDay = {}; let night = 0, rated = 0, football = 0;
  const years = new Set();
  for (const h of history) {
    byDay[h.at.slice(0, 10)] = (byDay[h.at.slice(0, 10)] || 0) + 1;
    const hr = +h.at.slice(11, 13);
    if (hr >= 1 && hr < 5) night++;
    if (h.rating > 0) rated++;
    if (h.at.length >= 4) years.add(h.at.slice(0, 4));
    if (h.type === 'tv' && isFootballShow(getShow(h.item))) football++;
  }
  const rec = personalRecords();
  return {
    episodes: db.shows.filter(x => !isFootballShow(x)).reduce((n, x) => n + countedEps(x), 0),
    done: db.shows.filter(x => !isFootballShow(x) && x.total_episodes > 0 && countedEps(x) >= x.total_episodes).length,
    films: db.movies.filter(m => m.watched).length,
    bestDay: Math.max(0, ...Object.values(byDay)),
    streak: rec ? rec.streak : 0,
    night, rated, years: years.size,
    loyal: (favouriteTally(null)[0] || {}).count || 0,
    football,
  };
}

function computeBadges() {
  const v = badgeValues();
  return BADGES.map(b => {
    const val = v[b.key] || 0;
    let tier = 0;
    while (tier < b.tiers.length && val >= b.tiers[tier]) tier++;
    const prev = tier ? b.tiers[tier - 1] : 0;
    const next = b.tiers[tier] ?? null;
    const pct = next ? (val - prev) / (next - prev) : 1;
    return { ...b, val, tier, next, pct: Math.max(0, Math.min(1, pct)) };
  });
}

function badgeGrid(container) {
  const list = computeBadges().sort((a, b) => b.tier - a.tier || b.pct - a.pct);
  const grid = el('div', 'badges');
  list.forEach(b => {
    const c = el('div', 'badge' + (b.tier ? ' earned' : ''));
    c.innerHTML = `<span class="bdg-ic">${ico(b.icon)}</span>
      <b>${esc(b.name)}${b.tier ? ` <em>${ROMAN[b.tier]}</em>` : ''}</b>
      <i>${b.next ? `${b.val.toLocaleString()} / ${b.next.toLocaleString()} ${esc(b.unit)}` : `Maxed · ${b.val.toLocaleString()}`}</i>
      <span class="bdg-bar"><span style="width:${(b.pct * 100).toFixed(1)}%"></span></span>`;
    grid.appendChild(c);
  });
  container.appendChild(grid);
}

/* ------------------------------------------------------------------
   PROFILE HEADER — your page, not a report.
   ------------------------------------------------------------------ */
function profileName() {
  try { return localStorage.getItem('mytv.name') || ''; } catch { return ''; }
}

function profileTitle(hours) {
  return hours >= 3000 ? 'Screen Immortal' : hours >= 1500 ? 'Couch Legend'
       : hours >= 500 ? 'Binge Veteran' : hours >= 100 ? 'Regular' : 'Casual Viewer';
}

function profileHeader(v) {
  const name = profileName() || 'You';
  const eps = db.shows.filter(x => !isFootballShow(x)).reduce((n, x) => n + countedEps(x), 0);
  const films = db.movies.filter(m => m.watched);
  const mins = eps * EPISODE_MINUTES + films.reduce((n, m) => n + (m.runtime || MOVIE_MINUTES), 0)
             + db.shows.filter(isFootballShow).reduce((n, x) => n + x.watched_episodes.length * MATCH_MINUTES, 0);
  const hours = Math.round(mins / 60);
  const done = db.shows.filter(x => !isFootballShow(x) && x.total_episodes > 0 && countedEps(x) >= x.total_episodes).length;
  const earned = computeBadges().filter(b => b.tier).length;

  // banner: the show you've spent most time with
  const counts = {};
  history.forEach(h => { if (h.type === 'tv') counts[h.item] = (counts[h.item] || 0) + 1; });
  const topId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
    .find(id => { const s = getShow(id); return s && !isFootballShow(s); });
  const top = topId ? getShow(topId) : null;

  const head = el('div', 'profile');
  head.innerHTML = `
    <div class="pf-banner">${top && top.poster_path ? `<img loading="lazy" decoding="async" class="pf-blur" src="${imgUrl(top.poster_path, 'w500')}" alt="">` : ''}</div>
    <div class="pf-shade"></div>
    <div class="pf-body">
      <div class="pf-avatar">${esc(name.slice(0, 1).toUpperCase())}</div>
      <div class="pf-name">${esc(name)}</div>
      <div class="pf-title">${esc(profileTitle(hours))} · ${earned} badge${earned === 1 ? '' : 's'}</div>
      <div class="pf-stats">
        <div><b>${eps.toLocaleString()}</b><span>Episodes</span></div>
        <div><b>${films.length.toLocaleString()}</b><span>Films</span></div>
        <div><b>${hours.toLocaleString()}</b><span>Hours</span></div>
        <div><b>${done}</b><span>Finished</span></div>
      </div>
      ${top ? `<div class="pf-top">Most watched · ${esc(top.name)}</div>` : ''}
    </div>`;
  v.appendChild(head);

  // swap in a real backdrop once TMDB answers
  if (top) tmdb(`tv/${top.id}`).then(d => {
    if (!d || !d.backdrop_path) return;
    const img = head.querySelector('.pf-blur');
    if (img) { img.src = imgUrl(d.backdrop_path, 'w780'); img.classList.remove('pf-blur'); img.classList.add('pf-img'); }
  }).catch(() => {});
}

async function renderMe(v) {
  v.innerHTML = '';
  const legacy = { stats: 'insights', year: 'insights', records: 'insights', health: 'insights' };
  if (legacy[meTab]) meTab = legacy[meTab];

  if (meTab !== 'recaps') profileHeader(v);

  if (meTab !== 'recaps') {
    v.appendChild(segmented(
      [['Insights', 'insights'], ['Diary', 'journal'], ['Settings', 'data']],
      meTab, t => { meTab = t; renderMe(v); }, 3));
  }

  // Shown on every tab — including Settings, where the backup button lives.
  if (historyLoadError) {
    const warn = el('button', 'hist-warn',
      `<b>History only partly loaded</b><i>${history.length.toLocaleString()} rows so far. Tap to retry — stats and backups wait for the rest.</i>`);
    warn.onclick = () => { warn.disabled = true; loadHistoryRest(() => render()); };
    v.appendChild(warn);
  } else if (!historyComplete && !historyTableMissing) {
    v.appendChild(el('div', 'refreshing',
      `Loading older history… ${history.length.toLocaleString()} so far`));
  }

  const body = el('div');
  v.appendChild(body);

  if (meTab === 'journal') {
    renderJournal(body);
    buildFixtureIndex().then(() => {
      if (meTab === 'journal' && view === 'me') { body.innerHTML = ''; renderJournal(body); }
    }).catch(() => {});
  } else if (meTab === 'recaps') {
    const back = el('button', 'back-link', '‹ Insights');
    back.onclick = () => { meTab = 'insights'; renderMe(v); };
    body.appendChild(back);
    renderRecaps(body);
  } else if (meTab === 'data') {
    renderData(body);
  } else {
    await renderInsights(body, v);
  }
}

async function renderInsights(body, root) {
  // Recap ready? Lead with it.
  const due = pendingRecaps();
  if (due.length) {
    const r = due[0];
    const card = el('button', 'recap-banner');
    card.innerHTML = `<span class="rb-ic">${r.kind === 'month' ? ico('moon') : ico('trophy')}</span>
      <span class="rb-tx"><b>${esc(r.kind === 'month' ? prettyMonth(r.key) : r.key + ' in review')}</b>
      <i>Your ${r.kind === 'month' ? 'wrap-up' : 'year in review'} is ready${due.length > 1 ? ` · ${due.length - 1} more waiting` : ''}</i></span>
      <span class="rb-go">Play</span>`;
    card.onclick = () => r.kind === 'month' ? openMonthRecap(r.key, r.id) : openYearRecap(r.key, r.id);
    body.appendChild(card);
  }

  const section = (title) => {
    const wrap = el('section', 'ins-sec');
    if (title) wrap.appendChild(el('div', 'ins-h', esc(title)));
    body.appendChild(wrap);
    return wrap;
  };

  badgeGrid(section('Badges'));
  renderRecords(section('Personal bests'), { compact: true });
  renderYear(section('Your year'));        // contribution grid + on this day
  await renderHealth(section('Backlog'));  // ring, finish-these, gone-cold
  const mvps = favouriteTally(null).slice(0, 8);
  if (mvps.length) {
    const sec = section('Your MVPs');
    const row = el('div', 'mvp-row');
    mvps.forEach(m => {
      const c = el('div', 'mvp');
      const show = getShow([...m.shows][0]);
      c.innerHTML = `<span class="mvp-ph">${m.p ? `<img loading="lazy" decoding="async" src="${imgUrl(m.p, 'w185')}" alt="">` : ''}</span>
        <b>${esc(m.c)}</b><small>${esc(show ? show.name : m.n)}</small><i>${m.count}×</i>`;
      row.appendChild(c);
    });
    sec.appendChild(row);
  }
  renderStats(section('Taste'), { compact: true });

  const arch = section(null);
  const seen = (db.seen_recaps || []).length;
  const all = el('button', 'mini');
  all.innerHTML = `<span class="mini-ic">${ico("film")}</span>
    <span><b>All recaps</b><i>${seen} watched · ${due.length} new</i></span><span class="ch">›</span>`;
  all.onclick = () => { meTab = 'recaps'; renderMe(root); };
  arch.appendChild(all);
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
          return `<div class="otd-row"><img loading="lazy" decoding="async" src="${imgUrl(o?.poster_path, 'w185')}" alt="">
            <span><b>${esc(o?.name || 'Unknown')}</b><i>${esc(h.code || 'Film')}</i></span></div>`;
        }).join('') +
        (items.length > 4 ? `<div class="muted">and ${items.length - 4} more</div>` : '');
      v.appendChild(line);
    });
  }
}

function renderRecords(v, opts = {}) {
  const r = personalRecords();
  if (!r) { v.appendChild(emptyState('No records yet', 'Watch something and the numbers start.')); return; }
  const yrs = +r.last.slice(0, 4) - +r.first.slice(0, 4) + 1;
  if (!opts.compact) v.appendChild(el('div', 'big-stat',
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
    `<div class="fact"><span>${ico(i)}</span><span>${esc(l)}</span><b>${esc(String(val))}</b></div>`).join('')));
}

function renderStats(v, opts = {}) {
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
    parseMoods(h.feeling).forEach(m => { feels[m] = (feels[m] || 0) + 1; });
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

  if (!opts.compact) {
    v.appendChild(el('div', 'big-stat',
      `<b>${(eps + films.length).toLocaleString()}</b><span>Things watched</span>
       <i>${esc(spent)} of your life on screen</i>`));
  }


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
    `<div class="fact"><span>${ico(i)}</span><span>${esc(l)}</span><b>${esc(String(val))}</b></div>`).join('');
  v.appendChild(facts);

  v.appendChild(el('div', 'section-head', 'Last 12 months'));
  v.appendChild(activityChart());
  v.appendChild(el('div', 'section-head', 'When you watch'));
  v.appendChild(heatmap());

  const plat = {}, mood = {};
  history.forEach(h => {
    if (h.platform) plat[h.platform] = (plat[h.platform] || 0) + 1;
    parseMoods(h.feeling).forEach(m => { mood[m] = (mood[m] || 0) + 1; });
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
      html += `<span class="heat-cell" title="${DAYS[d]} ${b * 3}:00 — ${n}" style="background:rgba(var(--accent-rgb),${a})"></span>`;
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
        <stop offset="0%" style="stop-color:var(--accent-2)"/><stop offset="100%" style="stop-color:var(--accent)"/></linearGradient></defs>
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
    b.innerHTML = `<img loading="lazy" decoding="async" src="${imgUrl(x.poster, 'w185')}" alt="">
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
    // A w500 source for the wash: at only 4px blur a w185 image looks mushy.
    const wash = imgUrl(obj?.poster_path, 'w500');
    b.innerHTML = `${wash ? `<span class="log-wash" style="background-image:url('${wash}')"></span>` : ''}
      <img loading="lazy" src="${art}" alt=""
        style="object-fit:${isAbs(obj?.poster_path) ? 'contain' : 'cover'}">
      <span class="log-main"><span class="log-name">${esc(obj?.name || 'Unknown')}</span>
        <span class="log-meta">${esc(h.at.slice(0, 16))}</span><br>
        ${h.code ? `<span class="chip">${esc(fixtureIndex[`${h.item}|${h.code}`] || h.code)}</span>`
                 : '<span class="chip">Film</span>'}
        ${h.cycle > 1 ? `<span class="chip plain">↻ rewatch ${h.cycle}</span>` : ''}
        ${h.rating ? `<span class="chip plain">${'★'.repeat(h.rating)}</span>` : ''}
        ${h.platform ? `<span class="chip plain">${esc(h.platform)}</span>` : ''}
        ${parseMoods(h.feeling).map(m => `<span class="chip plain">${esc(m)}</span>`).join('')}
        ${(() => { const f = favOf(h); return f ? `<span class="chip fav-chip">${f.p ? `<img loading="lazy" decoding="async" src="${imgUrl(f.p, 'w92')}" alt="">` : ''}${esc(f.c)}</span>` : ''; })()}</span>`;
    b.onclick = () => isTv
      ? (isFootballShow(obj) ? openFootball(h.item, obj?.name || '') : openEpisode(h.item, obj?.name || '', h.code))
      : openMovie(h.item, obj?.name || '');
    v.appendChild(b);
  }
  v.appendChild(el('div', 'muted',
    `Showing ${Math.min(journalLimit, rows.length).toLocaleString()} of ${rows.length.toLocaleString()}`
    + (historyComplete ? '' : ' · still loading older entries…')));
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
      r.kind === 'month' ? ico('moon') : ico('trophy'),
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
      v.appendChild(recapRow(isMonth ? ico('calendar') : ico('trophy'),
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










/* Every recap — banner, list, archive, the pop-up on launch — opens the new
   design. The old story renderer is gone. */
function openMonthRecap(key, id) { return openRecapV2(key, id); }

function openYearRecap(year, id) { return openRecapV2(year, id); }

function dataRow(title, sub, label, onClick, gold) {
  const row = el('div', 'data-row');
  row.innerHTML = `<span class="tx"><b>${esc(title)}</b><i>${esc(sub)}</i></span>`;
  const b = el('button', 'btn' + (gold ? ' gold' : ''), label);
  b.onclick = () => onClick(b);
  row.appendChild(b);
  return row;
}

/** One screen that checks the things that have actually broken: a stale cache,
    a missing column, a silent save failure, one show poisoning the cache. */
async function runHealthCheck(out) {
  const rows = [];
  const add = (ok, label, detail) =>
    rows.push(`<div class="hc ${ok === null ? 'warn' : ok ? 'good' : 'bad'}">
      <span>${ok === null ? '!' : ok ? '✓' : '✕'}</span>
      <span><b>${esc(label)}</b><i>${esc(detail)}</i></span></div>`);

  out.innerHTML = '<div class="muted">Checking…</div>';

  // 1. database reachable
  let t0 = Date.now();
  try {
    await sb('tv_time_data?id=eq.1&select=id', {}, 8000);
    add(true, 'Supabase reachable', `${Date.now() - t0} ms`);
  } catch (e) { add(false, 'Supabase unreachable', String(e.message).slice(0, 70)); }

  // 2. rewatch migration
  try {
    await sb('watch_history?select=cycle&limit=1', {}, 8000);
    add(true, 'Rewatch migration applied', 'cycle column present');
  } catch (e) {
    add(false, 'Rewatch migration missing', 'run rewatch_migration.sql — episode rewatches will not save');
  }

  // 2a. is all of your history actually loaded?
  const onServer = await serverHistoryCount();
  if (onServer != null) {
    add(history.length >= onServer && historyComplete,
        historyComplete && history.length >= onServer ? 'History fully loaded' : 'History incomplete',
        `${history.length.toLocaleString()} loaded of ${onServer.toLocaleString()} on the server`);
  }

  // 2b. reactions migration
  add(historyHasFavorite ? true : null, historyHasFavorite ? 'Reactions migration applied' : 'Reactions migration not run',
      historyHasFavorite ? 'favourite characters can be saved' : 'run reactions_migration.sql to enable favourite characters');

  // 3. football cache freshness
  try {
    const fx = await sb('football_cache?select=competition,season,updated_at&order=updated_at.desc', {}, 8000);
    if (!fx || !fx.length) add(null, 'No fixtures stored', 'push a season from Streamlit, or set up the scheduled sync');
    else {
      const age = (Date.now() - new Date(fx[0].updated_at)) / 3600000;
      add(age < 48, `Fixtures: ${fx.map(f => f.competition + ' ' + f.season).join(', ')}`,
          `last synced ${age < 1 ? 'under an hour' : Math.round(age) + ' hours'} ago`);
    }
  } catch { add(null, 'football_cache table missing', 'run football_cache.sql if you want football'); }

  // 4. history vs library agreement
  const libEps = db.shows.reduce((n, x) => n + countedEps(x), 0);
  const histEps = history.filter(h => h.type === 'tv').length;
  add(Math.abs(libEps - histEps) < libEps * 0.25 || !libEps,
      'History vs library', `${histEps.toLocaleString()} history rows, ${libEps.toLocaleString()} episodes marked`);

  // 5. analytics agreement
  const an = Object.values(db.analytics).reduce((n, x) => n + (x.tv || 0) + (x.movie || 0), 0);
  add(Math.abs(an - history.length) < Math.max(50, history.length * 0.15),
      'Analytics vs history', `${an.toLocaleString()} counted, ${history.length.toLocaleString()} rows — Recount fixes drift`);

  // 6. storage pressure — the thing Raw tripped
  let used = 0, biggest = ['', 0];
  for (const k of Object.keys(localStorage)) {
    const n = (localStorage.getItem(k) || '').length;
    used += n;
    if (n > biggest[1]) biggest = [k, n];
  }
  add(used < 4_000_000, 'Local cache size',
      `${(used / 1048576).toFixed(2)} MB used · largest ${biggest[0].slice(0, 34)} (${(biggest[1] / 1024).toFixed(0)} KB)`);

  // 7. feed freshness
  const age = feedCache.ts ? (Date.now() - feedCache.ts) / 60000 : null;
  add(age !== null && age < 180, 'Feed cache',
      age === null ? 'not built yet — Up Next will scan on next open' : `built ${Math.round(age)} min ago`);

  // 8. data integrity
  const mism = db.shows.filter(isMismatched).length;
  add(mism === 0, 'Episode counts', mism ? `${mism} shows have more watched than exist` : 'all consistent');
  const noPoster = db.shows.filter(x => !x.poster_path).length + db.movies.filter(x => !x.poster_path).length;
  add(noPoster < 20, 'Artwork', noPoster ? `${noPoster} items missing a poster (self-heals as you browse)` : 'complete');

  out.innerHTML = rows.join('');
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

  const health = el('div', 'panel');
  health.appendChild(el('div', 'section-head', 'Health check'));
  const hcOut = el('div', 'muted', 'Verifies the database, migrations, caches and data consistency.');
  const hcBtn = el('button', 'btn gold', 'Run health check');
  hcBtn.style.cssText = 'width:100%;margin-bottom:10px';
  hcBtn.onclick = async () => { hcBtn.disabled = true; await runHealthCheck(hcOut); hcBtn.disabled = false; };
  health.appendChild(hcBtn);
  health.appendChild(hcOut);
  v.appendChild(health);

  const you = el('div', 'panel');
  you.appendChild(el('div', 'section-head', 'Profile'));
  const nameRow = el('div', 'data-row');
  nameRow.innerHTML = '<span class="tx"><b>Your name</b><i>Shown at the top of your profile.</i></span>';
  const nameIn = el('input', 'name-in');
  nameIn.value = profileName();
  nameIn.placeholder = 'Your name';
  nameIn.maxLength = 24;
  nameIn.onchange = () => {
    try { localStorage.setItem('mytv.name', nameIn.value.trim()); } catch { /* ignore */ }
    toast('Saved');
  };
  nameRow.appendChild(nameIn);
  you.appendChild(nameRow);
  v.appendChild(you);

  const backup = el('div', 'panel');
  backup.appendChild(el('div', 'section-head', 'Backup'));
  backup.appendChild(dataRow('Download everything',
    'Library, history and analytics as one JSON file. Fetched fresh from the server and checked against its count, so it is always complete.',
    'Download', async (btn) => {
      // The old version exported whatever history happened to be in memory,
      // which during background loading could be only the newest pages.
      btn.disabled = true; btn.textContent = 'Fetching…';
      let full, expected;
      try {
        [full, expected] = await Promise.all([
          fetchAllHistory(n => { btn.textContent = `${n.toLocaleString()}…`; }),
          serverHistoryCount(),
        ]);
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Download';
        toast(`Backup failed — ${String(e.message || e).slice(0, 50)}. Nothing was saved.`);
        return;
      }
      if (expected != null && full.length !== expected) {
        btn.disabled = false; btn.textContent = 'Download';
        toast(`Backup stopped: got ${full.length.toLocaleString()} of ${expected.toLocaleString()} rows. Try again.`);
        return;
      }
      history = full; historyComplete = true; historyLoadError = '';
      btn.disabled = false; btn.textContent = 'Download';
      const blob = new Blob([JSON.stringify({ exported_at: stamp(), build: BUILD,
          history_rows: full.length, history_rows_on_server: expected, ...db, history: full }, null, 2)],
        { type: 'application/json' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mytvtime-${stamp().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Backup downloaded · ${full.length.toLocaleString()} history rows${expected != null ? ', all present' : ''}`);
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
        b.innerHTML = `<img loading="lazy" decoding="async" src="${imgUrl(x.poster_path, 'w185')}" alt="">
          <span><b>${esc(x.name)}</b><i>${countedEps(x)} watched · ${x.total_episodes} exist
          (+${countedEps(x) - x.total_episodes})</i></span><span class="ch">›</span>`;
        b.onclick = () => openShow(x.id, x.name);
        panel.appendChild(b);
      });
    v.appendChild(panel);
  }

  repair.appendChild(dataRow('Rebuild feeds',
    'Clears the cached Up Next and Coming Soon results and recomputes them.',
    'Rebuild', () => { clearFeeds(); toast('Feeds cleared'); render(); }));
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



/* Slide builders ------------------------------------------------ */




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

/* ------------------------------------------------------------------
   Dynamic colour: each show's sheet takes its accent from its poster,
   the way Apple Music tints a page from album art. Sampling weights
   saturated mid-tones so we get the poster's colour, not its blacks.
   ------------------------------------------------------------------ */
const colourMemo = new Map();

function tuneForDark([r, g, b]) {
  // to HSL, then pin lightness/saturation so it reads well on a dark UI
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, sat = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    sat = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  sat = Math.min(.85, Math.max(.42, sat));
  const L = .68;
  const q = L < .5 ? L * (1 + sat) : L + sat - L * sat, p = 2 * L - q;
  const f = (t) => { t = (t + 1) % 1;
    return t < 1/6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2/3 ? p + (q - p) * (2/3 - t) * 6 : p; };
  return [f(h + 1/3), f(h), f(h - 1/3)].map(x => Math.round(x * 255));
}

async function posterColour(path) {
  if (!path || isAbs(path)) return null;
  if (colourMemo.has(path)) return colourMemo.get(path);
  const stored = cacheGet('col:' + path, 90 * 86400000);
  if (stored) { colourMemo.set(path, stored); return stored; }

  const rgb = await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 24; c.height = 36;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 24, 36);
        const d = x.getImageData(0, 0, 24, 36).data;
        let R = 0, G = 0, B = 0, W = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const sat = mx ? (mx - mn) / mx : 0;
          const lum = (mx + mn) / 510;
          const w = sat * sat * (lum > .12 && lum < .92 ? 1 : .08) + .001;
          R += r * w; G += g * w; B += b * w; W += w;
        }
        resolve([R / W, G / W, B / W].map(Math.round));
      } catch { resolve(null); }        // image not CORS-readable: keep default
    };
    img.onerror = () => resolve(null);
    img.src = imgUrl(path, 'w92');
  });
  if (!rgb) return null;
  const tuned = tuneForDark(rgb);
  colourMemo.set(path, tuned);
  cacheSet('col:' + path, tuned, 90 * 86400000);
  return tuned;
}

function setAccent(el, rgb) {
  if (!el) return;
  if (!rgb) { ['--accent','--accent-rgb','--accent-2','--tint'].forEach(k => el.style.removeProperty(k)); return; }
  const [r, g, b] = rgb;
  el.style.setProperty('--accent', `rgb(${r},${g},${b})`);
  el.style.setProperty('--accent-rgb', `${r},${g},${b}`);
  el.style.setProperty('--accent-2', `rgb(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)})`);
  el.style.setProperty('--tint', `rgba(${r},${g},${b},.20)`);
}

/** Tint the open sheet from a poster; harmless if colour can't be read. */
function tintSheet(posterPath) {
  posterColour(posterPath).then(rgb => {
    if (!$('#sheet').hidden) setAccent($('#sheet'), rgb);
  }).catch(() => {});
}

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
  const sheet = $('#sheet');
  setAccent(sheet, null);              // next sheet starts neutral
  sheet.style.transform = '';
  sheet.classList.remove('scrolled');
  sheet.hidden = true;
  sheet.classList.remove('story-mode', 'story-v2');
  sheet.style.removeProperty('--rc'); sheet.style.removeProperty('--rc2');
  $('#sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
  $('#tabbar').style.display = '';   // stories hide it; every exit restores it
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
  return `${bg ? `<div class="sheet-hero"><img loading="lazy" decoding="async" src="${bg}" alt=""></div>`
               : '<div class="sheet-hero plain"></div>'}
    <div class="sheet-head">
      <div class="sheet-poster"><img loading="lazy" decoding="async" src="${imgUrl(poster)}"
        style="object-fit:${isAbs(poster) ? 'contain' : 'cover'}" alt=""></div>
      <div><div class="sheet-title">${esc(title)}</div>
        <div>${chips.filter(Boolean).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div></div>
    </div><div class="sheet-body">`;
}

/* ------------------------------------------------------------------
   REACTIONS — rating, moods, favourite character, where you watched.
   One editor, used inside episode/film sheets and by the post-watch
   panel. Every tap saves on its own; nothing needs a Save button.
   ------------------------------------------------------------------ */
const favOf = (h) => { try { return h && h.favorite ? JSON.parse(h.favorite) : null; } catch { return null; } };

async function episodeCast(showId, code) {
  const m = /^S(\d+)E(\d+)$/.exec(code || '');
  if (!m) return [];
  const d = await tmdb(`tv/${showId}/season/${m[1]}/episode/${m[2]}/credits`);
  return castList([...(d.cast || []), ...(d.guest_stars || [])]);
}
async function filmCast(id) {
  const d = await tmdb(`movie/${id}/credits`);
  return castList(d.cast || []);
}
function castList(people) {
  const seen = new Set(), out = [];
  for (const p of people) {
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    const role = String(p.character || '').split('/')[0].replace(/\(voice\)/i, '').trim();
    out.push({ a: p.id, c: role || p.name, n: p.name, p: p.profile_path || '' });
    if (out.length >= 14) break;
  }
  return out;
}

function reactionEditor(container, entry, ctx = {}) {
  const wrap = el('div', 'rx');
  container.appendChild(wrap);

  // ---- rating ----
  const rate = el('div', 'rx-row');
  rate.innerHTML = '<div class="rx-label">Rating</div><div class="rx-stars"></div><div class="rx-word"></div>';
  const stars = rate.querySelector('.rx-stars'), word = rate.querySelector('.rx-word');
  const paintStars = () => {
    [...stars.children].forEach((c, k) => c.classList.toggle('on', entry.rating >= k + 1));
    word.textContent = RATING_WORDS[entry.rating] || 'Tap to rate';
  };
  for (let n = 1; n <= 5; n++) {
    const b = el('button', 'rx-star', '★');
    b.onclick = async () => {
      await patchHistory(entry, { rating: entry.rating === n ? 0 : n });
      buzz(6); paintStars();
    };
    stars.appendChild(b);
  }
  paintStars();
  wrap.appendChild(rate);

  // ---- moods, several allowed ----
  const moods = el('div', 'rx-row');
  moods.innerHTML = '<div class="rx-label">How it felt</div><div class="rx-chips"></div>';
  const mc = moods.querySelector('.rx-chips');
  const paintMoods = () => {
    const on = parseMoods(entry.feeling);
    [...mc.children].forEach(c => c.classList.toggle('on', on.includes(c.dataset.m)));
  };
  MOODS.forEach(m => {
    const b = el('button', 'rx-chip', esc(m));
    b.dataset.m = m;
    b.onclick = async () => {
      const cur = parseMoods(entry.feeling);
      const next = cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m];
      await patchHistory(entry, { feeling: formatMoods(next) });
      buzz(5); paintMoods();
    };
    mc.appendChild(b);
  });
  paintMoods();
  wrap.appendChild(moods);

  // ---- favourite character (needs the migration; hidden for football) ----
  if (historyHasFavorite && ctx.kind !== 'football') {
    const fav = el('div', 'rx-row');
    fav.innerHTML = '<div class="rx-label">Favourite character</div><div class="rx-faces"><div class="rx-loading">Loading cast…</div></div>';
    const faces = fav.querySelector('.rx-faces');
    wrap.appendChild(fav);
    const load = ctx.kind === 'movie' ? filmCast(ctx.id) : episodeCast(ctx.id, ctx.code);
    load.then(cast => {
      faces.innerHTML = '';
      if (!cast.length) { faces.appendChild(el('div', 'rx-loading', 'No cast listed for this one')); return; }
      const paintFaces = () => {
        const cur = favOf(entry);
        [...faces.children].forEach(f => f.classList.toggle('on', !!cur && String(cur.a) === f.dataset.a));
      };
      cast.forEach(person => {
        const f = el('button', 'rx-face');
        f.dataset.a = String(person.a);
        f.innerHTML = `<span class="rx-ph">${person.p ? `<img loading="lazy" decoding="async" src="${imgUrl(person.p, 'w185')}" alt="">`
                        : `<i>${esc(person.c.slice(0, 1))}</i>`}</span>
                       <b>${esc(person.c)}</b><small>${esc(person.n)}</small>`;
        f.onclick = async () => {
          const cur = favOf(entry);
          const same = cur && String(cur.a) === String(person.a);
          await patchHistory(entry, { favorite: same ? '' : JSON.stringify(person) });
          buzz(6); paintFaces();
        };
        faces.appendChild(f);
      });
      paintFaces();
    }).catch(() => { faces.innerHTML = '<div class="rx-loading">Cast unavailable</div>'; });
  }

  // ---- where you watched, remembered for next time ----
  const plat = el('div', 'rx-row');
  plat.innerHTML = '<div class="rx-label">Watched on</div><div class="rx-chips"></div>';
  const pc = plat.querySelector('.rx-chips');
  const paintPlat = () => [...pc.children].forEach(c => c.classList.toggle('on', c.dataset.p === entry.platform));
  PLATFORMS.filter(Boolean).forEach(p => {
    const b = el('button', 'rx-chip', esc(p));
    b.dataset.p = p;
    b.onclick = async () => {
      const next = entry.platform === p ? '' : p;
      await patchHistory(entry, { platform: next });
      if (next) try { localStorage.setItem('mytv.lastPlatform', next); } catch { /* ignore */ }
      buzz(5); paintPlat();
    };
    pc.appendChild(b);
  });
  paintPlat();
  wrap.appendChild(plat);
}

/** Characters you've picked most, optionally for one show. */
function favouriteTally(showId) {
  const tally = {};
  for (const h of history) {
    if (showId != null && (h.type !== 'tv' || h.item !== String(showId))) continue;
    const f = favOf(h);
    if (!f) continue;
    const k = String(f.a);
    (tally[k] ||= { ...f, n: f.n, count: 0, shows: new Set() }).count++;
    tally[k].shows.add(h.item);
  }
  return Object.values(tally).sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------
   POST-WATCH PANEL
   After you mark one episode or film, a slim bar rises: tap it to rate
   and react, or ignore it and it slides away on its own. It never
   appears for bulk actions, and never inside a sheet that already
   shows the same editor.
   ------------------------------------------------------------------ */
let pwTimer = null;

function postWatch(kind, id, code, name) {
  const entry = kind === 'movie' ? findLog('movie', id) : findLog('tv', id, code);
  if (!entry || !entry.id) return;               // nothing saved to react to

  // Remembered platform: usually right, and one tap to change.
  let last = '';
  try { last = localStorage.getItem('mytv.lastPlatform') || ''; } catch { /* ignore */ }
  if (last && !entry.platform) patchHistory(entry, { platform: last });

  document.querySelectorAll('.pw').forEach(x => x.remove());
  const wrap = el('div', 'pw');
  wrap.innerHTML = `<div class="pw-scrim"></div>
    <button class="pw-bar">
      <span class="pw-tick">✓</span>
      <span class="pw-tx"><b>${esc(name)}</b><i>${esc(kind === 'movie' ? 'Film' : code)} watched</i></span>
      <span class="pw-cta">Rate &amp; react</span>
    </button>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));

  const close = () => {
    clearTimeout(pwTimer);
    wrap.classList.remove('in', 'open');
    setTimeout(() => wrap.remove(), 320);
  };
  clearTimeout(pwTimer);
  pwTimer = setTimeout(() => { if (!wrap.classList.contains('open')) close(); }, 7000);

  wrap.querySelector('.pw-bar').onclick = () => {
    if (wrap.classList.contains('open')) return;
    clearTimeout(pwTimer);
    wrap.classList.add('open');
    const panel = el('div', 'pw-panel');
    panel.innerHTML = `<div class="pw-head"><div><b>${esc(name)}</b>
        <i>${esc(kind === 'movie' ? 'Film' : code)}</i></div>
        <button class="btn gold pw-done">Done</button></div>`;
    wrap.appendChild(panel);
    reactionEditor(panel, entry, { kind, id, code });
    panel.querySelector('.pw-done').onclick = close;
  };
  wrap.querySelector('.pw-scrim').onclick = close;
}

/** Kept for the existing call sites in episode and film sheets. */
function journalEditor(container, entry, ctx = {}) {
  container.appendChild(el('div', 'section-head', 'Your reaction'));
  reactionEditor(container, entry, ctx);
}

function showHistoryStats(showId) {
  const logs = history.filter(h => h.type === 'tv' && h.item === String(showId));
  if (!logs.length) return null;
  const dates = logs.map(h => h.at).filter(Boolean).sort();
  const ratings = logs.filter(h => h.rating > 0).map(h => h.rating);
  const plats = {}, feels = {};
  logs.forEach(h => {
    if (h.platform) plats[h.platform] = (plats[h.platform] || 0) + 1;
    parseMoods(h.feeling).forEach(m => { feels[m] = (feels[m] || 0) + 1; });
  });
  return { count: logs.length, first: dates[0]?.slice(0, 10) || '',
           last: dates[dates.length - 1]?.slice(0, 10) || '',
           avg: ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0,
           rated: ratings.length, platform: topKey(plats)?.[0] || '', mood: topKey(feels)?.[0] || '' };
}

/** Cast strip + inline actor panel: their top roles, and what you already own. */
function peopleStrip(container, title, people) {
  if (!container || !people.length) return;
  container.appendChild(el('div', 'pg-h', esc(title)));
  const strip = el('div', 'cast');
  people.forEach(a => {
    const c = el('button', 'cast-card');
    c.innerHTML = `<img loading="lazy" src="${a.profile_path ? imgUrl(a.profile_path, 'w185')
        : 'https://via.placeholder.com/185x278/222/555?text=%20'}" alt="">
      <span class="cast-char">${esc(a.character || a.job || '\u00a0')}</span>
      <span class="cast-name">${esc(a.name)}</span>`;
    c.onclick = () => openActor(a.id, a.name);
    strip.appendChild(c);
  });
  container.appendChild(strip);
}

async function castStrip(mediaType, id, container) {
  if (!container) return;
  const credits = await tmdb(`${mediaType}/${id}/credits`).catch(() => ({}));
  peopleStrip(container, 'Cast', (credits.cast || []).slice(0, 15));
}

/** Trailer: a thumbnail that becomes YouTube's privacy-enhanced player only
    when tapped, so opening a page never loads YouTube. Studios sometimes
    disable embedding, so "Open in YouTube" is always offered too. */
async function trailerBlock(kind, id, slot) {
  if (!slot) return;
  const d = await tmdb(`${kind}/${id}/videos`).catch(() => ({}));
  const vids = (d.results || []).filter(v => v.site === 'YouTube' && v.key);
  const pick = vids.find(v => v.type === 'Trailer' && v.official) || vids.find(v => v.type === 'Trailer')
            || vids.find(v => v.type === 'Teaser') || null;
  if (!pick) return;
  slot.innerHTML = `<button class="trailer" aria-label="Play trailer">
      <img loading="lazy" decoding="async" src="https://i.ytimg.com/vi/${encodeURIComponent(pick.key)}/hqdefault.jpg" alt="">
      <span class="tr-shade"></span>
      <span class="tr-play">${ico('play')}</span>
      <span class="tr-lbl">${esc(pick.name || 'Trailer')}</span></button>
    <a class="tr-yt" href="https://www.youtube.com/watch?v=${encodeURIComponent(pick.key)}" target="_blank" rel="noopener">Open in YouTube</a>`;
  slot.querySelector('.trailer').onclick = () => {
    const frame = el('div', 'trailer-frame');
    frame.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(pick.key)}?autoplay=1&playsinline=1&rel=0"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Trailer"></iframe>`;
    slot.querySelector('.trailer').replaceWith(frame);
  };
}

/** "More like this", as a sideways shelf. */
async function moreLikeThis(kind, id, slot) {
  if (!slot) return;
  const d = await tmdb(`${kind}/${id}/recommendations`).catch(() => ({}));
  const items = (d.results || []).filter(x => x.poster_path).slice(0, 14);
  if (!items.length) return;
  slot.innerHTML = '<div class="pg-h">More like this</div><div class="shelf-row"></div>';
  const row = slot.querySelector('.shelf-row');
  items.forEach(i => {
    const name = i.name || i.title;
    const open = () => kind === 'tv' ? openShow(i.id, name) : openMovie(i.id, name);
    const owned = kind === 'tv' ? getShow(i.id) : getMovie(i.id);
    const tile = posterEl({ title: name, poster: i.poster_path, onOpen: open,
      badge: owned ? 'In library' : null, quick: quickFor(kind, i.id, name, { open }) });
    tile.classList.add('shelf-tile');
    row.appendChild(tile);
  });
}

/** "Part 3 of The Matrix collection", with the others in a row. */
async function collectionBlock(movie, slot) {
  const c = movie && movie.belongs_to_collection;
  if (!slot || !c) return;
  const d = await tmdb(`collection/${c.id}`).catch(() => ({}));
  const parts = (d.parts || []).filter(x => x.release_date || x.poster_path)
    .sort((a, b) => String(a.release_date || '9999').localeCompare(String(b.release_date || '9999')));
  if (parts.length < 2) return;
  const idx = parts.findIndex(x => String(x.id) === String(movie.id));
  const seen = parts.filter(x => movieWatched(x.id)).length;
  slot.innerHTML = `<div class="pg-h">${esc(c.name)}</div>
    <div class="muted">${idx >= 0 ? `Part ${idx + 1} of ${parts.length}` : `${parts.length} films`} · you've seen ${seen}</div>
    <div class="shelf-row"></div>`;
  const row = slot.querySelector('.shelf-row');
  parts.forEach((p, k) => {
    const open = () => openMovie(p.id, p.title);
    const tile = posterEl({ title: p.title, poster: p.poster_path, onOpen: open,
      badge: String(p.id) === String(movie.id) ? 'This one' : movieWatched(p.id) ? 'Watched' : `Part ${k + 1}`,
      quick: quickFor('movie', p.id, p.title, { open }) });
    tile.classList.add('shelf-tile');
    row.appendChild(tile);
  });
}

/** Has *you* actually watched this title, not merely added it? */
function seenIt(kind, id) {
  if (kind === 'tv') { const sh = getShow(id); return !!sh && countedEps(sh) > 0; }
  return movieWatched(id);
}

function ageLine(p) {
  if (!p.birthday) return '';
  const born = new Date(p.birthday + 'T00:00:00Z');
  const end = p.deathday ? new Date(p.deathday + 'T00:00:00Z') : now();
  let age = end.getUTCFullYear() - born.getUTCFullYear();
  if (end.getUTCMonth() < born.getUTCMonth() || (end.getUTCMonth() === born.getUTCMonth() && end.getUTCDate() < born.getUTCDate())) age--;
  return p.deathday ? `${born.getUTCFullYear()}–${end.getUTCFullYear()} · died aged ${age}` : `Born ${born.getUTCFullYear()} · ${age}`;
}

let actorTab = 'acting';

async function openActor(actorId, actorName) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const [person, credits] = await Promise.all([
    tmdb(`person/${actorId}`), tmdb(`person/${actorId}/combined_credits`)]);

  // One entry per title (a person can appear several times in one show).
  const dedupe = (list, label) => {
    const map = new Map();
    for (const c of list || []) {
      const k = `${c.media_type}:${c.id}`;
      const role = label(c);
      if (!map.has(k)) map.set(k, { ...c, roles: role ? [role] : [], eps: c.episode_count || 0 });
      else { const e = map.get(k); if (role && !e.roles.includes(role)) e.roles.push(role); e.eps += c.episode_count || 0; }
    }
    return [...map.values()].filter(c => c.poster_path || c.name || c.title);
  };
  const acting = dedupe(credits.cast, c => String(c.character || '').split('/')[0].trim());
  const crew = dedupe((credits.crew || []).filter(c => ['Directing', 'Writing', 'Production', 'Creator'].includes(c.department)
                                                    || /Director|Creator|Writer|Showrunner/.test(c.job || '')), c => c.job);
  // Mostly behind the camera? Open on that side.
  if (crew.length > acting.length * 1.5) actorTab = 'crew';
  else if (!crew.length) actorTab = 'acting';

  const pool = [...acting, ...crew];
  const uniq = new Map(pool.map(c => [`${c.media_type}:${c.id}`, c]));
  const seenList = [...uniq.values()].filter(c => seenIt(c.media_type, c.id));
  const fav = favouriteTally(null).find(f => String(f.a) === String(actorId));

  const bio = (person.biography || '').trim();
  const chips = [ageLine(person), person.place_of_birth || '', person.known_for_department || ''].filter(Boolean);

  body.innerHTML = sheetHeader(person.name || actorName, '', person.profile_path, chips) +
    `<div class="you-stat">
       <b>${seenList.length}</b><span>of their ${uniq.size} credits you've watched</span></div>` +
    (fav ? `<div class="fav-card"><span class="fav-ph">${fav.p ? `<img loading="lazy" decoding="async" src="${imgUrl(fav.p, 'w185')}" alt="">` : ''}</span>
        <span class="fav-tx"><i>Your favourite as</i><b>${esc(fav.c)}</b><small>picked ${fav.count}× across ${fav.shows.size} show${fav.shows.size > 1 ? 's' : ''}</small></span></div>` : '') +
    (bio ? sec('About', clampBlock(bio)) : '') +
    (seenList.length ? '<section class="pg-sec seen-slot"></section>' : '') +
    '<section class="pg-sec roles-slot"></section></div>';
  wireClamp(body);

  const tile = (c) => {
    const kind = c.media_type, title = c.name || c.title;
    const open = () => kind === 'tv' ? openShow(c.id, title) : openMovie(c.id, title);
    const role = c.roles && c.roles[0];
    const t = posterEl({ title, poster: c.poster_path, onOpen: open,
      badge: role ? (role.length > 18 ? role.slice(0, 17) + '…' : role) : (String(c.first_air_date || c.release_date || '').slice(0, 4) || null),
      quick: quickFor(kind, c.id, title, { open }) });
    t.classList.add('shelf-tile');
    return t;
  };

  // What you've seen of theirs, first.
  const seenSlot = body.querySelector('.seen-slot');
  if (seenSlot) {
    seenSlot.innerHTML = '<div class="pg-h">You\'ve watched</div><div class="shelf-row"></div>';
    const row = seenSlot.querySelector('.shelf-row');
    seenList.sort((a, b) => String(b.first_air_date || b.release_date || '').localeCompare(String(a.first_air_date || a.release_date || '')))
      .slice(0, 20).forEach(c => row.appendChild(tile(c)));
  }

  // Full filmography: acting or behind the camera, series and films, newest first.
  const roles = body.querySelector('.roles-slot');
  const paint = () => {
    roles.innerHTML = '';
    if (crew.length && acting.length) {
      roles.appendChild(segmented([['Acting', 'acting'], ['Behind the camera', 'crew']], actorTab,
        t => { actorTab = t; paint(); }, 2));
    }
    const list = (actorTab === 'crew' ? crew : acting).slice()
      .sort((a, b) => String(b.first_air_date || b.release_date || '').localeCompare(String(a.first_air_date || a.release_date || '')));
    for (const [label, kind] of [['Series', 'tv'], ['Films', 'movie']]) {
      const items = list.filter(c => c.media_type === kind);
      if (!items.length) continue;
      let shown = 18;
      const head = el('div', 'pg-h', `${label} · ${items.length}`);
      const holder = el('div');
      const draw = () => {
        holder.innerHTML = '';
        const g = el('div', 'grid');
        items.slice(0, shown).forEach(c => { const t = tile(c); t.classList.remove('shelf-tile'); g.appendChild(t); });
        holder.appendChild(g);
        if (items.length > shown) {
          const more = el('button', 'btn', `Show ${Math.min(18, items.length - shown)} more`);
          more.style.cssText = 'width:100%;margin-top:10px';
          more.onclick = () => { shown += 18; draw(); };
          holder.appendChild(more);
        }
      };
      draw();
      roles.append(head, holder);
    }
  };
  paint();
}

/** Neighbouring episodes from the season list alone — no need to load every
    episode to know that S1's finale is followed by S2E1. */
function episodeNeighbours(head, code) {
  const m = /^S(\d+)E(\d+)$/.exec(code || '');
  if (!m) return {};
  const sn = +m[1], en = +m[2];
  const seasons = (head.seasons || []).filter(x => x.season_number > 0 && x.episode_count > 0)
    .sort((a, b) => a.season_number - b.season_number);
  const i = seasons.findIndex(x => x.season_number === sn);
  if (i < 0) return {};
  const prev = en > 1 ? `S${sn}E${en - 1}` : i > 0 ? `S${seasons[i - 1].season_number}E${seasons[i - 1].episode_count}` : null;
  const next = en < seasons[i].episode_count ? `S${sn}E${en + 1}` : i < seasons.length - 1 ? `S${seasons[i + 1].season_number}E1` : null;
  return { prev, next };
}

async function openEpisode(showId, showName, code) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const m = /^S(\d+)E(\d+)$/.exec(code) || [];
  const [ep, show, credits] = await Promise.all([
    m[1] ? tmdb(`tv/${showId}/season/${m[1]}/episode/${m[2]}`) : {},
    tmdb(`tv/${showId}`),
    m[1] ? tmdb(`tv/${showId}/season/${m[1]}/episode/${m[2]}/credits`).catch(() => ({})) : {}]);
  const on = epWatched(showId, code);
  const s = getShow(showId);
  const log = findLog('tv', showId, code);
  const times = timesWatched('tv', showId, code);
  const nb = episodeNeighbours(show, code);
  const future = ep.air_date && ep.air_date > TODAY();

  const chips = [code];
  if (ep.vote_average) chips.push(`★ ${ep.vote_average.toFixed(1)}`);
  if (ep.runtime) chips.push(fmtMins(ep.runtime));

  const nav = `<div class="ep-nav">
      <button class="btn ep-prev"${nb.prev ? '' : ' disabled'}>${nb.prev ? `‹ ${esc(nb.prev)}` : 'First episode'}</button>
      <button class="btn ep-next"${nb.next ? '' : ' disabled'}>${nb.next ? `${esc(nb.next)} ›` : 'Latest episode'}</button></div>`;

  const mainAction = !s ? '' : future ? '' : on
    ? `<div class="pg-actions"><div class="watched-pill">${ico('check')}<span>Watched${times > 1 ? ` · ${times}×` : ''}${log ? ` · ${esc(log.at.slice(0, 10))}` : ''}</span></div>
         <button class="btn act-again">Watch again</button></div>`
    : '<button class="btn gold act-toggle pg-main">Mark watched</button>';

  const about = `<div class="ep-when">${ico('calendar')}<span class="ep-air">${esc(ep.air_date || 'Date not announced')}</span></div>` +
    clampBlock(ep.overview || 'No synopsis yet.');

  body.innerHTML = sheetHeader(ep.name || showName, ep.still_path || show.backdrop_path, show.poster_path, chips) +
    `<button class="ep-show">${esc(show.name || showName)} ›</button>` + nav + mainAction +
    sec('About', about) +
    (on && log ? '<section class="pg-sec you-slot"></section>' : '') +
    '<section class="pg-sec people-slot"></section></div>';

  wireClamp(body);
  tintSheet(show.poster_path);
  body.querySelector('.ep-show').onclick = () => openShow(showId, showName);

  const go = (c) => { if (c) { buzz(6); openEpisode(showId, showName, c); } };
  const pb = body.querySelector('.ep-prev'), nbtn = body.querySelector('.ep-next');
  if (pb) pb.onclick = () => go(nb.prev);
  if (nbtn) nbtn.onclick = () => go(nb.next);

  // Swipe sideways across the hero or title to change episode. Kept off the
  // cast strip, which scrolls sideways itself.
  ['.sheet-hero', '.sheet-head', '.ep-nav'].forEach(sel => {
    const zone = body.querySelector(sel);
    if (!zone) return;
    let x0 = 0, y0 = 0;
    zone.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    zone.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? nb.next : nb.prev);
    });
  });

  // Exact Dubai air time for an episode that hasn't aired yet.
  if (future) tvmazeAirstamps(showId).then(stamps => {
    const at = airLocalFor({ code, date: ep.air_date }, stamps);
    const air = body.querySelector('.ep-air');
    if (at && air) air.textContent = `${new Date(at.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${at.slice(11, 16)} Dubai · ${countdownAt(at)}`;
  }).catch(() => {});

  moreMenu(body, `${show.name || showName} · ${code}`, [
    on ? ['Unmark watched', async () => {
      if (await guardedWrite('toggle episode', () => setEpisode(showId, code, false, { name: showName, quiet: true }))) {
        buzz(); toast('Unmarked'); openEpisode(showId, showName, code); render();
      }
    }] : null,
    ['Open series', () => openShow(showId, showName)],
  ]);

  const toggle = body.querySelector('.act-toggle');
  if (toggle) toggle.onclick = async (e) => {
    e.target.disabled = true;
    if (!await guardedWrite('toggle episode', () => setEpisode(showId, code, true, { name: showName, quiet: true }))) return;
    buzz(); toast(`${code} logged`); openEpisode(showId, showName, code); render();
  };
  const again = body.querySelector('.act-again');
  if (again) again.onclick = async () => {
    again.disabled = true;
    if (await guardedWrite('rewatch', () => rewatchEpisode(showId, code, { name: showName }))) {
      buzz(); toast(`${code} logged again`); openEpisode(showId, showName, code);
    } else again.disabled = false;
  };

  const youSlot = body.querySelector('.you-slot');
  if (youSlot && log) journalEditor(youSlot, log, { kind: 'tv', id: showId, code });
  const people = body.querySelector('.people-slot');
  peopleStrip(people, 'In this episode', (credits.cast || []).slice(0, 15));
  peopleStrip(people, 'Guest stars', (credits.guest_stars || []).slice(0, 15));
}

/** The next aired episode you haven't watched, resuming from where you are. */
function nextUpFor(showId, b) {
  const s = getShow(showId);
  if (!s) return null;
  const mark = furthestWatched(s), today = TODAY();
  const seasons = (b.seasons || []).filter(x => x.season_number > 0)
    .map(x => x.season_number).sort((a, c) => a - c);
  for (const n of seasons) {
    for (const ep of seasonEps(b, n)) {
      const code = `S${n}E${ep.episode_number}`;
      if (s.watched_episodes.includes(code)) continue;
      const air = (ep.air_date || '').trim();
      if (!air || air > today) continue;
      if (n < mark.season || (n === mark.season && ep.episode_number < mark.ep)) continue;
      return { n, ep, code };
    }
  }
  return null;
}

/** Five-way status selector, shown under a sheet's title. */
function statusBar(item, kind, onChange) {
  const cur = effectiveStatus(item, kind);
  const bar = el('div', 'status-bar');
  STATUSES.forEach(([key, label]) => {
    const b = el('button', 'sb' + (cur === key ? ' on' : '') + (item.status ? '' : ' auto'), esc(label));
    b.onclick = async () => {
      if (effectiveStatus(item, kind) === key && item.status) return;
      setStatus(item, key);
      invalidateFeeds();
      if (await guardedWrite('status', () => savePayload())) {
        buzz(8); toast(`${label}`);
        onChange();
      }
    };
    bar.appendChild(b);
  });
  if (!item.status) bar.appendChild(el('div', 'sb-note', 'Set automatically from your progress — tap to choose'));
  return bar;
}

/* ------------------------------------------------------------------
   DETAIL PAGES share one order:
     hero → title & status → your main action → about → you →
     where to watch → content → people → more like this
   "About" comes before "you" so a page always answers what this is
   before what you've done with it. Rare actions live behind ⋯.
   ------------------------------------------------------------------ */
const fmtMins = (m) => m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
                    : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`;

const sec = (title, inner, cls = '') => inner ? `<section class="pg-sec ${cls}">${title ? `<div class="pg-h">${esc(title)}</div>` : ''}${inner}</section>` : '';

/** ⋯ button in the sheet's corner; actions are [label, fn, danger?]. */
function moreMenu(body, title, actions) {
  const list = actions.filter(Boolean);
  if (!list.length) return;
  const b = el('button', 'sheet-more', ico('dots'));
  b.setAttribute('aria-label', 'More actions');
  b.onclick = () => quickMenu({ title, actions: list });
  body.prepend(b);
}

/** Overview clamped to four lines with a More toggle. */
function clampBlock(text) {
  if (!text) return '';
  return `<div class="ov-wrap"><p class="overview clamp">${esc(text)}</p>
    ${text.length > 260 ? '<button class="ov-more">More</button>' : ''}</div>`;
}
function wireClamp(body) {
  body.querySelectorAll('.ov-more').forEach(btn => {
    btn.onclick = () => {
      const p = btn.previousElementSibling;
      const open = p.classList.toggle('clamp') === false;
      btn.textContent = open ? 'Less' : 'More';
    };
  });
}

let justTicked = null;     // only this episode's tick should animate

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

  const chips = [];
  if (b.vote_average) chips.push(`★ ${b.vote_average.toFixed(1)}`);
  if (b.first_air_date) chips.push(b.first_air_date.slice(0, 4) + (b.status === 'Ended' ? '' : '–'));
  if (inLib && (s.cycles || 1) > 1) chips.push(`↻ Rewatch #${s.cycles}`);
  (b.genres || []).slice(0, 2).forEach(g => chips.push(g.name));

  const left = Math.max(0, total - watched);
  const mins = left * epMins;
  const nxt = b.next_episode_to_air;
  const up = inLib ? nextUpFor(showId, b) : null;

  // ---- main action: what you'd do next ----
  const mainAction = !inLib
    ? '<button class="btn gold act-lib pg-main">Add to library</button>'
    : up ? `<div class="nextup">
        <div class="nu-still">${up.ep.still_path ? `<img loading="lazy" decoding="async" src="${imgUrl(up.ep.still_path, 'w300')}" alt="">` : ''}</div>
        <div class="nu-body"><span class="nu-k">Up next · ${esc(up.code)}</span>
          <b>${esc(up.ep.name || 'Episode ' + up.ep.episode_number)}</b>
          <i>${esc(relDay(up.ep.air_date))}</i></div>
        <button class="btn gold nu-mark">Watched</button></div>` : '';

  // ---- about ----
  const about = clampBlock(b.overview) +
    (nxt?.air_date ? `<div class="callout"><b>Next episode</b>
      S${nxt.season_number}E${nxt.episode_number} · ${esc(nxt.name || 'TBA')}<br>
      <i>${nxt.air_date} · ${countdown(nxt.air_date)}</i></div>` : '') +
    '<div class="trailer-slot"></div>';

  // ---- you: one progress line instead of four competing displays ----
  const fav = inLib ? favouriteTally(showId)[0] : null;
  const you = !inLib ? '' :
    (total ? `<div class="prog-line"><div class="progress"><span style="width:${Math.min(watched / total, 1) * 100}%"></span></div>
       <div class="prog-tx"><b>${watched} of ${total}</b><span>${left ? `${left} left · about ${fmtMins(mins)}` : 'finished'}</span></div></div>` : '') +
    (fav ? `<div class="fav-card"><span class="fav-ph">${fav.p ? `<img loading="lazy" decoding="async" src="${imgUrl(fav.p, 'w185')}" alt="">` : ''}</span>
        <span class="fav-tx"><i>Your favourite</i><b>${esc(fav.c)}</b><small>${esc(fav.n)} · picked ${fav.count}×</small></span></div>` : '') +
    (stats ? `<div class="facts">
       <div class="fact"><span>${ico("calendar")}</span><span>First watched</span><b>${stats.first}</b></div>
       ${stats.last !== stats.first ? `<div class="fact"><span>${ico("clock")}</span><span>Last watched</span><b>${stats.last}</b></div>` : ''}
       <div class="fact"><span>${ico("check")}</span><span>Episodes logged</span><b>${stats.count}</b></div>
       ${stats.rated ? `<div class="fact"><span>${ico("star")}</span><span>Your average</span><b>${stats.avg} over ${stats.rated}</b></div>` : ''}
       ${stats.platform ? `<div class="fact"><span>${ico("tv")}</span><span>Mostly on</span><b>${esc(stats.platform)}</b></div>` : ''}
       ${stats.mood ? `<div class="fact"><span>${ico("smile")}</span><span>Usually</span><b>${esc(stats.mood)}</b></div>` : ''}</div>` : '');

  // ---- episodes ----
  const seasons = `<div class="pg-sec-row"><div class="pg-h">Episodes</div>
      ${inLib ? '<button class="btn act-season pg-mini">Mark season</button>' : ''}</div>
    <div class="season-chips"></div><div class="field season-field"><label>Season</label><select class="sel-season">${
      (b.seasons || []).filter(x => x.season_number > 0).map(x => {
        const eps = seasonEps(b, x.season_number);
        const done = eps.filter(e => epWatched(showId, `S${x.season_number}E${e.episode_number}`)).length;
        return `<option value="${x.season_number}">Season ${x.season_number} — ${done}/${eps.length}${eps.length && done === eps.length ? ' ✓' : ''}</option>`;
      }).join('')}</select></div><div class="ep-list"></div>`;

  body.innerHTML = `<div class="sheet-compact"><div><b>${esc(b.name || showName)}</b>
      ${inLib && total ? `<i>${watched}/${total}</i>` : ''}</div></div>` +
    sheetHeader(b.name || showName, b.backdrop_path, b.poster_path, chips) +
    mainAction +
    sec('About', about) +
    sec('You', you) +
    (prov.length ? sec('', providerRows(prov)) : '') +
    `<section class="pg-sec">${seasons}</section>` +
    '<section class="pg-sec cast-slot"></section><section class="pg-sec recs-slot"></section>' +
    (inLib && watched > 0 ? '<button class="act-restart" hidden></button>' : '') +
    '</div>';

  wireClamp(body);
  moreMenu(body, b.name || showName, [
    inLib && watched > 0 ? ['Start series again', () => body.querySelector('.act-restart').click()] : null,
    inLib ? ['Remove from library', async () => {
      if (!confirm(`Remove ${b.name || showName} from your library?\n\nYour watch history stays in your diary.`)) return;
      db.shows = db.shows.filter(x => String(x.id) !== String(showId));
      invalidateFeeds();
      if (await guardedWrite('remove show', () => savePayload())) { toast('Removed'); closeSheet(); render(); }
    }, true] : null,
  ]);

  tintSheet(b.poster_path);
  if (inLib) {
    const head = body.querySelector('.sheet-head');
    if (head) head.after(statusBar(s, 'tv', () => openShow(showId, showName)));
  }
  const list = body.querySelector('.ep-list');
  const sel = body.querySelector('.sel-season');

  // Open on the season you're actually in, not always season 1.
  const startSeason = up ? up.n : (inLib ? furthestWatched(s).season : 0);
  if (startSeason && [...sel.options].some(o => +o.value === startSeason)) sel.value = String(startSeason);

  const chipRow = body.querySelector('.season-chips');
  const paintChips = () => {
    chipRow.innerHTML = '';
    for (const x of (b.seasons || []).filter(q => q.season_number > 0)) {
      const n = x.season_number;
      const eps = seasonEps(b, n);
      const done = eps.filter(e => epWatched(showId, `S${n}E${e.episode_number}`)).length;
      const full = eps.length && done === eps.length;
      const c = el('button', 'schip' + (+sel.value === n ? ' on' : '') + (full ? ' done' : ''));
      c.innerHTML = `<b>S${n}</b><i>${full ? '✓' : eps.length ? `${done}/${eps.length}` : '—'}</i>`;
      c.onclick = () => { sel.value = String(n); paintChips(); drawSeason(); buzz(6); };
      chipRow.appendChild(c);
    }
    const on = chipRow.querySelector('.schip.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  };

  const markUp = body.querySelector('.nu-mark');
  if (markUp) markUp.onclick = async () => {
    markUp.disabled = true;
    if (await guardedWrite('next-up', () => setEpisode(showId, up.code, true, { name: b.name || showName }))) {
      buzz();
      toastAction(`${up.code} watched`, 'Undo', async () => {
        if (await guardedWrite('undo', () => setEpisode(showId, up.code, false, { name: b.name || showName }))) {
          openShow(showId, showName);
        }
      });
      openShow(showId, showName);
    } else markUp.disabled = false;
  };

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
        meta.push('Watched ' + log.at.slice(0, 10));
        if (seenTimes > 1) meta.push(`↻ ${seenTimes}×`);
        if (log.rating) meta.push('★'.repeat(log.rating));
        if (log.platform) meta.push(log.platform);
      } else if (future) meta.push(`Airs ${air} · ${countdown(air)}`);
      else if (air) meta.push(air);
      if (ep.vote_average) meta.push(`★ ${ep.vote_average.toFixed(1)}`);

      const row = el('div', 'ep');
      row.innerHTML = `<div class="ep-thumb">
          ${ep.still_path ? `<img loading="lazy" decoding="async" src="${imgUrl(ep.still_path, 'w300')}" style="${future ? 'opacity:.45' : ''}" alt="">`
                          : '<div class="ep-noimg">No still</div>'}
          ${on ? '<button class="ep-notes">Notes</button>' : ''}
          ${on ? '<button class="ep-again">↻ Again</button>' : ''}</div>
        <div class="ep-body">
          <button class="ep-check ${on ? 'on' : ''}${on && justTicked === code ? ' just' : ''}"${(!inLib || future) ? ' disabled' : ''}>
            <span>${on ? '✓' : ''}</span><b>${ep.episode_number}. ${esc(ep.name || 'Episode')}</b></button>
          <div class="ep-meta">${esc(meta.join(' · '))}</div>
          <div class="ep-ov">${esc(ep.overview || '')}</div></div>`;
      const chk = row.querySelector('.ep-check');
      if (chk && !chk.disabled) chk.onclick = async () => {
        if (!await guardedWrite('toggle episode', () => (setEpisode(showId, code, !on, { name: b.name || showName })))) return;
        justTicked = on ? null : code;     // animate this tick only
        drawSeason(); paintChips(); buzz(); toast(on ? 'Unmarked' : `${code} logged`);
        justTicked = null;
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
  sel.onchange = () => { paintChips(); drawSeason(); };
  paintChips();
  drawSeason();
  castStrip('tv', showId, body.querySelector('.cast-slot'));
  trailerBlock('tv', showId, body.querySelector('.trailer-slot'));
  moreLikeThis('tv', showId, body.querySelector('.recs-slot'));

  const seasonBtn = body.querySelector('.act-season');
  if (seasonBtn) seasonBtn.onclick = async (e) => {
    if (!inLib) return toast('Add the show first');
    e.target.disabled = true;
    const n = +sel.value;
    const codes = seasonEps(b, n).filter(ep => (ep.air_date || '') && (ep.air_date || '') <= today)
      .map(ep => `S${n}E${ep.episode_number}`);
    if (!await guardedWrite('mark season', () => markMany(showId, codes, true))) return;
    e.target.disabled = false;
    drawSeason(); paintChips(); buzz(18); toast(`Season ${n} logged`);
  };

  const restart = body.querySelector('.act-restart');
  if (restart) restart.onclick = async () => {
    const n = (s.cycles || 1) + 1;
    if (!confirm(`Start ${b.name || showName} again?\n\nProgress resets to 0 and this becomes rewatch #${n}. `
               + `Your ${countedEps(s)} existing watch dates stay in your diary.`)) return;
    s.cycles = n;
    s.watched_episodes = [];          // history rows are deliberately kept
    invalidateFeeds();
    if (await guardedWrite('restart series', () => savePayload())) {
      buzz(20); toast(`Rewatch #${n} started`);
      openShow(showId, showName); render();
    }
  };

  const libBtn = body.querySelector('.act-lib');
  if (libBtn) libBtn.onclick = async () => {
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

/** Log another viewing of a film without touching the first. */
async function rewatchMovie(id, meta = {}) {
  const m = getMovie(id);
  if (!m) return false;
  m.watched = true;
  await addHistory('movie', id, '', stamp());
  invalidateFeeds();
  await savePayload();
  return true;
}

async function openMovie(id, name) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const [d, credits] = await Promise.all([tmdb(`movie/${id}`), tmdb(`movie/${id}/credits`).catch(() => ({}))]);
  const m = getMovie(id);
  const inLib = !!m;
  const on = movieWatched(id);
  const prov = await providersFor('movie', id);
  const times = timesWatched('movie', id);
  const log = findLog('movie', id);

  const chips = [];
  if (d.release_date) chips.push(d.release_date.slice(0, 4));
  if (d.runtime) chips.push(fmtMins(d.runtime));
  if (d.vote_average) chips.push(`★ ${d.vote_average.toFixed(1)}`);
  (d.genres || []).slice(0, 2).forEach(g => chips.push(g.name));

  // ---- main action ----
  const mainAction = !inLib
    ? `<div class="pg-actions"><button class="btn gold act-lib">Add to library</button>
         <button class="btn act-toggle">Mark watched</button></div>`
    : on ? `<div class="pg-actions"><div class="watched-pill">${ico('check')}<span>Watched${times > 1 ? ` · ${times}×` : ''}${log ? ` · ${esc(log.at.slice(0, 10))}` : ''}</span></div>
         <button class="btn act-again">Watch again</button></div>`
    : '<button class="btn gold act-toggle pg-main">Mark watched</button>';

  // ---- about ----
  const directors = (credits.crew || []).filter(c => c.job === 'Director').map(c => c.name);
  const about = (d.tagline ? `<p class="tagline">${esc(d.tagline)}</p>` : '') + clampBlock(d.overview) +
    `<div class="facts">
      ${directors.length ? `<div class="fact"><span>${ico('film')}</span><span>Directed by</span><b>${esc(directors.slice(0, 2).join(', '))}</b></div>` : ''}
      ${d.release_date ? `<div class="fact"><span>${ico('calendar')}</span><span>Released</span><b>${esc(new Date(d.release_date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}</b></div>` : ''}
      ${d.runtime ? `<div class="fact"><span>${ico('clock')}</span><span>Runtime</span><b>${fmtMins(d.runtime)}</b></div>` : ''}
    </div><div class="trailer-slot"></div>`;

  body.innerHTML = sheetHeader(d.title || name, d.backdrop_path, d.poster_path, chips) +
    mainAction +
    sec('About', about) +
    (on && log ? '<section class="pg-sec you-slot"></section>' : '') +
    (prov.length ? sec('', providerRows(prov)) : '') +
    '<section class="pg-sec coll-slot"></section><section class="pg-sec cast-slot"></section><section class="pg-sec recs-slot"></section></div>';

  wireClamp(body);
  tintSheet(d.poster_path);
  if (inLib) {
    const head = body.querySelector('.sheet-head');
    if (head) head.after(statusBar(m, 'movie', () => openMovie(id, name)));
  }

  moreMenu(body, d.title || name, [
    on ? ['Unmark watched', async () => {
      if (await guardedWrite('toggle film', () => setMovie(id, false, { name, quiet: true }))) {
        buzz(); toast('Unmarked'); openMovie(id, name); render();
      }
    }] : null,
    inLib ? ['Remove from library', async () => {
      if (!confirm(`Remove “${d.title || name}” from your library? Its watch history stays.`)) return;
      db.movies = db.movies.filter(x => String(x.id) !== String(id));
      invalidateFeeds();
      if (await guardedWrite('remove film', () => savePayload())) { toast('Removed'); closeSheet(); render(); }
    }, true] : null,
  ]);

  const toggle = body.querySelector('.act-toggle');
  if (toggle) toggle.onclick = async (e) => {
    e.target.disabled = true;
    if (!await guardedWrite('toggle film', () => setMovie(id, true, { name, quiet: true }))) return;
    buzz(); toast('Logged'); openMovie(id, name); render();
  };
  const again = body.querySelector('.act-again');
  if (again) again.onclick = async () => {
    again.disabled = true;
    if (await guardedWrite('rewatch film', () => rewatchMovie(id))) {
      buzz(); toast(`Logged again · ${timesWatched('movie', id)}× now`); openMovie(id, name);
    } else again.disabled = false;
  };
  const libBtn = body.querySelector('.act-lib');
  if (libBtn) libBtn.onclick = async () => {
    db.movies.push({ id, name: d.title || name, watched: false, poster_path: d.poster_path || '',
      release_date: d.release_date || '', runtime: d.runtime || MOVIE_MINUTES, dropped: false, status: '' });
    invalidateFeeds();
    if (await guardedWrite('add film', () => savePayload())) { toast('Added to library'); openMovie(id, name); }
  };

  const youSlot = body.querySelector('.you-slot');
  if (youSlot && log) journalEditor(youSlot, log, { kind: 'movie', id });
  castStrip('movie', id, body.querySelector('.cast-slot'));
  trailerBlock('movie', id, body.querySelector('.trailer-slot'));
  collectionBlock(d, body.querySelector('.coll-slot'));
  moreLikeThis('movie', id, body.querySelector('.recs-slot'));
}

async function openMatch(showId, showName, code, game) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const on = epWatched(showId, code);
  const md = (/^S(\d+)E/.exec(code) || [])[1] || '';
  const score = matchScore(game);
  const finished = game.status === 'FINISHED';

  const [mcode] = parseFootballId(showId);
  const done = finished && game.home_goals != null;
  const side = (h) => !done ? '' : ((h ? game.home_goals - game.away_goals : game.away_goals - game.home_goals) > 0 ? ' win'
                 : game.home_goals === game.away_goals ? '' : ' lose');
  // Each club's crest, huge and cropped at its own half of the hero.
  const halves = `<div class="mh-halves">
      <span class="mh-half l">${game.home_crest ? `<img loading="lazy" decoding="async" src="${game.home_crest}" alt="">` : ''}</span>
      <span class="mh-half r">${game.away_crest ? `<img loading="lazy" decoding="async" src="${game.away_crest}" alt="">` : ''}</span>
    </div>`;
  body.innerHTML = `<div class="sheet-hero plain match-hero" style="--cc:${compRgb(mcode)}">${halves}
      <div class="mh-md">Matchday ${esc(md)}</div>
      <div class="mh-teams">
        <div class="mh-team${side(true)}">${game.home_crest ? `<img loading="lazy" decoding="async" src="${game.home_crest}" alt="">` : ''}
          <span>${esc(game.home)}</span></div>
        <div class="mh-score">${esc(score || 'v')}</div>
        <div class="mh-team${side(false)}">${game.away_crest ? `<img loading="lazy" decoding="async" src="${game.away_crest}" alt="">` : ''}
          <span>${esc(game.away)}</span></div>
      </div>
      <div class="mh-when">${esc(game.date ? fbDayLabel(game.date) : '')} · ${esc((game.kickoff || '').slice(11, 16))} Dubai · ${finished ? 'Full time'
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
    if (!await guardedWrite('toggle episode', () => (setEpisode(showId, code, !on, { name: showName, quiet: true })))) return;
    buzz(); toast(on ? 'Unmarked' : 'Logged');
    openMatch(showId, showName, code, game);
    render();
  };
  const mdBtn = body.querySelector('.act-season');
  if (mdBtn) mdBtn.onclick = () => openFootball(showId, showName);

  // Rating, platform and mood — the same journal every episode gets.
  const log = findLog('tv', showId, code);
  if (on && log) journalEditor(inner, log, { kind: 'football', id: showId, code });
  else if (on) inner.appendChild(el('div', 'muted', 'Notes appear once the watch is saved.'));
}

/* ------------------------------------------------------------------
   FOOTBALL PAGE
   Matchday chips instead of a dropdown, fixtures as cards grouped by day,
   swipe to mark watched, and your team leading the page.
   ------------------------------------------------------------------ */
let fbMd = null, fbView = 'md';

/** Each league's own colour, used behind its page and match heroes. */
const COMP_RGB = { PL: '61,25,91', CL: '14,30,91', PD: '255,75,68', SA: '0,140,255', BL1: '210,10,20', FL1: '218,225,0', DED: '255,100,0', PPL: '0,90,60', ELC: '60,90,170' };
const compRgb = (code) => COMP_RGB[code] || '143,168,255';

/** Last five results for a team, oldest first: W, D or L. */
function formGuide(all, team) {
  return all.filter(x => x.g.status === 'FINISHED' && x.g.home_goals != null && (x.g.home === team || x.g.away === team))
    .sort((a, b) => (a.g.kickoff || '').localeCompare(b.g.kickoff || '')).slice(-5)
    .map(x => {
      const mine = x.g.home === team ? x.g.home_goals : x.g.away_goals;
      const theirs = x.g.home === team ? x.g.away_goals : x.g.home_goals;
      return { r: mine > theirs ? 'W' : mine < theirs ? 'L' : 'D', vs: x.g.home === team ? x.g.away : x.g.home, s: `${x.g.home_goals}–${x.g.away_goals}` };
    });
}
const fbTeamKey = (code) => `mytv.team.${code}`;
const fbTeam = (code) => { try { return localStorage.getItem(fbTeamKey(code)) || ''; } catch { return ''; } };

function fbDayLabel(date) {
  return new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** One fixture as a card. Swipe right marks it watched once it has kicked off. */
function fixtureCard(g, md, i, ctx) {
  const code = `S${md}E${i + 1}`;
  const on = ctx.watched.has(code);
  const mine = ctx.team && (g.home === ctx.team || g.away === ctx.team);
  const score = matchScore(g);
  const centre = g.started && score ? `<b class="fx-score">${esc(score)}</b>`
               : `<b class="fx-time">${esc(g.kickoff.slice(11, 16) || 'TBC')}</b>`;
  const status = g.status === 'FINISHED' ? 'Full time' : g.started ? 'Kicked off' : countdown(g.date);

  const done = g.status === 'FINISHED' && g.home_goals != null;
  const res = (side) => !done ? '' : (side === 'h' ? g.home_goals - g.away_goals : g.away_goals - g.home_goals) > 0 ? ' win'
            : (g.home_goals === g.away_goals ? '' : ' lose');
  const wrap = el('div', 'fx-wrap');
  wrap.innerHTML = `<div class="fx-under">${ico('check')}<b>Watched</b></div>
    <div class="fx-card${on ? ' seen' : ''}${mine ? ' mine' : ''}${g.started ? '' : ' later'}">
      <div class="fx-team${res('h')}">${g.home_crest ? `<img loading="lazy" decoding="async" src="${g.home_crest}" alt="">` : ''}<span>${esc(g.home)}</span></div>
      <div class="fx-mid">${centre}<i>${esc(status)}</i></div>
      <div class="fx-team${res('a')}">${g.away_crest ? `<img loading="lazy" decoding="async" src="${g.away_crest}" alt="">` : ''}<span>${esc(g.away)}</span></div>
      ${on ? `<span class="fx-tick">${ico('check')}</span>` : ''}
    </div>`;
  const card = wrap.querySelector('.fx-card');
  let x0 = 0, y0 = 0, dx = 0, axis = null, moved = false;
  const canSwipe = ctx.inLib && g.started && !on;
  card.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; axis = null; moved = false; card.style.transition = 'none';
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (axis === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
    if (axis !== 'x' || !canSwipe) return;
    moved = true; dx = Math.max(0, mx);
    card.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle('armed', dx > card.offsetWidth * .3);
  }, { passive: true });
  card.addEventListener('touchend', async () => {
    card.style.transition = 'transform .28s cubic-bezier(.2,.9,.25,1)';
    if (canSwipe && axis === 'x' && dx > card.offsetWidth * .3) {
      card.style.transform = 'translateX(110%)'; buzz(14);
      if (await guardedWrite('swipe match', () => setEpisode(ctx.showId, code, true, { name: ctx.showName }))) {
        ctx.watched.add(code);
        toastAction(`${g.home} v ${g.away} watched`, 'Undo', async () => {
          if (await guardedWrite('undo', () => setEpisode(ctx.showId, code, false, { name: ctx.showName }))) {
            ctx.watched.delete(code); ctx.redraw();
          }
        });
        setTimeout(ctx.redraw, 240);
      } else card.style.transform = '';
    } else { card.style.transform = ''; wrap.classList.remove('armed'); }
  });
  card.addEventListener('click', () => { if (!moved) openMatch(ctx.showId, ctx.showName, code, g); });
  return wrap;
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
  const watched = new Set(s ? s.watched_episodes : []);
  const all = [];
  Object.entries(days).forEach(([md, games]) => games.forEach((g, i) => all.push({ g, md: +md, i })));
  const total = all.length, played = all.filter(x => x.g.started).length;
  const team = fbTeam(code);
  const teams = [...new Set(all.flatMap(x => [x.g.home, x.g.away]))].filter(t => t && t !== 'TBC').sort();
  const mdKeys = Object.keys(days).map(Number);
  if (fbMd == null || !days[fbMd]) fbMd = mdKeys.find(md => days[md].some(g => !g.started)) ?? mdKeys[mdKeys.length - 1];
  if (fbView === 'team' && !team) fbView = 'md';

  const chips = [`${mdKeys.length} matchdays`];
  if (season !== current) chips.push('Past season');

  const caught = all.filter(x => x.g.started && watched.has(`S${x.md}E${x.i + 1}`)).length;
  const you = inLib ? `<div class="prog-line"><div class="progress"><span style="width:${played ? Math.min(caught / played, 1) * 100 : 0}%"></span></div>
      <div class="prog-tx"><b>${watched.size} watched</b><span>${Math.max(0, played - caught)} to catch up · ${total - played} still to play</span></div></div>` : '';

  const heroHtml = `<div class="fb-hero" style="--cc:${compRgb(code)}">
      <img loading="lazy" decoding="async" class="fb-emblem" src="${emblem}" alt="">
      <div class="fb-title">${esc(FOOTBALL_COMPETITIONS[code] || showName)}</div>
      <div class="fb-season">${season}/${String(season + 1).slice(2)} · ${chips.map(esc).join(' · ')}</div>
    </div><div class="sheet-body">`;
  body.innerHTML = heroHtml +
    (inLib ? '' : '<button class="btn gold act-add pg-main">Track this season</button>') +
    (you ? sec('', you) : '') +
    '<section class="pg-sec team-slot"></section>' +
    '<section class="pg-sec fx-slot"></section></div>';

  const ctx = { showId, showName, watched, team, inLib, redraw: () => openFootball(showId, showName) };

  // ---- your team ----
  const teamSlot = body.querySelector('.team-slot');
  const pickTeam = () => quickMenu({ title: 'Pick your team', actions:
    [...teams.map(t => [t + (t === team ? '  ✓' : ''), () => {
      try { localStorage.setItem(fbTeamKey(code), t); } catch { /* ignore */ }
      fbView = 'team'; buzz(8); openFootball(showId, showName);
    }]), team ? ['Clear team', () => {
      try { localStorage.removeItem(fbTeamKey(code)); } catch { /* ignore */ }
      fbView = 'md'; openFootball(showId, showName);
    }, true] : null] });
  if (!team) {
    const b = el('button', 'team-pick', `${ico('heart')}<span>Pick your team</span><i>Their next match leads this page</i>`);
    b.onclick = pickTeam;
    teamSlot.appendChild(b);
  } else {
    const mineAll = all.filter(x => x.g.home === team || x.g.away === team);
    const next = mineAll.find(x => !x.g.started) || null;
    const last = [...mineAll].reverse().find(x => x.g.started) || null;
    const crest = (mineAll[0] && (mineAll[0].g.home === team ? mineAll[0].g.home_crest : mineAll[0].g.away_crest)) || '';
    const show = next || last;
    const card = el('button', 'team-card');
    const form = formGuide(all, team);
    card.style.setProperty('--cc', compRgb(code));
    card.innerHTML = `<span class="tc-crest">${crest ? `<img loading="lazy" decoding="async" src="${crest}" alt="">` : ''}</span>
      ${form.length ? `<span class="tc-form">${form.map(f => `<i class="f-${f.r.toLowerCase()}" title="${esc(f.vs)} ${esc(f.s)}">${f.r}</i>`).join('')}</span>` : ''}
      <span class="tc-tx"><i>${next ? 'Next match' : 'Last match'}</i>
        <b>${show ? esc(`${show.g.home} v ${show.g.away}`) : esc(team)}</b>
        <small>${show ? esc(`${fbDayLabel(show.g.date)} · ${show.g.kickoff.slice(11, 16)} Dubai · ${show.g.started ? (show.g.status === 'FINISHED' ? 'Full time' : 'Kicked off') : countdown(show.g.date)}`) : ''}</small></span>`;
    card.onclick = () => show && openMatch(showId, showName, `S${show.md}E${show.i + 1}`, show.g);
    teamSlot.appendChild(card);
    const change = el('button', 'team-change', `${esc(team)} · change`);
    change.onclick = pickTeam;
    teamSlot.appendChild(change);
  }

  // ---- fixtures ----
  const slot = body.querySelector('.fx-slot');
  const draw = () => {
    slot.innerHTML = '';
    if (team) {
      const tog = el('div', 'fx-views');
      [['md', 'Matchdays'], ['team', team]].forEach(([k, label]) => {
        const b = el('button', fbView === k ? 'on' : '', esc(label));
        b.onclick = () => { fbView = k; buzz(5); draw(); };
        tog.appendChild(b);
      });
      slot.appendChild(tog);
    }

    let list;
    if (fbView === 'team') {
      list = all.filter(x => x.g.home === team || x.g.away === team);
    } else {
      const chipsRow = el('div', 'md-chips');
      mdKeys.forEach(md => {
        const games = days[md];
        const done = games.filter((g, i) => watched.has(`S${md}E${i + 1}`)).length;
        const live = games.some(g => !g.started) && games.some(g => g.started);
        const c = el('button', 'mdchip' + (md === fbMd ? ' on' : '') + (done === games.length ? ' done' : '') + (live ? ' live' : ''),
          `<b>${md}</b><i>${done === games.length ? '✓' : `${done}/${games.length}`}</i>
           <span class="md-bar"><span style="width:${games.length ? done / games.length * 100 : 0}%"></span></span>`);
        c.onclick = () => { fbMd = md; buzz(5); draw(); };
        chipsRow.appendChild(c);
      });
      slot.appendChild(chipsRow);
      const on = chipsRow.querySelector('.mdchip.on');
      if (on && on.scrollIntoView) setTimeout(() => on.scrollIntoView({ inline: 'center', block: 'nearest' }), 0);

      const head = el('div', 'pg-sec-row');
      head.innerHTML = `<div class="pg-h">Matchday ${fbMd}</div>`;
      const playable = days[fbMd].map((g, i) => g.started ? `S${fbMd}E${i + 1}` : null).filter(Boolean);
      if (inLib && playable.some(c => !watched.has(c))) {
        const all1 = el('button', 'btn pg-mini', 'Mark all');
        all1.onclick = async () => {
          all1.disabled = true;
          if (!await guardedWrite('mark matchday', () => markMany(showId, playable, true))) { all1.disabled = false; return; }
          playable.forEach(c => watched.add(c)); buzz(18); toast(`Matchday ${fbMd} logged`); draw(); render();
        };
        head.appendChild(all1);
      }
      slot.appendChild(head);
      list = days[fbMd].map((g, i) => ({ g, md: fbMd, i }));
    }

    // grouped under day headings
    let lastDay = '';
    list.sort((a, b) => (a.g.kickoff || '').localeCompare(b.g.kickoff || '')).forEach(x => {
      if (x.g.date !== lastDay) {
        lastDay = x.g.date;
        const isToday = x.g.date === TODAY();
        const head = el('div', 'day-head' + (isToday ? ' today' : ''),
          esc(x.g.date ? (isToday ? 'Today · ' : '') + fbDayLabel(x.g.date) : 'Date to be confirmed'));
        slot.appendChild(head);
      }
      slot.appendChild(fixtureCard(x.g, x.md, x.i, { ...ctx, redraw: draw }));
    });
    if (inLib) slot.appendChild(el('div', 'cw-hint', 'Swipe a played match right to mark it watched'));
  };
  draw();

  const add = body.querySelector('.act-add');
  if (add) add.onclick = async () => {
    add.disabled = true;
    await ensureFootballShow(code, season);
    toast('Tracking'); openFootball(showId, showName); render();
  };

  moreMenu(body, showName, [
    inLib && fbView === 'md' ? ['Unmark matchday ' + fbMd, async () => {
      const codes = days[fbMd].map((g, i) => `S${fbMd}E${i + 1}`).filter(c => watched.has(c));
      if (!codes.length) return toast('Nothing to unmark');
      if (await guardedWrite('unmark matchday', () => markMany(showId, codes, false))) {
        toast('Unmarked'); openFootball(showId, showName); render();
      }
    }] : null,
    inLib ? ['Stop tracking this season', async () => {
      if (!confirm(`Stop tracking ${showName}? Your watched matches stay in your diary.`)) return;
      cbDropFootball(s);
      invalidateFeeds();
      if (await guardedWrite('drop season', () => savePayload())) { toast('Stopped tracking'); closeSheet(); render(); }
    }, true] : null,
  ]);
}

function cbDropFootball(show) { if (show) setStatus(show, 'dropped'); }

/* ---------------- boot ---------------- */

async function start() {
  $('#setup').hidden = true;
  $('#app').hidden = false;
  const stage = (msg) => { $('#view').innerHTML = `<div class="spinner">${esc(msg)}</div>`; };
  loadFeedCache();

  if (loadLocalDb()) {
    // Everything needed for the first screen is already on the device.
    window.__mytvBooted = true;
    render();
    syncFromServer();
    return;
  }

  // First run on this device: there is nothing local, so we do have to wait.
  stage('Loading your library…');
  await loadPayload();
  await loadHistoryFirstPage();
  window.__mytvBooted = true;
  render();
  if (safeMode) setTimeout(() => toast('Recovered from a crash — heavy extras are paused for this launch'), 1200);
  loadHistoryRest(() => { if (view === 'me' || meTab === 'journal') render(); });
  // Push an earned wrap-up once per app open, oldest first, like Streamlit does.
  // The new recap is the heaviest screen in the app, and launch is already the
  // busiest moment. So it's offered, not forced open — and never at all on a
  // launch that follows a crash.
  const due = pendingRecaps();
  if (due.length && !sessionStorage.getItem('recapShown') && !safeMode) {
    sessionStorage.setItem('recapShown', '1');
    setTimeout(() => {
      const r = due[0];
      toastAction(`Your ${r.kind === 'month' ? prettyMonth(r.key) : r.key} recap is ready`, 'Open',
        () => r.kind === 'month' ? openMonthRecap(r.key, r.id) : openYearRecap(r.key, r.id));
    }, 2500);
  }
}

/** Reconcile with Supabase after the UI is already up. Only repaints when the
    server actually differs, so a normal launch is silent. */
async function syncFromServer() {
  const before = JSON.stringify(pack(db));
  try {
    await loadPayload();
  } catch (e) {
    toast(`Working offline — ${String(e.message || e).slice(0, 40)}`);
    return;                          // the local copy stands
  }
  if (JSON.stringify(pack(db)) !== before) {
    invalidateFeeds();
    render();
  }
  try {
    await loadHistoryFirstPage();
    render();
    await loadHistoryRest();
    if (view === 'me' || meTab === 'journal') render();
  } catch { /* history can wait for the next launch */ }
}

function boot() {
  try { window.history.replaceState({ mytv: true, kind: 'root', view: 'next' }, ''); } catch { /* ignore */ }
  cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
  if (!cfg) { $('#setup').hidden = false; return; }
  start().catch(err => {
    $('#view').innerHTML = '';
    $('#view').appendChild(emptyState("Couldn't finish loading", String(err.message || err),
      { label: 'Retry', onClick: () => { invalidateFeeds(); location.reload(); } }));
    const alt = el('button', 'btn');
    alt.style.cssText = 'width:100%;margin-top:10px';
    alt.textContent = 'Clear caches and reload';
    alt.onclick = async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
        Object.keys(localStorage).filter(k => k !== CFG_KEY).forEach(k => localStorage.removeItem(k));
      } catch { /* best effort */ }
      location.reload();
    };
    $('#view').appendChild(alt);
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
    if (view === b.dataset.view) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    pushHistory({ kind: 'tab', view });     // remember where we came from
    const go = () => { view = b.dataset.view; render(); };
    animateTo(go);
    buzz(6);
  };
});

$('#sheet-close').onclick = closeSheet;
$('#sheet-backdrop').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

/* No service worker is registered any more.

   Two separate bugs in it stopped the app loading entirely — the second
   rejected navigation requests, so the splash screen never cleared. The
   speed it gave us is now handled in here instead: the library, history and
   feeds are cached locally, so a launch does not wait on the network either
   way. sw.js is kept only to uninstall the old one. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(rs => rs.forEach(r => r.unregister()))
    .catch(() => {});
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
      invalidateFeeds();          // stale, but still paints while refreshing
      try { await loadPayload(); await loadHistory(); } catch { /* offline */ }
      bar.classList.remove('busy');
      render();
      toast('Refreshed');
    }
  });
})();

/** Cross-fade between tabs where it's safe; otherwise switch instantly.

    Chrome aborts a view transition if the screen size changes mid-animation —
    the keyboard closing as you leave a search box, or the address bar sliding
    away. The switch itself still happens; only the animation is skipped. But
    the abort also rejects the transition's promises, and leaving those
    unhandled surfaced a harmless skip as an alarming "invalid state" error.

    So: no animation while the keyboard is up (that resize is a certainty),
    and every promise the transition returns is handled. */
function animateTo(update) {
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing) document.activeElement.blur();
  if (typing || !document.startViewTransition
      || matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return; }
  try {
    const t = document.startViewTransition(update);
    const quiet = () => {};                       // a skipped animation is not an error
    if (t && t.ready) t.ready.catch(quiet);
    if (t && t.finished) t.finished.catch(quiet);
    if (t && t.updateCallbackDone) t.updateCallbackDone.catch(quiet);
  } catch {
    update();                                     // never lose the tab switch itself
  }
}

/* Collapsing hero. As a sheet scrolls, the backdrop drifts slower than the
   content (parallax) and a compact title bar fades in once the big title has
   scrolled away. Transform and opacity only — the earlier sticky header with
   backdrop-filter smeared on mobile, so this deliberately avoids both. */
(function collapsingHero() {
  const sheet = $('#sheet');
  let ticking = false;
  sheet.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const y = sheet.scrollTop;
      sheet.classList.toggle('scrolled', y > 170);
      const img = sheet.querySelector('.sheet-hero img');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (img && y < 320) img.style.transform = `translateY(${y * 0.35}px) scale(${1 + Math.min(y, 200) / 2000})`;
    });
  }, { passive: true });
})();

/* Drag a sheet down from the top to dismiss it, like any native sheet. */
(function sheetDrag() {
  const sheet = $('#sheet');
  let y0 = 0, dy = 0, dragging = false;
  sheet.addEventListener('touchstart', (e) => {
    if (sheet.classList.contains('story-mode')) return;   // stories swipe sideways
    dragging = sheet.scrollTop <= 0;
    y0 = e.touches[0].clientY; dy = 0;
    sheet.style.transition = 'none';
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { sheet.style.transform = ''; return; }
    sheet.style.transform = `translateY(${dy * 0.85}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = 'transform .28s cubic-bezier(.2,.9,.25,1)';
    if (dy > 120) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => { sheet.style.transition = ''; closeSheet(); }, 240);
    } else {
      sheet.style.transform = '';
    }
  });
})();

boot();
