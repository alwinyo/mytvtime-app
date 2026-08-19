/* ============================================================
   My TV Time — PWA
   Reads and writes the SAME Supabase data as the Streamlit app:
     • tv_time_data.payload  → shows, movies, analytics, recaps
     • watch_history table   → every watch, uncapped
   So both apps stay in sync and you can fall back any time.
   ============================================================ */

'use strict';

const CFG_KEY = 'mytv.cfg';
const TMDB_TTL = 12 * 60 * 60 * 1000;   // 12h, same as the Streamlit cache

const PLATFORMS = ['', 'Stremio', 'Netflix', 'OSN+', 'Amazon Prime', 'Apple TV+',
                   'Disney+', 'Starzplay', 'Cinema', 'Downloaded', 'Other'];
const MOODS = ['', '🤯 Mind Blown', '😂 Hilarious', '😭 Emotional', '😍 Loved it',
               '😡 Frustrated', '😴 Bored', '🍿 Pure Hype', '🧠 Genius Plot',
               '💔 Heartbroken', '🤬 Trash', '🫣 Edge of Seat', '📈 Peak Cinema'];

let cfg = null;
let db = { shows: [], movies: [], analytics: {}, seen_recaps: [] };
let history = [];
let view = 'next';
let libFilter = 'WATCHLIST', libKind = 'tv', genre = 'Trending';
let searchTimer = null;

const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const img = (p, size = 'w342') => p ? `https://image.tmdb.org/t/p/${size}${p}` : '';

/* Dubai time, matching the Streamlit app's clock exactly */
const now = () => new Date(Date.now() + 4 * 3600 * 1000);
const stamp = (d = now()) => d.toISOString().slice(0, 19).replace('T', ' ');
const TODAY = () => stamp().slice(0, 10);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------------- storage layer ---------------- */

async function sb(path, opts = {}) {
  const res = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function tmdb(path, params = {}) {
  const qs = new URLSearchParams({ api_key: cfg.tmdb, ...params }).toString();
  const cacheKey = 'tmdb:' + path + '?' + qs.replace(/api_key=[^&]*&?/, '');
  try {
    const hit = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (hit && Date.now() - hit.t < TMDB_TTL) return hit.v;
  } catch { /* ignore a corrupt entry */ }

  const res = await fetch(`https://api.themoviedb.org/3/${path}?${qs}`);
  if (!res.ok) return {};
  const data = await res.json();
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v: data }));
  } catch {
    // Quota full: drop the TMDB cache and carry on. Never break a render.
    Object.keys(localStorage).filter(k => k.startsWith('tmdb:')).forEach(k => localStorage.removeItem(k));
  }
  return data;
}

/* Episode-range packing, byte-identical to the Python encode_eps/decode_eps
   so the Streamlit app can still read anything this app writes. */
function encodeEps(list) {
  // A Map, not an object: JS objects re-order integer-like keys ascending,
  // while Python preserves insertion order. A Map keeps the two apps writing
  // byte-identical strings so the payload doesn't churn on every save.
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
    })),
    shows: (p.s || []).map(s => ({
      id: s[0], name: s[1], watched_episodes: decodeEps(s[2]), poster_path: s[3],
      first_air_date: s[4], total_episodes: s[5], dropped: !!s[6],
    })),
    analytics: Object.fromEntries(Object.entries(p.a || {}).map(([k, v]) => [k, { tv: v[0], movie: v[1] }])),
    seen_recaps: p.r || [],
  };
}

function pack(d) {
  return {
    m: d.movies.map(m => [m.id, m.name, m.watched ? 1 : 0, m.poster_path || '',
                          m.release_date || '', m.runtime || 0, m.dropped ? 1 : 0]),
    s: d.shows.map(s => [s.id, s.name, encodeEps(s.watched_episodes || []), s.poster_path || '',
                         s.first_air_date || '', s.total_episodes || 1, s.dropped ? 1 : 0]),
    a: Object.fromEntries(Object.entries(d.analytics || {}).map(([k, v]) => [k, [v.tv || 0, v.movie || 0]])),
    r: d.seen_recaps || [],
  };
}

async function loadPayload() {
  const rows = await sb('tv_time_data?id=eq.1&select=payload');
  db = unpack(rows?.[0]?.payload || {});
}

async function savePayload() {
  await sb('tv_time_data?id=eq.1', {
    method: 'PATCH',
    body: JSON.stringify({ payload: pack(db) }),
    headers: { Prefer: 'return=minimal' },
  });
}

async function loadHistory() {
  const cols = 'id,media_type,item_id,episode_code,watched_at,rating,feeling,platform';
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await sb(`watch_history?select=${cols}&order=watched_at.desc&limit=1000&offset=${offset}`);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  history = out.map(r => ({
    id: r.id, type: r.media_type, item: String(r.item_id), code: r.episode_code || '',
    at: r.watched_at || '', rating: r.rating || 0, feeling: r.feeling || '', platform: r.platform || '',
  }));
}

async function addHistory(type, itemId, code, when) {
  const row = {
    media_type: type, item_id: String(itemId), episode_code: code || '',
    watched_at: when || stamp(), rating: 0, feeling: '', platform: '',
  };
  const res = await sb('watch_history?on_conflict=media_type,item_id,episode_code', {
    method: 'POST', body: JSON.stringify(row),
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  const saved = { id: res?.[0]?.id, type, item: String(itemId), code: code || '',
                  at: row.watched_at, rating: 0, feeling: '', platform: '' };
  history.unshift(saved);
  bumpAnalytics(type, +1);
  return saved;
}

async function delHistory(type, itemId, code) {
  const i = history.findIndex(h => h.type === type && h.item === String(itemId) && h.code === (code || ''));
  if (i === -1) return;
  const [gone] = history.splice(i, 1);
  bumpAnalytics(type, -1, gone.at);
  if (gone.id) await sb(`watch_history?id=eq.${gone.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

async function patchHistory(entry, fields) {
  Object.assign(entry, fields);
  if (!entry.id) return;
  await sb(`watch_history?id=eq.${entry.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ rating: entry.rating, feeling: entry.feeling, platform: entry.platform }),
    headers: { Prefer: 'return=minimal' },
  });
}

function bumpAnalytics(type, delta, when) {
  const key = (when || stamp()).slice(0, 7);
  const b = (db.analytics[key] ||= { tv: 0, movie: 0 });
  const field = type === 'tv' ? 'tv' : 'movie';
  b[field] = Math.max(0, (b[field] || 0) + delta);
}

/* ---------------- watched state: one source of truth ---------------- */

const getShow = (id) => db.shows.find(s => String(s.id) === String(id));
const getMovie = (id) => db.movies.find(m => String(m.id) === String(id));
const findLog = (type, id, code = '') =>
  history.find(h => h.type === type && h.item === String(id) && h.code === (code || ''));

function epWatched(showId, code) {
  const s = getShow(showId);
  return !!(s && s.watched_episodes.includes(code)) || !!findLog('tv', showId, code);
}
function movieWatched(id) {
  const m = getMovie(id);
  return !!(m && m.watched) || !!findLog('movie', id);
}

async function setEpisode(showId, code, on, meta = {}) {
  let s = getShow(showId);
  if (!s) {
    const d = await tmdb(`tv/${showId}`);
    s = { id: showId, name: meta.name || d.name, watched_episodes: [], poster_path: d.poster_path || '',
          first_air_date: d.first_air_date || '', total_episodes: d.number_of_episodes || 1, dropped: false };
    db.shows.push(s);
  }
  if (on) {
    if (!s.watched_episodes.includes(code)) s.watched_episodes.push(code);
    await addHistory('tv', showId, code);
  } else {
    s.watched_episodes = s.watched_episodes.filter(c => c !== code);
    await delHistory('tv', showId, code);
  }
  await savePayload();
}

async function setMovie(id, on, meta = {}) {
  let m = getMovie(id);
  if (!m) {
    const d = await tmdb(`movie/${id}`);
    m = { id, name: meta.name || d.title, watched: false, poster_path: d.poster_path || '',
          release_date: d.release_date || '', runtime: d.runtime || 120, dropped: false };
    db.movies.push(m);
  }
  m.watched = on;
  if (on) await addHistory('movie', id, ''); else await delHistory('movie', id, '');
  await savePayload();
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

async function computeNext() {
  const rows = [];
  const today = TODAY();
  for (const s of db.shows) {
    if (s.dropped) continue;
    const b = await showBundle(s.id);
    const total = b.number_of_episodes || s.total_episodes || 0;
    if (total && s.watched_episodes.length >= total) continue;
    const seen = new Set(s.watched_episodes);
    for (const info of (b.seasons || []).filter(x => x.season_number > 0)) {
      let found = null;
      for (const ep of seasonEps(b, info.season_number)) {
        const code = `S${info.season_number}E${ep.episode_number}`;
        const air = (ep.air_date || '').trim();
        if (!seen.has(code) && air && air <= today) {
          found = { id: s.id, name: s.name, poster: s.poster_path || b.poster_path,
                    backdrop: b.backdrop_path, code, epName: ep.name || 'Episode', date: air };
          break;
        }
      }
      if (found) { rows.push(found); break; }
    }
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return rows;
}

async function computeSoon() {
  const rows = [];
  const today = TODAY();
  for (const s of db.shows) {
    if (s.dropped) continue;
    const b = await showBundle(s.id);
    const seen = new Set(s.watched_episodes);
    let hit = null;
    for (const info of (b.seasons || []).filter(x => x.season_number > 0)) {
      for (const ep of seasonEps(b, info.season_number)) {
        const code = `S${info.season_number}E${ep.episode_number}`;
        const air = (ep.air_date || '').trim();
        if (!seen.has(code) && air && air > today) {
          hit = { id: s.id, name: s.name, poster: s.poster_path || b.poster_path,
                  code, epName: ep.name || 'Episode', date: air };
          break;
        }
      }
      if (hit) break;
    }
    if (hit) rows.push(hit);
  }
  for (const m of db.movies) {
    if (m.dropped || movieWatched(m.id)) continue;
    const d = (m.release_date || '').trim();
    if (d && d > today) rows.push({ id: m.id, name: m.name, poster: m.poster_path, movie: true, date: d });
  }
  rows.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  return rows;
}

function countdown(date) {
  if (!date) return 'Soon';
  const diff = new Date(date + 'T00:00:00Z') - now();
  if (diff <= 0) return 'Out now';
  const d = Math.floor(diff / 86400000);
  return d > 0 ? `In ${d}d` : `In ${Math.floor(diff / 3600000)}h`;
}

/* ---------------- rendering ---------------- */

function posterEl({ title, poster, badge, progress, onOpen }) {
  const b = el('button', 'poster');
  b.innerHTML =
    `<img loading="lazy" src="${img(poster)}" alt="">` +
    (badge ? `<span class="p-badge">${esc(badge)}</span>` : '') +
    `<span class="p-title">${esc(title)}</span>` +
    (progress >= 0 ? `<span class="p-prog" style="width:${Math.min(progress, 1) * 100}%"></span>` : '');
  b.addEventListener('click', onOpen);
  return b;
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

function segmented(options, current, onPick, wrap) {
  const s = el('div', 'seg' + (wrap ? ' wrap' : ''));
  for (const [label, value] of options) {
    const b = el('button', null, label);
    b.setAttribute('aria-pressed', String(value === current));
    b.onclick = () => onPick(value);
    s.appendChild(b);
  }
  return s;
}

const VIEW_TITLES = { next: 'Up next', soon: 'Coming soon', search: 'Search', library: 'Library', me: 'Me' };

async function render() {
  $('#view-title').textContent = VIEW_TITLES[view];
  document.querySelectorAll('#tabbar button').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.view === view)));
  const v = $('#view');
  v.innerHTML = '<div class="spinner">Loading…</div>';
  try {
    if (view === 'next') await renderNext(v);
    else if (view === 'soon') await renderSoon(v);
    else if (view === 'search') renderSearch(v);
    else if (view === 'library') renderLibrary(v);
    else renderMe(v);
  } catch (err) {
    v.innerHTML = '';
    v.appendChild(emptyState("Couldn't load that", String(err.message || err),
      { label: 'Try again', onClick: render }));
  }
}

async function renderNext(v) {
  const rows = await computeNext();
  v.innerHTML = '';
  if (!rows.length) {
    v.appendChild(emptyState('All caught up', 'Nothing waiting. Add a show and it will show up here.',
      { label: 'Find something', onClick: () => { view = 'search'; render(); } }));
    return;
  }
  const [hero, ...rest] = rows;

  const h = el('button', 'hero');
  h.innerHTML = `<img src="${img(hero.backdrop || hero.poster, 'w780')}" alt="">
    <span class="hero-inner">
      <span class="hero-eyebrow">Up next</span>
      <span class="hero-name">${esc(hero.name)}</span>
      <span class="hero-ep">${esc(hero.code)} · ${esc(hero.epName)}</span>
    </span>`;
  h.onclick = () => openEpisode(hero.id, hero.name, hero.code);
  v.appendChild(h);

  const actions = el('div', 'row-actions');
  const watch = el('button', 'btn gold', 'Mark watched');
  watch.onclick = async () => {
    watch.disabled = true;
    await setEpisode(hero.id, hero.code, true, { name: hero.name });
    toast(`${hero.code} logged`);
    openEpisode(hero.id, hero.name, hero.code);
    render();
  };
  const info = el('button', 'btn', 'Details');
  info.onclick = () => openEpisode(hero.id, hero.name, hero.code);
  actions.append(watch, info);
  v.appendChild(actions);

  if (rest.length) {
    v.appendChild(el('div', 'section-head', `${rest.length} more waiting`));
    v.appendChild(gridOf(rest.map(r => ({
      title: r.name, poster: r.poster, badge: r.code,
      onOpen: () => openEpisode(r.id, r.name, r.code),
    }))));
  }
}

async function renderSoon(v) {
  const rows = await computeSoon();
  v.innerHTML = '';
  if (!rows.length) {
    v.appendChild(emptyState('Nothing scheduled', 'When something in your library has a release date, it lands here.'));
    return;
  }
  v.appendChild(gridOf(rows.map(r => ({
    title: r.name, poster: r.poster,
    badge: r.movie ? countdown(r.date) : `${r.code} · ${countdown(r.date)}`,
    onOpen: () => r.movie ? openMovie(r.id, r.name) : openEpisode(r.id, r.name, r.code),
  }))));
}

function renderSearch(v) {
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

  const run = async (q) => {
    renderSearch.q = q;
    if (!q.trim()) { showDiscover(); return; }
    results.innerHTML = '<div class="spinner">Searching…</div>';
    const [tv, mv] = await Promise.all([
      tmdb('search/tv', { query: q }), tmdb('search/movie', { query: q }),
    ]);
    const items = [
      ...(tv.results || []).map(r => ({ ...r, kind: 'tv' })),
      ...(mv.results || []).map(r => ({ ...r, kind: 'movie' })),
    ].sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 30);

    results.innerHTML = '';
    if (!items.length) {
      results.appendChild(emptyState('No matches', `Nothing found for “${q}”. Try a shorter title.`));
      return;
    }
    results.appendChild(gridOf(items.map(i => ({
      title: i.name || i.title, poster: i.poster_path,
      badge: i.kind === 'tv' ? 'Series' : 'Film',
      onOpen: () => i.kind === 'tv' ? openShow(i.id, i.name) : openMovie(i.id, i.title),
    }))));
  };

  const showDiscover = async () => {
    results.innerHTML = '';
    const GENRES = [['Trending', 'Trending'], ['Comedy', 'Comedy'], ['Action', 'Action'],
                    ['Sci-Fi', 'Sci-Fi'], ['Thriller', 'Thriller'], ['Horror', 'Horror']];
    results.appendChild(segmented(GENRES, genre, g => { genre = g; showDiscover(); }, true));

    const body = el('div');
    body.innerHTML = '<div class="spinner">Loading…</div>';
    results.appendChild(body);

    const TV_IDS = { Comedy: 35, Action: 10759, 'Sci-Fi': 10765, Thriller: 9648, Horror: 9648 };
    const MOV_IDS = { Comedy: 35, Action: 28, 'Sci-Fi': 878, Thriller: 53, Horror: 27 };

    let tvRes, mvRes;
    if (genre === 'Trending') {
      [tvRes, mvRes] = await Promise.all([tmdb('trending/tv/day'), tmdb('trending/movie/day')]);
    } else {
      [tvRes, mvRes] = await Promise.all([
        tmdb('discover/tv', { with_genres: TV_IDS[genre], sort_by: 'popularity.desc' }),
        tmdb('discover/movie', { with_genres: MOV_IDS[genre], sort_by: 'popularity.desc' }),
      ]);
    }
    body.innerHTML = '';
    body.appendChild(el('div', 'section-head', 'Series'));
    body.appendChild(gridOf((tvRes.results || []).slice(0, 12).map(i => ({
      title: i.name, poster: i.poster_path, onOpen: () => openShow(i.id, i.name),
    }))));
    body.appendChild(el('div', 'section-head', 'Films'));
    body.appendChild(gridOf((mvRes.results || []).slice(0, 12).map(i => ({
      title: i.title, poster: i.poster_path, onOpen: () => openMovie(i.id, i.title),
    }))));
  };

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => run(input.value), 400);
  });
  run(input.value);
}

function renderLibrary(v) {
  v.innerHTML = '';
  v.appendChild(segmented([['Series', 'tv'], ['Films', 'movie']], libKind,
    k => { libKind = k; renderLibrary(v); }));
  v.appendChild(segmented(
    [['Watchlist', 'WATCHLIST'], ['Watching', 'WATCHING'], ['Done', 'WATCHED'], ['Dropped', 'DROPPED']],
    libFilter, f => { libFilter = f; renderLibrary(v); }));

  const today = TODAY();
  let items;
  if (libKind === 'tv') {
    items = db.shows.filter(s => {
      const w = s.watched_episodes.length, t = s.total_episodes || 0;
      const done = t > 0 && w >= t;
      if (libFilter === 'DROPPED') return s.dropped;
      if (s.dropped) return false;
      if (libFilter === 'WATCHED') return done;
      if (libFilter === 'WATCHING') return w > 0 && !done;
      return w === 0 && !done;
    }).map(s => ({
      title: s.name, poster: s.poster_path,
      progress: s.total_episodes ? s.watched_episodes.length / s.total_episodes : -1,
      onOpen: () => openShow(s.id, s.name),
    }));
  } else {
    items = db.movies.filter(m => {
      const w = movieWatched(m.id);
      const soon = (m.release_date || '') > today;
      if (libFilter === 'DROPPED') return m.dropped;
      if (m.dropped) return false;
      if (libFilter === 'WATCHED') return w;
      if (libFilter === 'WATCHING') return soon && !w;
      return !w && !soon;
    }).map(m => ({
      title: m.name, poster: m.poster_path, progress: movieWatched(m.id) ? 1 : -1,
      onOpen: () => openMovie(m.id, m.name),
    }));
  }

  if (!items.length) {
    v.appendChild(emptyState('Nothing here yet',
      libFilter === 'DROPPED' ? 'Shows you drop will collect here.' : 'Search for something to add it to your library.',
      { label: 'Search', onClick: () => { view = 'search'; render(); } }));
    return;
  }
  v.appendChild(el('div', 'section-head', `${items.length} ${items.length === 1 ? 'title' : 'titles'}`));
  v.appendChild(gridOf(items));
}

function renderMe(v) {
  v.innerHTML = '';
  const eps = db.shows.reduce((n, s) => n + s.watched_episodes.length, 0);
  const films = db.movies.filter(m => m.watched).length;
  const mins = eps * 45 + db.movies.filter(m => m.watched).reduce((n, m) => n + (m.runtime || 120), 0);

  const row = el('div', 'stat-row');
  row.innerHTML =
    `<div class="stat"><b>${eps.toLocaleString()}</b><span>Episodes</span></div>
     <div class="stat"><b>${films.toLocaleString()}</b><span>Films</span></div>
     <div class="stat"><b>${Math.floor(mins / 1440).toLocaleString()}</b><span>Days watched</span></div>`;
  v.appendChild(row);

  v.appendChild(el('div', 'section-head', `Recent activity · ${history.length} entries`));
  if (!history.length) {
    v.appendChild(emptyState('No history yet', 'Mark something watched and it appears here.'));
  } else {
    for (const h of history.slice(0, 40)) {
      const isTv = h.type === 'tv';
      const obj = isTv ? getShow(h.item) : getMovie(h.item);
      const b = el('button', 'log');
      b.innerHTML =
        `<img loading="lazy" src="${img(obj?.poster_path, 'w185')}" alt="">
         <span class="log-main">
           <span class="log-name">${esc(obj?.name || 'Unknown')}</span>
           <span class="log-meta">${esc(h.at.slice(0, 16))}</span><br>
           ${h.code ? `<span class="chip">${esc(h.code)}</span>` : '<span class="chip">Film</span>'}
           ${h.rating ? `<span class="chip plain">${'★'.repeat(h.rating)}</span>` : ''}
           ${h.platform ? `<span class="chip plain">${esc(h.platform)}</span>` : ''}
           ${h.feeling ? `<span class="chip plain">${esc(h.feeling)}</span>` : ''}
         </span>`;
      b.onclick = () => isTv ? openEpisode(h.item, obj?.name || '', h.code) : openMovie(h.item, obj?.name || '');
      v.appendChild(b);
    }
  }

  v.appendChild(el('div', 'section-head', 'Data'));
  const dl = el('button', 'btn', 'Download a backup');
  dl.style.width = '100%';
  dl.onclick = () => {
    const blob = new Blob([JSON.stringify({ exported_at: stamp(), ...db, history }, null, 2)],
      { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mytvtime-${stamp().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  v.appendChild(dl);

  const reset = el('button', 'btn', 'Disconnect this device');
  reset.style.cssText = 'width:100%;margin-top:8px';
  reset.onclick = () => {
    if (confirm('Remove your keys from this device? Your data in Supabase is untouched.')) {
      localStorage.removeItem(CFG_KEY);
      location.reload();
    }
  };
  v.appendChild(reset);
}

/* ---------------- detail sheet ---------------- */

function openSheet(html) {
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

function sheetHeader(title, backdrop, poster, chips) {
  return `<div class="sheet-hero"><img src="${img(backdrop || poster, 'w780')}" alt=""></div>
    <div class="sheet-head">
      <img src="${img(poster, 'w342')}" alt="">
      <div class="sheet-title">${esc(title)}</div>
    </div>
    <div class="sheet-body">
      <div>${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>`;
}

function journalEditor(container, entry) {
  const wrap = el('div');
  wrap.innerHTML = `<div class="section-head">Your notes</div>
    <div class="field"><label>Rating</label><div class="stars"></div></div>
    <div class="field"><label>Watched on</label>
      <select class="j-plat">${PLATFORMS.map(p =>
        `<option value="${esc(p)}"${p === entry.platform ? ' selected' : ''}>${p || '—'}</option>`).join('')}</select></div>
    <div class="field"><label>Mood</label>
      <select class="j-mood">${MOODS.map(m =>
        `<option value="${esc(m)}"${m === entry.feeling ? ' selected' : ''}>${m || '—'}</option>`).join('')}</select></div>`;

  const stars = wrap.querySelector('.stars');
  for (let n = 1; n <= 5; n++) {
    const b = el('button', null, '★');
    b.setAttribute('aria-pressed', String(entry.rating >= n));
    b.onclick = async () => {
      await patchHistory(entry, { rating: entry.rating === n ? 0 : n });
      [...stars.children].forEach((c, i) => c.setAttribute('aria-pressed', String(entry.rating >= i + 1)));
      toast('Saved');
    };
    stars.appendChild(b);
  }
  wrap.querySelector('.j-plat').onchange = async (e) => { await patchHistory(entry, { platform: e.target.value }); toast('Saved'); };
  wrap.querySelector('.j-mood').onchange = async (e) => { await patchHistory(entry, { feeling: e.target.value }); toast('Saved'); };
  container.appendChild(wrap);
}

async function openEpisode(showId, showName, code) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const m = /^S(\d+)E(\d+)$/.exec(code) || [];
  const [ep, show] = await Promise.all([
    m[1] ? tmdb(`tv/${showId}/season/${m[1]}/episode/${m[2]}`) : {},
    tmdb(`tv/${showId}`),
  ]);
  const on = epWatched(showId, code);
  const chips = [code, on ? 'Watched' : 'Not watched'];
  if (ep.vote_average) chips.push(`★ ${ep.vote_average.toFixed(1)}`);

  body.innerHTML = sheetHeader(ep.name || showName, ep.still_path || show.backdrop_path, show.poster_path, chips) +
    `<p class="overview">${esc(ep.overview || 'No synopsis yet.')}</p>
     <div class="sheet-actions">
       <button class="btn ${on ? '' : 'gold'} act-toggle">${on ? 'Unmark' : 'Mark watched'}</button>
       <button class="btn act-show">Open series</button>
     </div></div>`;

  const inner = body.querySelector('.sheet-body');
  body.querySelector('.act-toggle').onclick = async (e) => {
    e.target.disabled = true;
    await setEpisode(showId, code, !on, { name: showName });
    toast(on ? 'Unmarked' : `${code} logged`);
    openEpisode(showId, showName, code);
    if (view === 'next' || view === 'me') render();
  };
  body.querySelector('.act-show').onclick = () => openShow(showId, showName);

  const log = findLog('tv', showId, code);
  if (on && log) journalEditor(inner, log);
}

async function openShow(showId, showName) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const b = await showBundle(showId);
  const inLib = !!getShow(showId);
  const s = getShow(showId);
  const watched = s ? s.watched_episodes.length : 0;
  const total = b.number_of_episodes || 0;

  const chips = [b.status || 'Series'];
  if (inLib) chips.push(`${watched}/${total} watched`);
  (b.genres || []).slice(0, 3).forEach(g => chips.push(g.name));

  body.innerHTML = sheetHeader(b.name || showName, b.backdrop_path, b.poster_path, chips) +
    `<p class="overview">${esc(b.overview || '')}</p>
     <div class="sheet-actions">
       <button class="btn ${inLib ? '' : 'gold'} act-lib">${inLib ? (s.dropped ? 'Restore' : 'Drop show') : 'Add to library'}</button>
       <button class="btn act-season">Mark season watched</button>
     </div>
     <div class="field"><label>Season</label><select class="sel-season">${
       (b.seasons || []).filter(x => x.season_number > 0)
         .map(x => `<option value="${x.season_number}">Season ${x.season_number}</option>`).join('')
     }</select></div>
     <div class="ep-list"></div></div>`;

  const list = body.querySelector('.ep-list');
  const sel = body.querySelector('.sel-season');

  const drawSeason = () => {
    const n = +sel.value;
    list.innerHTML = '';
    for (const ep of seasonEps(b, n)) {
      const code = `S${n}E${ep.episode_number}`;
      const on = epWatched(showId, code);
      const row = el('button', 'ep');
      row.innerHTML = `<span class="ep-check ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
        <span class="ep-name">${ep.episode_number}. ${esc(ep.name || 'Episode')}</span>
        <span class="ep-date">${esc((ep.air_date || '').slice(0, 10))}</span>`;
      row.onclick = async () => {
        await setEpisode(showId, code, !on, { name: b.name || showName });
        drawSeason();
        toast(on ? 'Unmarked' : `${code} logged`);
      };
      list.appendChild(row);
    }
  };
  sel.onchange = drawSeason;
  drawSeason();

  body.querySelector('.act-season').onclick = async (e) => {
    e.target.disabled = true;
    const n = +sel.value;
    const today = TODAY();
    for (const ep of seasonEps(b, n)) {
      const code = `S${n}E${ep.episode_number}`;
      if (!epWatched(showId, code) && (ep.air_date || '') <= today) {
        await setEpisode(showId, code, true, { name: b.name || showName });
      }
    }
    e.target.disabled = false;
    drawSeason();
    toast(`Season ${n} logged`);
  };

  body.querySelector('.act-lib').onclick = async () => {
    if (!inLib) {
      db.shows.push({ id: showId, name: b.name || showName, watched_episodes: [],
        poster_path: b.poster_path || '', first_air_date: b.first_air_date || '',
        total_episodes: b.number_of_episodes || 1, dropped: false });
      toast('Added to library');
    } else {
      s.dropped = !s.dropped;
      toast(s.dropped ? 'Dropped' : 'Restored');
    }
    await savePayload();
    openShow(showId, showName);
  };
}

async function openMovie(id, name) {
  const body = openSheet('<div class="spinner">Loading…</div>');
  const d = await tmdb(`movie/${id}`);
  const inLib = !!getMovie(id);
  const on = movieWatched(id);

  const chips = [];
  if (d.runtime) chips.push(`${d.runtime} min`);
  if (on) chips.push('Watched');
  (d.genres || []).slice(0, 3).forEach(g => chips.push(g.name));

  body.innerHTML = sheetHeader(d.title || name, d.backdrop_path, d.poster_path, chips) +
    `<p class="overview">${esc(d.overview || '')}</p>
     <div class="sheet-actions">
       <button class="btn ${on ? '' : 'gold'} act-toggle">${on ? 'Unmark' : 'Mark watched'}</button>
       <button class="btn act-lib">${inLib ? 'Remove' : 'Add to library'}</button>
     </div></div>`;

  const inner = body.querySelector('.sheet-body');
  body.querySelector('.act-toggle').onclick = async (e) => {
    e.target.disabled = true;
    await setMovie(id, !on, { name });
    toast(on ? 'Unmarked' : 'Logged');
    openMovie(id, name);
    if (view !== 'search') render();
  };
  body.querySelector('.act-lib').onclick = async () => {
    if (inLib) db.movies = db.movies.filter(m => String(m.id) !== String(id));
    else db.movies.push({ id, name: d.title || name, watched: false, poster_path: d.poster_path || '',
      release_date: d.release_date || '', runtime: d.runtime || 120, dropped: false });
    await savePayload();
    toast(inLib ? 'Removed' : 'Added to library');
    openMovie(id, name);
  };

  const log = findLog('movie', id);
  if (on && log) journalEditor(inner, log);
}

/* ---------------- boot ---------------- */

async function start() {
  $('#setup').hidden = true;
  $('#app').hidden = false;
  $('#view').innerHTML = '<div class="spinner">Loading your library…</div>';
  await loadPayload();
  await loadHistory();
  render();
}

function boot() {
  cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
  if (!cfg) { $('#setup').hidden = false; return; }
  start().catch(err => {
    $('#view').innerHTML = '';
    $('#view').appendChild(emptyState("Couldn't reach your data", String(err.message || err),
      { label: 'Check keys', onClick: () => { localStorage.removeItem(CFG_KEY); location.reload(); } }));
  });
}

$('#cfg-save').onclick = async () => {
  const next = { url: $('#cfg-url').value.trim(), key: $('#cfg-key').value.trim(), tmdb: $('#cfg-tmdb').value.trim() };
  const err = $('#cfg-error');
  if (!next.url || !next.key || !next.tmdb) { err.textContent = 'All three fields are needed.'; err.hidden = false; return; }
  cfg = next;
  try {
    await sb('tv_time_data?id=eq.1&select=id');   // prove the keys work before saving them
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    start();
  } catch (e) {
    cfg = null;
    err.textContent = 'Those keys did not work: ' + (e.message || e);
    err.hidden = false;
  }
};

document.querySelectorAll('#tabbar button').forEach(b => {
  b.onclick = () => { view = b.dataset.view; render(); };
});
$('#btn-refresh').onclick = async () => {
  Object.keys(localStorage).filter(k => k.startsWith('tmdb:')).forEach(k => localStorage.removeItem(k));
  await loadPayload(); await loadHistory(); render(); toast('Refreshed');
};
$('#sheet-close').onclick = closeSheet;
$('#sheet-backdrop').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot();
