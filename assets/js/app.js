function renderProgram(src) {
  if (!src) return '';
  const e = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmt = s => e(s)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\d{1,2}:\d{2}(?:\s*[AP]M)?(?:\s*[-\u2013\u2014]\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?/gi,
      m => `<span class="time-nowrap">${m.trim().replace(/\s*([-\u2013\u2014])\s*/g, '\u00a0$1<br class="time-mobile-break">\u00a0')}</span>`);
  // No table syntax → render as pre-formatted plain text
  if (!/^\s*\|/m.test(src)) {
return '<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:inherit;margin:0">' + e(src) + '</pre>';
  }
  // Contains Markdown tables
  const lines = src.split('\n');
  let out = '', i = 0;
  while (i < lines.length) {
if (lines[i].trim().startsWith('|')) {
  const rows = [];
  while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
  out += '<table>';
  let inHead = true;
  for (const row of rows) {
    if (/^\s*\|[\s\-:|]+\|/.test(row)) { inHead = false; continue; }
    const cells = row.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    if (inHead) {
      out += '<thead><tr>' + cells.map(c=>`<th>${fmt(c)}</th>`).join('') + '</tr></thead>';
      inHead = false;
    } else {
      out += '<tr>' + cells.map(c=>`<td>${fmt(c)}</td>`).join('') + '</tr>';
    }
  }
  out += '</table>';
} else {
  const t = lines[i].trim();
  if (t) out += `<p>${fmt(t)}</p>`;
  i++;
}
  }
  return out;
}

// ─── renderProgramFiltered ─────────────────────────────────────────────────────
// Like renderProgram but skips table rows whose session type is in hiddenTypes.
function renderProgramFiltered(src, hiddenTypes) {
  if (!src || !hiddenTypes.size) return renderProgram(src);
  if (!/^\s*\|/m.test(src)) return renderProgram(src); // plain text – nothing to filter
  const e = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmt = s => e(s)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\d{1,2}:\d{2}(?:\s*[AP]M)?(?:\s*[-\u2013\u2014]\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?/gi,
      m => `<span class="time-nowrap">${m.trim().replace(/\s*([-\u2013\u2014])\s*/g, '\u00a0$1<br class="time-mobile-break">\u00a0')}</span>`);
  const lines = src.split('\n');
  let out = '', i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      out += '<table>';
      let inHead = true;
      for (const row of rows) {
        if (/^\s*\|[\s\-:|]+\|/.test(row)) { inHead = false; continue; }
        const cells = row.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
        if (inHead) {
          out += '<thead><tr>' + cells.map(c=>`<th>${fmt(c)}</th>`).join('') + '</tr></thead>';
          inHead = false;
        } else {
          const [timeCell, titleCell='', sessionCell=''] = cells;
          if (parseTimeStr(timeCell)) {
            const typeClass = sessionTypeClass(sessionCell, titleCell);
            if (hiddenTypes.has(typeClass)) continue;
          }
          out += '<tr>' + cells.map(c=>`<td>${fmt(c)}</td>`).join('') + '</tr>';
        }
      }
      out += '</table>';
    } else {
      const t = lines[i].trim();
      if (t) out += `<p>${fmt(t)}</p>`;
      i++;
    }
  }
  return out;
}

// ─── State ────────────────────────────────────────────────────────────────────
let allEvents     = [];
let saved         = new Set();
let view          = 'list';
let browseView   = 'grid';
let calDay       = 0;
let tlDay        = 0;
let tlHiddenTypes = new Set();
let swipeIdx     = 0;
let swipeList    = [];
let swipeHistory = [];
let roomCoords    = {};
let _modalEventId = null;
let _modalList    = [];
let _modalHiddenTypes = new Set();
let tlDayAutoInit = false;
let STORE           = 'workshopradar_saved';
let TL_FILTER_STORE = 'workshopradar_tl_filter';
let TAB_STORE       = 'workshopradar_tab';
let VIEW_STORE      = 'workshopradar_view';
let SETTINGS_STORE  = 'workshopradar_settings';
let LIVE_SCOPE_STORE = 'workshopradar_live_scope';
let conferenceConfig = null;
let conferenceData = null;
let livePreviewTime = null;
let liveScope = 'saved';
const isArchive = Boolean(window.WORKSHOP_RADAR_ARCHIVE);
const requestedConference = window.WORKSHOP_RADAR_CONFERENCE || null;

function configureConference(conf) {
  conferenceConfig = conf;
  const prefix = `workshopradar_${conf.id}`;
  STORE = `${prefix}_saved`;
  TL_FILTER_STORE = `${prefix}_tl_filter`;
  TAB_STORE = `${prefix}_tab`;
  VIEW_STORE = `${prefix}_view`;
  SETTINGS_STORE = `${prefix}_settings`;
  LIVE_SCOPE_STORE = `${prefix}_live_scope`;
  document.body.dataset.conference = conf.id;
  document.body.dataset.conferenceTheme = conf.theme || 'default';
  document.body.classList.toggle('conference-upcoming', conf.status === 'upcoming');
  document.body.classList.toggle('archive-mode', isArchive);
  document.title = isArchive ? `${conf.name} Archive — Workshop Radar` : `Workshop Radar — ${conf.name}`;
  const brand = document.getElementById('brand-name');
  const subtitle = document.getElementById('conference-subtitle');
  const pill = document.getElementById('pill-conference');
  if (brand) brand.textContent = isArchive ? `${conf.name} Archive` : 'Workshop Radar';
  if (subtitle) subtitle.textContent = isArchive
    ? `${conf.venue || ''} · ${conf.dates_label || ''}`.replace(/^\s*·\s*|\s*·\s*$/g, '')
    : `${conf.short_name || conf.name} · ${conf.venue || ''} · ${conf.dates_label || ''}`.replace(/\s·\s·/g, ' · ');
  if (pill) pill.textContent = isArchive ? 'Past conference' : (conf.short_name || conf.name);
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadSaved()  { try { saved = new Set(JSON.parse(localStorage.getItem(STORE) || '[]')); } catch { saved = new Set(); } }
function storeSaved() { localStorage.setItem(STORE, JSON.stringify([...saved])); }
function loadTlFilter()  { try { tlHiddenTypes = new Set(JSON.parse(localStorage.getItem(TL_FILTER_STORE) || '[]')); } catch { tlHiddenTypes = new Set(); } }
function storeTlFilter() { localStorage.setItem(TL_FILTER_STORE, JSON.stringify([...tlHiddenTypes])); }
function storeTab(t)  { localStorage.setItem(TAB_STORE, t); }
function storeView(v) { localStorage.setItem(VIEW_STORE, v); }
function loadLiveScope() { const stored = localStorage.getItem(LIVE_SCOPE_STORE); liveScope = stored === 'all' ? 'all' : 'saved'; }
function storeLiveScope() { localStorage.setItem(LIVE_SCOPE_STORE, liveScope); }

// ─── Current-time red line updater ────────────────────────────────────────────
function updateNowLine() {
  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const inRange = nowMin > TL_START && nowMin < TL_END;
  const pct    = inRange ? ((nowMin - TL_START) / TL_SPAN * 100).toFixed(3) + '%' : null;
  document.querySelectorAll('.tl-now-line').forEach(el => {
    if (pct) { el.style.left = pct; el.style.display = ''; }
    else { el.style.display = 'none'; }
  });

  if (document.getElementById('tab-live')?.classList.contains('active')) renderLive();
}

// ─── Normalise time slot ───────────────────────────────────────────────────────
function slot(raw) {
  if (!raw) return '';
  const s = raw.toLowerCase();
  if (s.startsWith('full')) return 'Full Day';
  if (s === 'am')            return 'AM';
  if (s === 'pm')            return 'PM';
  return raw;
}

function eventDays(events = allEvents) {
  return [...new Set(events.map(e => e.date).filter(Boolean))]
    .sort((a, b) => dateSortValue(a) - dateSortValue(b));
}

function dateSortValue(value) {
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  const bits = String(value || '').split('/').map(Number);
  return bits.length === 3 ? new Date(bits[2], bits[0] - 1, bits[1]).getTime() : 0;
}

function dateStr(value, long = false) {
  if (!value) return '';
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = iso ? new Date(`${value}T12:00:00`) : (() => {
    const [m, d, y] = String(value).split('/').map(Number);
    return new Date(y, m - 1, d, 12);
  })();
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    weekday: long ? 'long' : 'short', month: 'short', day: 'numeric',
    ...(long ? { year: 'numeric' } : {}),
  }).format(parsed);
}

function showUpcoming(conf) {
  const browse = document.getElementById('tab-browse');
  const liveTab = document.querySelector('.tab-btn[data-tab="live"]');
  const scheduleTab = document.querySelector('.tab-btn[data-tab="schedule"]');
  const filter = document.querySelector('.filter-bar');
  const results = document.querySelector('.results-info');
  const report = document.querySelector('.btn-report');
  if (liveTab) liveTab.hidden = true;
  if (scheduleTab) scheduleTab.style.display = 'none';
  if (filter) filter.style.display = 'none';
  if (results) results.style.display = 'none';
  if (report) report.style.display = 'none';
  document.getElementById('pill-workshops').style.display = 'none';
  document.getElementById('pill-tutorials').style.display = 'none';
  browse.innerHTML = `
    <section class="upcoming-panel" aria-labelledby="upcoming-title">
      <div class="upcoming-signal" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="upcoming-kicker">${esc(conf.short_name || conf.name)} · ${esc(conf.dates_label || 'Coming soon')}</p>
      <h2 id="upcoming-title">Stay tuned.</h2>
      <p>${esc(conf.message || 'Workshop and tutorial details will appear here once they are ready to explore. We’re preparing a single, practical view of the programme.')}</p>
    </section>`;
}

// ─── Load JSON ────────────────────────────────────────────────────────────────
async function init(bustCache = false) {
  const cacheOpts = bustCache ? { cache: 'no-store' } : { cache: 'no-cache' };
  const registryRes = await fetch(`conferences.json${bustCache ? `?t=${Date.now()}` : ''}`, cacheOpts);
  if (!registryRes.ok) throw new Error('Could not load conference registry');
  const registry = await registryRes.json();
  const selectedId = requestedConference || registry.active_conference;
  const conf = (registry.conferences || []).find(c => c.id === selectedId);
  if (!conf) throw new Error(`Unknown conference: ${selectedId}`);
  configureConference(conf);
  loadSaved();
  loadTlFilter();
  loadLiveScope();
  loadSettings();
  updateBadge();
  checkURLImport();
  if (conf.status === 'upcoming' && !isArchive) {
    showUpcoming(conf);
    return;
  }
  if (!conf.data_file) throw new Error(`No event data is available for ${conf.name}`);
  const url = bustCache ? `${conf.data_file}?t=${Date.now()}` : conf.data_file;
  const [res, coordsRes] = await Promise.all([
    fetch(url, cacheOpts),
    conf.room_coords_file ? fetch(conf.room_coords_file).catch(() => null) : Promise.resolve(null),
  ]);
  if (!res.ok) throw new Error('Could not load conference data');
  const data = await res.json();
  conferenceData = data;
  if (coordsRes && coordsRes.ok) {
try { roomCoords = await coordsRes.json(); } catch { /* ignore */ }
  }

  const ws = (data.workshops || []).map((e, i) => ({ ...e, id: `w${i}`, type: e.type || 'Workshop', _slot: slot(e.time_slot) }));
  const ts = (data.tutorials  || []).map((e, i) => ({ ...e, id: `t${i}`, type: e.type || 'Tutorial', _slot: slot(e.time_slot) }));
  allEvents = [...ws, ...ts];

  document.getElementById('pill-workshops').textContent = `${ws.length} workshops`;
  document.getElementById('pill-tutorials').textContent  = `${ts.length} tutorials`;

  // Populate track dropdown
  const tracks = [...new Set(allEvents.map(e => e.track).filter(Boolean))].sort();
  const dateSelect = document.getElementById('f-date');
  if (dateSelect) {
    dateSelect.innerHTML = '<option value="">All dates</option>';
    eventDays().forEach(d => {
      const option = document.createElement('option');
      option.value = d;
      option.textContent = dateStr(d);
      dateSelect.appendChild(option);
    });
  }
  const sel = document.getElementById('f-track');
  const trackGroup = sel.closest('.filter-group');
  sel.innerHTML = '<option value="">All tracks</option>';
  tracks.forEach(t => {
const o = document.createElement('option');
o.value = t;
o.textContent = t.replace(/^Track on\s*/i, '');
sel.appendChild(o);
  });
  // Some conferences do not publish tracks. Keep this filter available for
  // those that do, but do not spend interface space on an empty control.
  const hasTracks = tracks.length > 0;
  trackGroup.hidden = !hasTracks;
  sel.disabled = !hasTracks;
  if (!hasTracks) sel.value = '';

  renderBrowse();
  updateLiveAvailability();
  if (document.getElementById('tab-live').classList.contains('active')) renderLive();
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function getFiltered() {
  const search = foldSearchText(document.getElementById('f-search').value);
  const fDate    = document.getElementById('f-date').value;
  const fTime    = document.getElementById('f-time').value;
  const fType    = document.getElementById('f-type').value;
  const fTrack   = document.getElementById('f-track').value;
  const fProgram = document.getElementById('f-program').value;

  return allEvents.filter(e => {
if (fDate    && e.date   !== fDate)  return false;
if (fTime    && e._slot  !== fTime)  return false;
if (fType    && e.type   !== fType)  return false;
if (fTrack   && e.track  !== fTrack) return false;
if (fProgram === 'yes' && !e.program_found) return false;
if (fProgram === 'no'  &&  e.program_found) return false;
if (search) {
  const hay = foldSearchText(`${e.title} ${e.organizers||''} ${e.summary||''} ${e.program_text||''}`);
  if (!hay.includes(search)) return false;
}
return true;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const crop = (s, n) => s && s.length > n ? s.slice(0, n).trimEnd() + '…' : (s||'');
const foldSearchText = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

function slotBadge(s) {
  if (s === 'AM')       return '<span class="badge badge-am">🌅 Morning</span>';
  if (s === 'PM')       return '<span class="badge badge-pm">🌇 Afternoon</span>';
  if (s === 'Full Day') return '<span class="badge badge-fd">☀️ Full Day</span>';
  return '';
}

// ─── Render card ──────────────────────────────────────────────────────────────
function card(ev) {
  const isSaved  = saved.has(ev.id);
  const typeCls  = ev.type === 'Tutorial' ? 'badge-tutorial' : 'badge-workshop';
  const trackTxt = ev.track ? ev.track.replace(/^Track on\s*/i,'') : null;

  return `
<div class="event-card${isSaved?' saved':''}" data-id="${esc(ev.id)}">
  <div class="card-header">
<div class="card-header-left">
  <div class="badges-row">
    <span class="badge ${typeCls}">${esc(ev.type)}</span>
    ${slotBadge(ev._slot)}
  </div>
  <div class="card-title">${esc(ev.title)}</div>
</div>
<button class="save-icon-btn${isSaved?' saved':''}" data-id="${esc(ev.id)}" title="${isSaved?'Remove from schedule':'Add to schedule'}">${isSaved?'★':'☆'}</button>
  </div>

  <div class="card-meta">
<span class="meta-item">📅 ${esc(dateStr(ev.date))}</span>
<span class="meta-item"><button class="room-pill-btn${roomCoords[ev.location]?'':' no-map'}" data-room="${esc(ev.location)}" title="${roomCoords[ev.location]?'View on map':''}">📍 ${esc(ev.location)}</button></span>
  </div>

  ${trackTxt ? `<div class="track-tag">🏷 ${esc(trackTxt)}</div>` : ''}
  ${ev.organizers ? `<div class="organizers">${esc(crop(ev.organizers,130))}</div>` : ''}
  ${ev.summary    ? `<div class="card-summary">${esc(crop(ev.summary,240))}</div>` : ''}

  <div class="card-footer">
${ev.website
  ? `<a class="card-link" href="${esc(ev.website)}" target="_blank" rel="noopener">🔗 Website ↗</a>`
  : '<span></span>'}
<div style="display:flex;gap:6px;align-items:center;">
  <button class="btn btn-ghost details-btn" data-id="${esc(ev.id)}" style="font-size:.77rem;padding:5px 12px;">📋 Details</button>
  <button class="btn ${isSaved?'btn-saved':'btn-primary'} save-action-btn" data-id="${esc(ev.id)}" style="font-size:.77rem;padding:5px 13px;">
    ${isSaved?'✓ Saved':'+ Save'}
  </button>
</div>
  </div>
</div>`;
}

// ─── Browse Tab ────────────────────────────────────────────────────────────────
function renderBrowse() {
  const filtered = getFiltered();
  document.getElementById('results-count').innerHTML =
`Showing <strong>${filtered.length}</strong> of <strong>${allEvents.length}</strong> events`;

  // Update active-filter badge on mobile toggle button
  const activeCount = ['f-search','f-date','f-time','f-type','f-track','f-program']
    .filter(id => document.getElementById(id).value).length;
  const badge = document.getElementById('filter-active-badge');
  if (badge) {
    badge.textContent = activeCount > 0 ? activeCount : '';
    badge.style.display = activeCount > 0 ? '' : 'none';
  }

  if (browseView === 'swipe') {
const newIds = filtered.map(e => e.id).join(',');
const oldIds = swipeList.map(e => e.id).join(',');
if (newIds !== oldIds) { swipeList = [...filtered].sort((a,b) => (saved.has(a.id)?1:0) - (saved.has(b.id)?1:0)); swipeIdx = 0; swipeHistory = []; }
renderSwipeDeck();
return;
  }

  const grid = document.getElementById('events-grid');
  if (!filtered.length) {
grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🔍</div><h3>No events found</h3><p>Try adjusting your filters or search query.</p></div>`;
return;
  }
  grid.innerHTML = filtered.map(card).join('');
}

// ─── Swipe Mode ───────────────────────────────────────────────────────────────
function setBrowseView(v) {
  browseView = v;
  document.querySelectorAll('.browse-view-btn').forEach(b => b.classList.toggle('active', b.dataset.bview === v));
  document.getElementById('events-grid').style.display     = v === 'grid'  ? '' : 'none';
  document.getElementById('swipe-container').style.display = v === 'swipe' ? '' : 'none';
  if (v === 'swipe') { swipeList = [...getFiltered()].sort((a,b) => (saved.has(a.id)?1:0) - (saved.has(b.id)?1:0)); swipeIdx = 0; swipeHistory = []; renderSwipeDeck(); }
}

function renderSwipeDeck() {
  const deck    = document.getElementById('swipe-deck');
  const prog    = document.getElementById('swipe-progress');
  const undoBtn = document.getElementById('swipe-btn-undo');
  if (!deck) return;
  if (prog)    prog.textContent = swipeIdx < swipeList.length
? `${swipeIdx + 1} / ${swipeList.length}`
: `All done · ${swipeList.length} reviewed`;
  if (undoBtn) undoBtn.disabled = swipeHistory.length === 0;

  deck.innerHTML = '';
  if (swipeIdx >= swipeList.length) {
deck.innerHTML = `<div class="swipe-done-card">
  <div class="done-icon">🎉</div>
  <h3>All done!</h3>
  <p style="font-size:.85rem;">You reviewed all <strong>${swipeList.length}</strong> events.</p>
  <button class="btn btn-ghost" id="swipe-restart-btn" style="margin-top:8px;font-size:.82rem;">↺ Start over</button>
</div>`;
document.getElementById('swipe-restart-btn')
  .addEventListener('click', () => { swipeIdx = 0; swipeHistory = []; renderSwipeDeck(); });
updateSwipeSaveBtn();
return;
  }

  if (swipeIdx + 1 < swipeList.length) {
const backEl = buildSwipeCard(swipeList[swipeIdx + 1]);
backEl.classList.add('swipe-card-back');
deck.appendChild(backEl);
  }
  const frontEl = buildSwipeCard(swipeList[swipeIdx]);
  frontEl.classList.add('swipe-card-front');
  if (saved.has(swipeList[swipeIdx].id)) frontEl.classList.add('saved-glow');
  deck.appendChild(frontEl);
  attachSwipeHandlers(frontEl, swipeList[swipeIdx].id);
  updateSwipeSaveBtn();
}

function buildSwipeCard(ev) {
  const el = document.createElement('div');
  el.className  = 'swipe-card';
  el.dataset.id = ev.id;
  const typeCls  = ev.type === 'Tutorial' ? 'badge-tutorial' : 'badge-workshop';
  const trackTxt = ev.track ? ev.track.replace(/^Track on\s*/i,'') : null;
  const isInSchedule = saved.has(ev.id);
  el.innerHTML = `
<div class="swipe-color-overlay"></div>
<div class="badges-row">
  <span class="badge ${typeCls}">${esc(ev.type)}</span>
  ${slotBadge(ev._slot)}
  ${isInSchedule ? '<span class="swipe-saved-indicator">★ In your schedule</span>' : ''}
</div>
<div class="swipe-card-title">${esc(ev.title)}</div>
<div class="swipe-card-body">
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;font-size:.8rem;">
    <span>📅 ${esc(dateStr(ev.date))}</span>
    <span><button class="room-pill-btn${roomCoords[ev.location||'']?'':' no-map'}" data-room="${esc(ev.location||'')}" title="${roomCoords[ev.location||'']?'View on map':''}">📍 ${esc(ev.location||'—')}</button></span>
  </div>
  ${trackTxt ? `<div class="track-tag" style="margin-bottom:6px;font-size:.76rem;">${esc(trackTxt)}</div>` : ''}
  ${ev.organizers ? `<div style="font-style:italic;font-size:.79rem;margin-bottom:6px;">${esc(crop(ev.organizers,110))}</div>` : ''}
  ${ev.summary    ? `<div style="font-size:.82rem;line-height:1.55;">${esc(crop(ev.summary,220))}</div>` : ''}
</div>
<div class="swipe-card-foot">
  ${ev.program_found
    ? `<span style="color:#16a34a;font-weight:600;">✓ Program available</span>`
    : `<span>No program yet</span>`}
</div>`;
  return el;
}

function updateSwipeSaveBtn() {
  const btn = document.getElementById('swipe-btn-save');
  if (!btn) return;
  const isSaved = swipeIdx < swipeList.length && saved.has(swipeList[swipeIdx].id);
  btn.classList.toggle('saved', isSaved);
  btn.title = isSaved ? 'Already saved' : 'Save to schedule';
}

function doSwipe(direction) {
  if (swipeIdx >= swipeList.length) return;
  const ev = swipeList[swipeIdx];
  swipeHistory.push({ id: ev.id, wasSaved: saved.has(ev.id) });
  if (direction === 'right' && !saved.has(ev.id)) {
saved.add(ev.id); storeSaved(); updateBadge();
toast('Added to schedule ★', 't-saved');
  }
  const frontEl = document.querySelector('.swipe-card-front');
  if (frontEl) {
frontEl.style.transition = 'transform .30s ease, opacity .30s ease';
frontEl.style.transform  = direction === 'right' ? 'translateX(150%) rotate(10deg)' : 'translateX(-150%) rotate(-10deg)';
frontEl.style.opacity    = '0';
  }
  const backEl = document.querySelector('.swipe-card-back');
  if (backEl) { backEl.style.transition = 'transform .28s ease'; backEl.style.transform = 'scale(1) translateY(0)'; }
  swipeIdx++;
  setTimeout(renderSwipeDeck, 300);
}

function undoSwipe() {
  if (!swipeHistory.length) return;
  const { id, wasSaved } = swipeHistory.pop();
  if (!wasSaved && saved.has(id)) { saved.delete(id); storeSaved(); updateBadge(); }
  swipeIdx = Math.max(0, swipeIdx - 1);
  renderSwipeDeck();
}

function attachSwipeHandlers(el, id) {
  let startX = 0, startY = 0, curX = 0, curY = 0, active = false, moved = false;

  el.addEventListener('pointerdown', e => {
if (e.target.closest('button,a')) return;
startX = e.clientX; startY = e.clientY;
active = true; moved = false; curX = 0; curY = 0;
el.style.transition = 'none';
el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', e => {
if (!active) return;
curX = e.clientX - startX;
curY = e.clientY - startY;
if (Math.abs(curX) > 4 || Math.abs(curY) > 4) moved = true;
if (!moved) return;
el.style.transform = `translateX(${curX}px) translateY(${curY * 0.2}px) rotate(${curX * 0.06}deg)`;
const overlay = el.querySelector('.swipe-color-overlay');
if (overlay) {
  const t = Math.abs(curX) > 20 ? Math.min(1, (Math.abs(curX) - 20) / 80) : 0;
  overlay.style.background = curX > 0
    ? `rgba(22,163,74,${(t * 0.45).toFixed(2)})`
    : `rgba(220,38,38,${(t * 0.45).toFixed(2)})`;
}
  });

  const onEnd = () => {
if (!active) return; active = false;
if (!moved) return;
if      (curX >  80) doSwipe('right');
else if (curX < -80) doSwipe('left');
else {
  el.style.transition = 'transform .25s ease';
  el.style.transform  = '';
  const overlay = el.querySelector('.swipe-color-overlay');
  if (overlay) overlay.style.background = 'transparent';
}
  };

  el.addEventListener('pointerup',     onEnd);
  el.addEventListener('pointercancel', onEnd);
  el.addEventListener('click', e => {
if (!moved && !e.target.closest('button,a')) openModal(id);
moved = false;
  });
}

// ─── Schedule Badge ────────────────────────────────────────────────────────────
function updateBadge() {
  const n = saved.size;
  document.getElementById('sched-badge').textContent = n;
  document.getElementById('sched-title').textContent  = `My Schedule (${n})`;
  document.getElementById('btn-clear-all').style.display = n > 0 ? '' : 'none';
}

// ─── Schedule – List ───────────────────────────────────────────────────────────
function renderList(events) {
  const el = document.getElementById('sched-list');
  el.style.display = '';
  document.getElementById('sched-calendar').style.display = 'none';
  document.getElementById('sched-timeline').style.display = 'none';

  if (!events.length) {
el.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><h3>Your schedule is empty</h3><p>Browse events and click <strong>+ Save</strong> to add them here.</p></div>`;
return;
  }

  const byDate = {};
  events.forEach(e => { (byDate[e.date] ||= []).push(e); });
  const slotOrder = { AM:0, 'Full Day':1, PM:2 };

  el.innerHTML = Object.keys(byDate).sort().map(d => {
const evts = byDate[d].slice().sort((a,b) => (slotOrder[a._slot]??3)-(slotOrder[b._slot]??3));
return `
<div class="schedule-day">
  <div class="day-header">
<span class="day-label">📅 ${esc(dateStr(d, true))}</span>
<span class="day-count">${evts.length} event${evts.length!==1?'s':''}</span>
  </div>
  <div class="list-grid">${evts.map(card).join('')}</div>
</div>`;
  }).join('');
}

// ─── Schedule – Calendar ──────────────────────────────────────────────────────
function renderCalendar(events) {
  const el = document.getElementById('sched-calendar');
  el.style.display = '';
  document.getElementById('sched-list').style.display    = 'none';
  document.getElementById('sched-timeline').style.display = 'none';

  if (!events.length) {
el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗓</div><h3>Your schedule is empty</h3><p>Browse events and click <strong>+ Save</strong> to add them here.</p></div>`;
return;
  }

  const DAYS = eventDays();

  // Clamp calDay to valid range
  if (calDay >= DAYS.length) calDay = 0;
  const day = DAYS[calDay];

  const dayEvents = events.filter(e => e.date === day);
  const bySlot = { 'Full Day': [], AM: [], PM: [] };
  dayEvents.forEach(e => { if (bySlot[e._slot]) bySlot[e._slot].push(e); });

  const typeOrder = { Workshop: 0, Tutorial: 1 };
  const sortByTitle = (a, b) =>
    (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9) ||
    a.title.localeCompare(b.title);

  bySlot['Full Day'].sort(sortByTitle);
  bySlot.AM.sort(sortByTitle);
  bySlot.PM.sort(sortByTitle);

  const workshopCount = dayEvents.filter(e => e.type === 'Workshop').length;
  const tutorialCount = dayEvents.filter(e => e.type === 'Tutorial').length;
  const conflictSlots = ['AM', 'PM'].filter(s => bySlot[s].length > 1).length;

  function agendaItem(e, idx, slotLabel) {
    const track = e.track ? e.track.replace(/^Track on\s*/i, '') : '';
    const hasMap = !!roomCoords[e.location];
    const typeCls = e.type === 'Tutorial' ? 'badge-tutorial' : 'badge-workshop';
    return `
<article class="cal-item${e.type === 'Tutorial' ? ' tutorial-item' : ''}" data-id="${esc(e.id)}">
  <button class="unsave-cal-btn" data-id="${esc(e.id)}" title="Remove from schedule">✕</button>
  <div class="cal-item-top">
    <span class="cal-item-index">${idx}</span>
    <span class="badge ${typeCls}">${esc(e.type)}</span>
    <span class="cal-item-slot">${esc(slotLabel)}</span>
  </div>
  <div class="cal-item-title">${esc(e.title)}</div>
  <div class="cal-item-meta">
    <button class="room-pill room-pill-btn${hasMap ? '' : ' no-map'}" data-room="${esc(e.location || '')}" title="${hasMap ? 'View on map' : ''}">📍 ${esc(e.location || 'TBA')}</button>
    ${track ? `<span class="cal-item-track" title="${esc(track)}">${esc(track)}</span>` : ''}
    <button class="btn btn-ghost details-btn cal-details-btn" data-id="${esc(e.id)}">Details</button>
  </div>
</article>`;
  }

  function lane(slotKey, title, subtitle) {
    const items = bySlot[slotKey] || [];
    const danger = (slotKey === 'AM' || slotKey === 'PM') && items.length > 1;
    return `
<section class="cal-lane">
  <div class="cal-lane-head">
    <div>
      <h3>${title}</h3>
      <p>${subtitle}</p>
    </div>
    <span class="cal-lane-count${danger ? ' warn' : ''}">${items.length}</span>
  </div>
  ${items.length
    ? `<div class="cal-lane-list">${items.map((e, i) => agendaItem(e, i + 1, slotKey)).join('')}</div>`
    : '<div class="cal-lane-empty">No saved events</div>'}
</section>`;
  }

  // Day switcher
  let html = '<div class="cal-day-nav">';
  DAYS.forEach((d, i) => {
html += `<button class="cal-day-btn${calDay === i ? ' active' : ''}" data-calday="${i}">${esc(dateStr(d))}</button>`;
  });
  html += '</div>';

  html += `
<div class="cal-overview">
  <span class="cal-overview-pill"><strong>${dayEvents.length}</strong> total</span>
  <span class="cal-overview-pill"><strong>${workshopCount}</strong> workshops</span>
  <span class="cal-overview-pill"><strong>${tutorialCount}</strong> tutorials</span>
  <span class="cal-overview-pill${conflictSlots ? ' warn' : ''}"><strong>${conflictSlots}</strong> busy slots</span>
</div>
<div class="calendar-wrap">
  <div class="cal-lanes-grid">
    ${lane('Full Day', 'Full Day', 'All-day commitments')}
    ${lane('AM', 'Morning', '08:00 - 12:00')}
    ${lane('PM', 'Afternoon', '13:00 - 17:00')}
  </div>
</div>`;

  el.innerHTML = html;
}

// ─── Schedule dispatcher ──────────────────────────────────────────────────────
// ─── Timeline – Helpers ───────────────────────────────────────────────────────
const TL_START = 8  * 60;   // 480  min (8:00 AM)
const TL_END   = 19 * 60;   // 1140 min (7:00 PM)
const TL_SPAN  = TL_END - TL_START; // 660 min
const PROGRAM_FILTER_TYPES = [
  { type: 'keynote',      label: 'Keynote / Invited' },
  { type: 'oral',         label: 'Oral / Paper' },
  { type: 'poster',       label: 'Poster' },
  { type: 'break',        label: 'Break' },
  { type: 'housekeeping', label: 'Opening / Closing' },
  { type: 'default',      label: 'Other' },
  { type: 'none',         label: 'No Program' },
];
const PROGRAM_TYPE_LABELS = {
  keynote: 'Keynote / Invited', oral: 'Oral / Paper', poster: 'Poster',
  break: 'Break', housekeeping: 'Opening / Closing', default: 'Session', none: 'No Program',
};

function conferenceNow() {
  if (livePreviewTime) return { ...livePreviewTime, preview: true };
  const now = new Date();
  const timeZone = conferenceConfig?.timezone;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const value = type => parts.find(part => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    const hour = +value('hour');
    const minute = +value('minute');
    return {
      date: `${year}-${month}-${day}`,
      minutes: hour * 60 + minute,
      label: new Intl.DateTimeFormat('en-GB', {
        timeZone, weekday: 'short', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(now),
    };
  } catch {
    return {
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      minutes: now.getHours() * 60 + now.getMinutes(),
      label: now.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    };
  }
}

function isoDateKey(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value;
  const [month, day, year] = String(value || '').split('/').map(Number);
  if (!year || !month || !day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatProgrammeTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseTimeStr(raw) {
  if (!raw) return null;
  raw = raw.trim();
  if (!raw || /^[-\u2013\u2014\s]+$/.test(raw)) return null;
  // Extract all time tokens: H:MM or HH:MM optionally followed by AM/PM
  const re = /(\d{1,2}):(\d{2})\s*(AM|PM)?/gi;
  const tokens = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    tokens.push({ h: +m[1], min: +m[2], ampm: m[3] ? m[3].toUpperCase() : null });
  }
  if (!tokens.length) return null;
  function toMin(t) {
    let h = t.h;
    if (t.ampm === 'PM' && h !== 12) h += 12;
    if (t.ampm === 'AM' && h === 12) h = 0;
    return h * 60 + t.min;
  }
  return { startMin: toMin(tokens[0]), endMin: tokens.length > 1 ? toMin(tokens[1]) : null };
}

function parseProgramRows(programText, fallbackSlot) {
  const fallback = () => {
    const ranges = { 'AM': [TL_START, 12*60], 'PM': [13*60, 18*60], 'Full Day': [TL_START, 18*60] };
    const [s, e] = ranges[fallbackSlot] || [TL_START, TL_END];
    return [{ startMin: s, endMin: e, title: 'Program not available', session: '', speaker: '-', noProgram: true }];
  };
  if (!programText) return fallback();

  const raw = [];
  for (const line of programText.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s\-:|]+\|/.test(t)) continue;          // separator row
    if (/^\|\s*Time\s*\|/i.test(t)) continue;        // header row
    const cells = t.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells.length < 2) continue;
    const [timeCell, titleCell, sessionCell = '', speakerCell = ''] = cells;
    const times = parseTimeStr(timeCell);
    if (!times) continue;
    raw.push({ ...times, title: titleCell, session: sessionCell, speaker: speakerCell });
  }
  if (!raw.length) return fallback();

  // Fill missing end times from next row's start (last row gets +30 min)
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].endMin === null) {
      // Skip ahead past rows with the same start so they all share the same end time.
      // Without this, row[i].endMin == row[i].startMin (zero-width, filtered out).
      let j = i + 1;
      while (j < raw.length && raw[j].startMin === raw[i].startMin) j++;
      raw[i].endMin = j < raw.length ? raw[j].startMin : raw[i].startMin + 30;
    }
  }

  // Skip span-all entries (≥180 min — these mark the overall session window)
  return raw
    .filter(r => (r.endMin - r.startMin) < 180)
    .map(r => ({ ...r, startMin: Math.max(r.startMin, TL_START), endMin: Math.min(r.endMin, TL_END) }))
    .filter(r => r.startMin < r.endMin);
}

function sessionTypeClass(session, title) {
  const t = (session + ' ' + title).toLowerCase();
  if (/break|lunch|coffee|poster setup/.test(t))     return 'break';
  if (/keynote|invited/.test(t))                      return 'keynote';
  if (/oral|paper presentation|contributed/.test(t)) return 'oral';
  if (/poster/.test(t))                               return 'poster';
  if (/opening|closing|welcome|introduction/.test(t)) return 'housekeeping';
  return 'default';
}

function liveProgrammeBlocks(date, events = allEvents) {
  const blocks = [];
  events
    .filter(ev => ev.program_found && isoDateKey(ev.date) === date)
    .forEach(ev => {
      const grouped = new Map();
      parseProgramRows(ev.program_text, ev._slot)
        .filter(row => !row.noProgram)
        .forEach(row => {
          const type = sessionTypeClass(row.session, row.title);
          const key = `${row.startMin}|${row.endMin}|${type}`;
          const existing = grouped.get(key);
          if (existing) {
            existing.count += 1;
            return;
          }
          grouped.set(key, { ...row, ev, type, count: 1 });
        });

      grouped.forEach(block => {
        if (block.count > 1) {
          block.title = PROGRAM_TYPE_LABELS[block.type] || block.session || block.title;
          block.speaker = '';
        }
        blocks.push(block);
      });
    });
  return blocks.sort((a, b) => a.startMin - b.startMin || a.ev.title.localeCompare(b.ev.title));
}

function isConferenceDay(date) {
  return allEvents.some(event => isoDateKey(event.date) === date);
}

function hasLiveSavedProgramme(now = conferenceNow()) {
  return liveProgrammeBlocks(now.date, allEvents.filter(event => saved.has(event.id)))
    .some(block => block.startMin <= now.minutes && now.minutes < block.endMin);
}

function updateLiveAvailability() {
  const liveTab = document.querySelector('.tab-btn[data-tab="live"]');
  if (!liveTab) return;
  const now = conferenceNow();
  const isAvailable = Boolean(livePreviewTime) || isConferenceDay(now.date);
  const hasPersonalLiveItem = isAvailable && hasLiveSavedProgramme(now);
  liveTab.hidden = !isAvailable;
  liveTab.querySelector('.live-tab-dot').hidden = !hasPersonalLiveItem;

  // Do not leave the user on a tab that is unavailable outside the conference window.
  if (!isAvailable && liveTab.classList.contains('active')) {
    document.querySelector('.tab-btn[data-tab="browse"]')?.click();
  }
  return { isAvailable, hasPersonalLiveItem };
}

function liveFilterMarkup() {
  return `<div class="tl-filter-bar live-filter-bar"><span class="tl-filter-label">Show:</span>${PROGRAM_FILTER_TYPES
    .filter(({ type }) => type !== 'none')
    .map(({ type, label }) => `<button class="tl-filter-btn tl-filter-btn--${type}${tlHiddenTypes.has(type) ? ' tl-off' : ''}" data-tltype="${type}">${esc(label)}</button>`)
    .join('')}</div>`;
}

function liveCard(block, state, nowMinutes) {
  const { ev, type, startMin, endMin, title, speaker } = block;
  const minutesUntil = startMin - nowMinutes;
  const stateLabel = state === 'now' ? 'Live now' : `Starts in ${minutesUntil} min`;
  const speakerText = speaker && speaker.trim() !== '-' ? speaker.trim() : '';
  const savedLabel = saved.has(ev.id) ? '★ In my schedule' : '+ Save workshop';
  const timeLabel = `${formatProgrammeTime(startMin)}–${formatProgrammeTime(endMin)}`;
  return `<article class="live-card live-card--${state} tl-block--${type}">
    <button class="live-block" data-evid="${esc(ev.id)}" data-start="${startMin}" data-end="${endMin}"
      data-title="${esc(title)}" data-speaker="${esc(speakerText)}" data-session="${esc(block.session)}"
      data-time="${timeLabel}" data-type="${type}" aria-label="${esc(`${title}, ${timeLabel}. Open programme details`)}">
      <span class="live-card-top"><span class="live-state">${esc(stateLabel)}</span><span class="live-time">${timeLabel}</span></span>
      <span class="live-title">${esc(title)}</span>
      ${speakerText ? `<span class="live-speaker">👤 ${esc(speakerText)}</span>` : ''}
      <span class="live-event">${esc(ev.title)}</span>
      <span class="live-meta">📍 ${esc(ev.location || 'TBA')} · ${esc(PROGRAM_TYPE_LABELS[type] || 'Session')}</span>
    </button>
    <button class="live-save-btn${saved.has(ev.id) ? ' saved' : ''}" data-id="${esc(ev.id)}">${savedLabel}</button>
  </article>`;
}

function liveLane(title, subtitle, blocks, state, nowMinutes) {
  return `<section class="live-lane live-lane--${state}">
    <div class="live-lane-head"><div><p>${esc(subtitle)}</p><h2>${esc(title)}</h2></div><span>${blocks.length}</span></div>
    ${blocks.length ? `<div class="live-card-list">${blocks.map(block => liveCard(block, state, nowMinutes)).join('')}</div>` : '<p class="live-lane-empty">Nothing in this window.</p>'}
  </section>`;
}

function renderLive() {
  const el = document.getElementById('tab-live');
  if (!el) return;
  const now = conferenceNow();
  const sourceEvents = liveScope === 'saved' ? allEvents.filter(ev => saved.has(ev.id)) : allEvents;
  const hasPersonalLiveItem = hasLiveSavedProgramme(now);
  const visible = liveProgrammeBlocks(now.date, sourceEvents).filter(block => !tlHiddenTypes.has(block.type));
  const current = visible.filter(block => block.startMin <= now.minutes && now.minutes < block.endMin);
  const next30 = visible.filter(block => {
    const delta = block.startMin - now.minutes;
    return delta > 0 && delta <= 30;
  });
  const next60 = visible.filter(block => {
    const delta = block.startMin - now.minutes;
    return delta > 30 && delta <= 60;
  });
  const total = current.length + next30.length + next60.length;
  const place = now.preview
    ? 'Preview time — console controlled'
    : (conferenceConfig?.venue ? `${conferenceConfig.venue} · local time` : 'Conference time');
  const scopeEmptyMessage = liveScope === 'saved'
    ? 'Save events in Browse or switch to All programme to see every live session.'
    : `Come back during ${conferenceConfig?.short_name || 'the conference'} to see sessions as they begin.`;

  el.innerHTML = `<section class="live-header">
    <div><p class="live-eyebrow">${hasPersonalLiveItem ? '<span class="live-status-dot" aria-hidden="true"></span>' : ''}Programme radar</p><h1>Live now</h1><p>Sessions happening now and beginning over the next hour.</p></div>
    <div class="live-clock"><span>${esc(now.label)}</span><small>${esc(place)}</small></div>
  </section>
  <div class="live-controls">
    <div class="live-scope-toggle" role="group" aria-label="Live programme source">
      <span>Show</span>
      <button class="live-scope-btn${liveScope === 'saved' ? ' active' : ''}" data-live-scope="saved">★ My schedule</button>
      <button class="live-scope-btn${liveScope === 'all' ? ' active' : ''}" data-live-scope="all">All programme</button>
    </div>
    ${liveFilterMarkup()}
  </div>
  ${total ? `<div class="live-layout">
    ${liveLane('Happening now', 'On stage', current, 'now', now.minutes)}
    <div class="live-upcoming-grid">
      ${liveLane('Next 30 minutes', 'Starting soon', next30, 'soon', now.minutes)}
      ${liveLane('31–60 minutes', 'On deck', next60, 'later', now.minutes)}
    </div>
  </div>` : `<div class="empty-state live-empty"><div class="empty-icon">◌</div><h3>No programme blocks are live right now</h3><p>${esc(scopeEmptyMessage)}</p></div>`}`;
}

// TEMP: browser-console controls for validating the Live tab. Remove before release.
function setLivePreview(date, time = '') {
  const raw = `${date || ''}${time ? ` ${time}` : ''}`.trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s]+(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('Use YYYY-MM-DD HH:MM, for example: 2026-09-08 09:15');
  const [, day, hourRaw, minuteRaw] = match;
  const hour = +hourRaw;
  const minute = +minuteRaw;
  const parsed = new Date(`${day}T12:00:00Z`);
  if (hour > 23 || minute > 59 || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error('Enter a valid conference-local date and time.');
  }
  const dayLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  }).format(parsed);
  livePreviewTime = {
    date: day,
    minutes: hour * 60 + minute,
    label: `Preview · ${dayLabel}, ${formatProgrammeTime(hour * 60 + minute)}`,
  };
  updateLiveAvailability();
  renderLive();
  return livePreviewTime;
}

function openLiveTab() {
  const liveButton = document.querySelector('.tab-btn[data-tab="live"]');
  if (!liveButton) return;
  if (liveButton.classList.contains('active')) renderLive();
  else liveButton.click();
}

window.WorkshopRadarDebug = {
  previewLive(date, time) {
    const preview = setLivePreview(date, time);
    openLiveTab();
    return preview;
  },
  useRealTime() {
    livePreviewTime = null;
    updateLiveAvailability();
    if (document.getElementById('tab-live').classList.contains('active')) renderLive();
    return 'Live tab returned to conference-local real time.';
  },
  openLive: openLiveTab,
  liveStatus() {
    const now = conferenceNow();
    return {
      conferenceTime: now,
      previewActive: Boolean(livePreviewTime),
      conferenceDay: isConferenceDay(now.date),
      savedItemLiveNow: hasLiveSavedProgramme(now),
      tabVisible: !document.querySelector('.tab-btn[data-tab="live"]')?.hidden,
    };
  },
  help() {
    console.info("WorkshopRadarDebug.previewLive('2026-09-08', '09:15')\nWorkshopRadarDebug.useRealTime()\nWorkshopRadarDebug.openLive()\nWorkshopRadarDebug.liveStatus()");
  },
};

function showTlTooltip(e, block) {
  const tooltip = document.getElementById('tl-tooltip');
  const title   = block.dataset.title   || '';
  const speaker = block.dataset.speaker || '';
  const session = block.dataset.session || '';
  const time    = block.dataset.time    || '';
  const type    = block.dataset.type    || 'default';
  const evid    = block.dataset.evid    || '';
  const start   = block.dataset.start   || '';
  const end     = block.dataset.end     || '';
  const labels  = { keynote:'Keynote / Invited', oral:'Oral / Paper',
    poster:'Poster', break:'Break', housekeeping:'Opening / Closing', default:'Session', none:'No Program' };
  const showCalBtn = type !== 'none' && evid && start && end;
  tooltip.innerHTML = `
    <div class="tl-tooltip-type tl-tooltip-type--${esc(type)}">${labels[type] || esc(type)}</div>
    <div class="tl-tooltip-time">${esc(time)}</div>
    <div class="tl-tooltip-title">${esc(title)}</div>
    ${speaker ? `<div class="tl-tooltip-speaker">👤 ${esc(speaker)}</div>` : ''}
    ${showCalBtn ? `<button class="tl-tooltip-cal-btn"
      data-evid="${esc(evid)}" data-start="${esc(start)}" data-end="${esc(end)}"
      data-title="${esc(title)}" data-speaker="${esc(speaker)}">📅 Add to calendar</button>` : ''}`;
  tooltip.style.display = 'block';
  // Position near cursor, keep within viewport
  requestAnimationFrame(() => {
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    const vw = window.innerWidth,   vh = window.innerHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + tw > vw - 8) x = e.clientX - tw - 14;
    if (y + th > vh - 8) y = e.clientY - th - 14;
    tooltip.style.left = x + 'px';
    tooltip.style.top  = y + 'px';
  });
}

function hideTlTooltip() {
  const el = document.getElementById('tl-tooltip');
  if (el) el.style.display = 'none';
}

// ─── iCalendar (.ics) helpers ─────────────────────────────────────────────────
function icsEscape(s) {
  return String(s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
}
function _icsDatePart(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return dateStr.replaceAll('-', '');
  const [m, d, y] = String(dateStr || '').split('/');
  return `${y}${String(m).padStart(2,'0')}${String(d).padStart(2,'0')}`;
}
function _icsTimePart(totalMin) {
  const h = Math.floor(totalMin / 60).toString().padStart(2,'0');
  const m = (totalMin % 60).toString().padStart(2,'0');
  return `${h}${m}00`;
}
function _makeVevent({ uid, stamp, dateStr, startMin, endMin, summary, location, description }) {
  const d  = _icsDatePart(dateStr);
  const ds = `${d}T${_icsTimePart(startMin)}`;
  const de = `${d}T${_icsTimePart(endMin)}`;
  return [
    'BEGIN:VEVENT\r\n',
    `UID:${uid}\r\n`,
    `DTSTAMP:${stamp}\r\n`,
    `DTSTART;TZID=${conferenceConfig?.timezone || 'UTC'}:${ds}\r\n`,
    `DTEND;TZID=${conferenceConfig?.timezone || 'UTC'}:${de}\r\n`,
    `SUMMARY:${icsEscape(summary)}\r\n`,
    location    ? `LOCATION:${icsEscape(location)}\r\n`    : '',
    description ? `DESCRIPTION:${icsEscape(description)}\r\n` : '',
    'BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\n',
    'END:VEVENT\r\n',
  ].join('');
}
function _buildIcs(vevents) {
  const product = conferenceConfig?.name || 'Workshop Radar';
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Workshop Radar//${icsEscape(product)}//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n`
    + vevents.join('') + 'END:VCALENDAR';
}
function _downloadIcs(filename, content) {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Build calendar event summary: "Speaker – Topic" (topic omitted if too long or absent)
function _icsEventName(title, speaker) {
  const spk = speaker && speaker.trim() !== '-' ? speaker.trim() : '';
  const ttl = title  && title.trim()             ? title.trim()   : '';
  if (spk && ttl && ttl.length <= 80) return `${spk} \u2013 ${ttl}`;
  if (spk) return spk;
  return ttl || `${conferenceConfig?.name || 'Workshop Radar'} Session`;
}

// Add a single program block to calendar (called from tooltip button)
function addBlockToCalendar(evId, startMin, endMin, title, speaker) {
  const ev = allEvents.find(e => e.id === evId);
  if (!ev) return;
  const stamp = new Date().toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
  const desc  = [
    `Workshop: ${ev.title}`,
    speaker && speaker.trim() !== '-' ? `Speaker: ${speaker.trim()}` : null,
    ev.location ? `Room: ${ev.location}` : null,
  ].filter(Boolean).join('\n');
  const ics = _buildIcs([_makeVevent({
    uid: `${conferenceConfig?.id || 'workshopradar'}-${evId}-${startMin}-${endMin}@workshopradar`,
    stamp, dateStr: ev.date, startMin: +startMin, endMin: +endMin,
    summary: _icsEventName(title, speaker),
    location: ev.location || '',
    description: desc,
  })]);
  _downloadIcs(`${conferenceConfig?.id || 'workshopradar'}_${_icsEventName(title, speaker).replace(/[^a-z0-9]/gi,'_').slice(0,40)}.ics`, ics);
  hideTlTooltip();
}

// Add all visible program rows for a workshop to calendar
function addWorkshopToCalendar(evId) {
  const ev = allEvents.find(e => e.id === evId);
  if (!ev) return;
  const rows = parseProgramRows(ev.program_text, ev._slot)
    .filter(r => !r.noProgram && !tlHiddenTypes.has(sessionTypeClass(r.session, r.title)));
  if (!rows.length) { alert('No visible program items to add to calendar.'); return; }
  if (!confirm(`Add ${rows.length} program item${rows.length !== 1 ? 's' : ''} from\n"${ev.title}"\nto your calendar?\n\nEach event will include a 15-minute reminder.`)) return;
  const stamp = new Date().toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
  const vevents = rows.map((r, i) => _makeVevent({
    uid: `${conferenceConfig?.id || 'workshopradar'}-${evId}-${r.startMin}-${r.endMin}-${i}@workshopradar`,
    stamp, dateStr: ev.date, startMin: r.startMin, endMin: r.endMin,
    summary: _icsEventName(r.title, r.speaker),
    location: ev.location || '',
    description: [
      `Workshop: ${ev.title}`,
      r.speaker && r.speaker.trim() !== '-' ? `Speaker: ${r.speaker.trim()}` : null,
      ev.location ? `Room: ${ev.location}` : null,
    ].filter(Boolean).join('\n'),
  }));
  const ics = _buildIcs(vevents);
  _downloadIcs(`${conferenceConfig?.id || 'workshopradar'}_${ev.title.replace(/[^a-z0-9]/gi,'_').slice(0,40)}.ics`, ics);
}

// ─── Schedule – Timeline ──────────────────────────────────────────────────────
function renderTimeline(events) {
  const el = document.getElementById('sched-timeline');
  el.style.display = '';
  document.getElementById('sched-list').style.display     = 'none';
  document.getElementById('sched-calendar').style.display = 'none';
  hideTlTooltip();

  if (!events.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📺</div><h3>Your schedule is empty</h3><p>Browse events and click <strong>+ Save</strong> to add them here.</p></div>`;
    return;
  }

  const DAYS = eventDays();

  // Auto-select today's day on first render if it's a conference day
  if (!tlDayAutoInit) {
    tlDayAutoInit = true;
    const n = new Date();
    const todayStr = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const todayIdx = DAYS.findIndex(d => dateSortValue(d) === dateSortValue(todayStr));
    if (todayIdx >= 0) tlDay = todayIdx;
  }

  if (tlDay >= DAYS.length) tlDay = 0;

  // Day switcher (reuse cal-day-btn styles)
  let html = '<div class="cal-day-nav">';
  DAYS.forEach((d, i) => {
    html += `<button class="tl-day-btn cal-day-btn${tlDay === i ? ' active' : ''}" data-tlday="${i}">${esc(dateStr(d))}</button>`;
  });
  html += '</div>';

  const dayEvents = events.filter(e => e.date === DAYS[tlDay]);
  const slotOrder = { AM: 0, 'Full Day': 1, PM: 2 };
  dayEvents.sort((a, b) => {
    const aNoP = a.program_found ? 0 : 1;
    const bNoP = b.program_found ? 0 : 1;
    if (aNoP !== bNoP) return aNoP - bNoP;
    return (slotOrder[a._slot] ?? 3) - (slotOrder[b._slot] ?? 3);
  });

  if (!dayEvents.length) {
    html += `<div class="empty-state" style="margin-top:24px"><div class="empty-icon">📅</div><h3>No saved events on this day</h3></div>`;
    el.innerHTML = html;
    return;
  }

  // Filter bar
  html += '<div class="tl-filter-bar"><span class="tl-filter-label">Show:</span>';
  PROGRAM_FILTER_TYPES.forEach(({ type, label }) => {
    const off = tlHiddenTypes.has(type) ? ' tl-off' : '';
    html += `<button class="tl-filter-btn tl-filter-btn--${type}${off}" data-tltype="${type}">${esc(label)}</button>`;
  });
  html += '</div>';

  // Current time now-line
  const _now = new Date();
  const _nowMin = _now.getHours() * 60 + _now.getMinutes();
  const _nowInRange = _nowMin > TL_START && _nowMin < TL_END;
  const _nowPct = _nowInRange ? ((_nowMin - TL_START) / TL_SPAN * 100).toFixed(3) : null;
  const nowLine = _nowPct ? `<div class="tl-now-line" style="left:${_nowPct}%"></div>` : '';

  // Build time-header labels (8:00 → 19:00, every 30 min)
  const NUM_SLOTS = 22;
  const timeLabels = Array.from({ length: NUM_SLOTS + 1 }, (_, i) => {
    const totalMin = TL_START + i * 30;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const pct = (i * 30 / TL_SPAN * 100).toFixed(3);
    const major = m === 0 ? ' tl-major' : '';
    return `<div class="tl-time-mark${major}" style="left:${pct}%">${h}:${m === 0 ? '00' : m}</div>`;
  }).join('');

  html += `<div class="timeline-wrap">
  <div class="timeline-inner">
    <div class="tl-header-row">
      <div class="tl-label-cell tl-label-cell--head"></div>
      <div class="tl-time-strip">${timeLabels}${nowLine}</div>
    </div>`;

  for (const ev of dayEvents) {
    const rows   = parseProgramRows(ev.program_text, ev._slot);
    const hasMap = !!roomCoords[ev.location];

    // Collapse rows that share the same exact time span into one block per session type.
    // Some workshops list every individual paper at the same time window (e.g. a 3-hour
    // poster session with 20 entries all at 14:00–17:00) — they'd all stack invisibly.
    // In that case we emit a single block per type using the type label as the title.
    const slotMap = new Map();
    for (const r of rows) {
      const key = `${r.startMin}|${r.endMin}`;
      if (!slotMap.has(key)) slotMap.set(key, []);
      slotMap.get(key).push(r);
    }
    const collapsedRows = [];
    for (const group of slotMap.values()) {
      if (group.length <= 1) { collapsedRows.push(...group); continue; }
      const seen = new Set();
      for (const r of group) {
        const tc = r.noProgram ? 'none' : sessionTypeClass(r.session, r.title);
        if (seen.has(tc)) continue;
        seen.add(tc);
        collapsedRows.push({ ...r, title: PROGRAM_TYPE_LABELS[tc] || r.session || r.title, speaker: '' });
      }
    }

    const blocks = collapsedRows.map(r => {
      const typeClass = r.noProgram ? 'none' : sessionTypeClass(r.session, r.title);
      if (tlHiddenTypes.has(typeClass)) return null;
      const leftPct  = ((r.startMin - TL_START) / TL_SPAN * 100).toFixed(3);
      const widthPct = Math.max((r.endMin - r.startMin) / TL_SPAN * 100, 0.4).toFixed(3);
      const speakerTxt = (r.speaker && r.speaker.trim() !== '-') ? r.speaker.trim() : '';
      const fmtMin = n => { const h = Math.floor(n/60), m = n%60; return `${h}:${m===0?'00':m}`; };
      const timeLabel = `${fmtMin(r.startMin)}\u2013${fmtMin(r.endMin)}`;
      return `<div class="tl-block tl-block--${typeClass}"
        style="left:${leftPct}%;width:${widthPct}%"
        data-evid="${esc(ev.id)}"
        data-start="${r.startMin}"
        data-end="${r.endMin}"
        data-title="${esc(r.title)}"
        data-speaker="${esc(speakerTxt)}"
        data-session="${esc(r.session)}"
        data-time="${esc(timeLabel)}"
        data-type="${typeClass}">
        ${speakerTxt ? `<span class="tl-block-speaker">${esc(speakerTxt)}</span>` : ''}
        <span class="tl-block-title">${esc(r.title)}</span>
      </div>`;
    }).filter(Boolean).join('');

    const noProgCls = ev.program_found ? '' : ' tl-row--no-prog';
    html += `
    <div class="tl-row${noProgCls}" data-id="${esc(ev.id)}">
      <div class="tl-label-cell">
        <div class="tl-event-name"><span class="tl-event-name-inner">${esc(ev.title)}\u2003\u2003\u2022\u2003\u2003${esc(ev.title)}\u2003\u2003\u2022\u2003\u2003</span></div>
        <div class="tl-event-meta">
          <button class="tl-room-pill room-pill-btn${hasMap ? '' : ' no-map'}" data-room="${esc(ev.location || '')}" title="${hasMap ? 'View on map' : ''}">📍 ${esc(ev.location || 'TBA')}</button>
          <button class="btn btn-ghost details-btn" data-id="${esc(ev.id)}" style="font-size:.67rem;padding:2px 8px;">Details</button>
          ${ev.program_found ? `<button class="tl-row-cal-btn" data-evid="${esc(ev.id)}" title="Add all schedule items to calendar">📅</button>` : ''}
        </div>
      </div>
      <div class="tl-track">${blocks}${nowLine}</div>
    </div>`;
  }

  html += `\n  </div>\n</div>`;
  el.innerHTML = html;
}

// ─── Schedule dispatcher ──────────────────────────────────────────────────────
function renderSchedule() {
  updateBadge();
  const events = allEvents.filter(e => saved.has(e.id));
  if (view === 'list')           renderList(events);
  else if (view === 'calendar')  renderCalendar(events);
  else if (view === 'timeline')  renderTimeline(events);
}

// ─── Toggle save ──────────────────────────────────────────────────────────────
function toggleSave(id) {
  if (saved.has(id)) {
saved.delete(id);
toast('Removed from schedule', 't-removed');
  } else {
saved.add(id);
toast('Added to schedule ★', 't-saved');
  }
  storeSaved();
  renderBrowse();
  updateLiveAvailability();
  if (document.getElementById('tab-schedule').classList.contains('active')) renderSchedule();
  else updateBadge();
  if (document.getElementById('tab-live').classList.contains('active')) renderLive();
  if (_modalEventId === id) _updateModalSaveBtn(id);
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, cls) {
  const box = document.getElementById('toast-box');
  const t   = document.createElement('div');
  t.className = `toast ${cls}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ─── Event delegation ─────────────────────────────────────────────────────────
document.body.addEventListener('click', e => {
  // Tab switching
  const tab = e.target.closest('.tab-btn');
  if (tab) {
document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
tab.classList.add('active');
document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
storeTab(tab.dataset.tab);
if (tab.dataset.tab === 'schedule') renderSchedule();
if (tab.dataset.tab === 'live') renderLive();
if (tab.dataset.tab === 'settings') { applySettings(); resetSharePanels(); }
return;
  }

  // Live source toggle: saved schedule by default, full programme on demand.
  const liveScopeBtn = e.target.closest('.live-scope-btn');
  if (liveScopeBtn) {
    liveScope = liveScopeBtn.dataset.liveScope === 'all' ? 'all' : 'saved';
    storeLiveScope();
    renderLive();
    return;
  }

  // Save buttons (icon or footer button in cards)
  const saveBtn = e.target.closest('.save-icon-btn, .save-action-btn, .live-save-btn');
  if (saveBtn) { toggleSave(saveBtn.dataset.id); return; }

  // Unsave from calendar
  const unsaveBtn = e.target.closest('.unsave-cal-btn');
  if (unsaveBtn) { e.stopPropagation(); toggleSave(unsaveBtn.dataset.id); return; }

  // Open details by clicking a calendar item
  const calItem = e.target.closest('.cal-item');
  if (calItem && !e.target.closest('button,a')) { openModal(calItem.dataset.id); return; }

  // Timeline day switcher (before cal-day-btn — uses data-tlday attribute)
  const tlDayBtn = e.target.closest('.tl-day-btn');
  if (tlDayBtn) { tlDay = +tlDayBtn.dataset.tlday; renderSchedule(); return; }

  // Calendar day switcher
  const cdBtn = e.target.closest('.cal-day-btn:not(.tl-day-btn)');
  if (cdBtn) { calDay = +cdBtn.dataset.calday; renderSchedule(); return; }

  // Timeline type filter toggle
  const tlFilterBtn = e.target.closest('.tl-filter-btn:not(.modal-filter-btn)');
  if (tlFilterBtn) {
    const type = tlFilterBtn.dataset.tltype;
    if (tlHiddenTypes.has(type)) tlHiddenTypes.delete(type); else tlHiddenTypes.add(type);
    storeTlFilter();
    if (document.getElementById('tab-live').classList.contains('active')) renderLive();
    else renderSchedule();
    return;
  }

  // Timeline block click → show tooltip
  const tlBlock = e.target.closest('.tl-block');
  if (tlBlock) { showTlTooltip(e, tlBlock); return; }

  // Live programme block click → show the same details / calendar tooltip as the timeline.
  const liveBlock = e.target.closest('.live-block');
  if (liveBlock) { showTlTooltip(e, liveBlock); return; }

  // Tooltip "Add to calendar" button (single program block)
  const tlTipCalBtn = e.target.closest('.tl-tooltip-cal-btn');
  if (tlTipCalBtn) {
    const { evid, start, end, title, speaker } = tlTipCalBtn.dataset;
    addBlockToCalendar(evid, +start, +end, title, speaker);
    return;
  }

  // Workshop row "Add all to calendar" button
  const tlRowCalBtn = e.target.closest('.tl-row-cal-btn');
  if (tlRowCalBtn) { addWorkshopToCalendar(tlRowCalBtn.dataset.evid); return; }

  // Modal program filter toggle
  const modalFilterBtn = e.target.closest('.modal-filter-btn');
  if (modalFilterBtn) {
    const type = modalFilterBtn.dataset.tltype;
    if (_modalHiddenTypes.has(type)) _modalHiddenTypes.delete(type); else _modalHiddenTypes.add(type);
    modalFilterBtn.classList.toggle('tl-off');
    const _mev = allEvents.find(ev => ev.id === _modalEventId);
    if (_mev && _mev.program_found && _mev.program_text) {
      document.getElementById('modal-program-text').innerHTML = renderProgramFiltered(_mev.program_text, _modalHiddenTypes);
    }
    return;
  }

  // Dismiss timeline tooltip on outside click
  hideTlTooltip();

  // Timeline row click on mobile → open modal (details-btn is hidden on mobile)
  const tlRow = e.target.closest('.tl-row');
  if (tlRow && tlRow.dataset.id && e.target.closest('.tl-label-cell') && !e.target.closest('button,a') && window.innerWidth <= 600) {
    openModal(tlRow.dataset.id);
    return;
  }

  // Browse view toggle (must come before generic .view-btn handler)
  const bviewBtn = e.target.closest('.browse-view-btn');
  if (bviewBtn) { setBrowseView(bviewBtn.dataset.bview); return; }

  // Swipe action buttons
  if (e.target.closest('#swipe-btn-skip')) { doSwipe('left');  return; }
  if (e.target.closest('#swipe-btn-undo')) { undoSwipe();      return; }
  if (e.target.closest('#swipe-btn-save')) { if (swipeIdx < swipeList.length) doSwipe('right'); return; }
  if (e.target.closest('#swipe-btn-info')) {
if (swipeIdx < swipeList.length) openModal(swipeList[swipeIdx].id);
return;
  }

  // View toggle (schedule tab)
  const vBtn = e.target.closest('.view-btn:not(.browse-view-btn)');
  if (vBtn) {
document.querySelectorAll('.view-btn:not(.browse-view-btn)').forEach(b => b.classList.remove('active'));
vBtn.classList.add('active');
view = vBtn.dataset.view;
storeView(view);
renderSchedule();
return;
  }

  // Clear all saved
  if (e.target.closest('#btn-clear-all')) {
if (confirm('Remove all events from your schedule?')) {
  saved.clear(); storeSaved(); renderBrowse(); renderSchedule();
}
return;
  }

  // Clear filters
  if (e.target.closest('#btn-clear-filters')) {
['f-search','f-date','f-time','f-type','f-track','f-program'].forEach(id => {
  const el = document.getElementById(id);
  el.value = '';
});
renderBrowse();
return;
  }

  // Room pill → open floor map
  const roomBtn = e.target.closest('.room-pill-btn');
  if (roomBtn && !roomBtn.classList.contains('no-map')) { openMapModal(roomBtn.dataset.room); return; }

  // Map modal close button / backdrop
  if (e.target.closest('#map-modal-close')) { closeMapModal(); return; }
  if (e.target === document.getElementById('map-modal')) { closeMapModal(); return; }

  // Details button → open modal
  const detailsBtn = e.target.closest('.details-btn');
  if (detailsBtn) { openModal(detailsBtn.dataset.id); return; }

  // Click on event card body (not a button/link) → open modal
  const eventCard = e.target.closest('.event-card');
  if (eventCard && !e.target.closest('button,a')) { openModal(eventCard.dataset.id); return; }

  // Modal nav arrows
  const navBtn = e.target.closest('#modal-prev, #modal-next');
  if (navBtn) {
const delta = navBtn.id === 'modal-prev' ? -1 : 1;
const next  = _modalList[_modalList.indexOf(_modalEventId) + delta];
if (next !== undefined) openModal(next);
return;
  }

  // Modal close button
  if (e.target.closest('#modal-close')) { closeModal(); return; }

  // Click on backdrop (not container) to close
  if (e.target === document.getElementById('event-modal')) { closeModal(); return; }

  // Modal save/unsave button
  if (e.target.closest('#modal-save-btn') && _modalEventId) {
toggleSave(_modalEventId);
return;
  }
});

// Filter inputs → re-render
['f-search','f-date','f-time','f-type','f-track','f-program'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderBrowse)
);

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(id) {
  const ev = allEvents.find(e => e.id === id);
  if (!ev) return;
  _modalEventId = id;

  // Dense schedules stay readable on phone-sized screens. Users can still
  // switch back to the normal table with the control in the program header.
  const programWrap = document.getElementById('modal-program-wrap');
  const compactProgramBtn = document.getElementById('program-compact-btn');
  const useCompactProgram = window.matchMedia('(max-width: 480px)').matches;
  programWrap.classList.toggle('compact', useCompactProgram);
  compactProgramBtn.textContent = useCompactProgram ? '⊞ Normal' : '⊟ Compact';

  const modal     = document.getElementById('event-modal');
  const container = document.getElementById('modal-container');
  modal.classList.remove('closing');
  container.classList.remove('closing');

  // Header
  const typeCls = ev.type === 'Tutorial' ? 'badge-tutorial' : 'badge-workshop';
  document.getElementById('modal-badges').innerHTML =
`<span class="badge ${typeCls}">${esc(ev.type)}</span>${slotBadge(ev._slot)}`;
  document.getElementById('modal-title-text').textContent = ev.title;
  document.getElementById('modal-subtitle').textContent =
ev.date_full ? ev.date_full : dateStr(ev.date);

  // Meta row
  const locText = ev.location || '—';
  const locHtml = ev.location && roomCoords[ev.location]
? `<button class="room-pill-btn" data-room="${esc(ev.location)}" title="View on map">📍 ${esc(locText)}</button>`
: `📍 ${esc(locText)}`;
  const metaItems = [
`<div class="modal-meta-item">📅 ${esc(dateStr(ev.date))}</div>`,
`<div class="modal-meta-item">${locHtml}</div>`,
ev.duration ? `<div class="modal-meta-item">🕐 ${esc(ev.duration)}</div>` : null,
  ].filter(Boolean);
  document.getElementById('modal-meta').innerHTML = metaItems.join('');

  // Track
  const trackWrap = document.getElementById('modal-track-wrap');
  if (ev.track) {
document.getElementById('modal-track').textContent = ev.track.replace(/^Track on\s*/i, '');
trackWrap.style.display = '';
  } else {
trackWrap.style.display = 'none';
  }

  // Organizers
  const orgWrap = document.getElementById('modal-organizers-wrap');
  if (ev.organizers) {
document.getElementById('modal-organizers').textContent = ev.organizers;
orgWrap.style.display = '';
  } else {
orgWrap.style.display = 'none';
  }

  // Summary
  const sumWrap = document.getElementById('modal-summary-wrap');
  if (ev.summary) {
document.getElementById('modal-summary').textContent = ev.summary;
sumWrap.style.display = '';
  } else {
sumWrap.style.display = 'none';
  }

  // Program
  const progText    = document.getElementById('modal-program-text');
  const progUnavail = document.getElementById('modal-program-unavailable');
  const progSource  = document.getElementById('modal-program-source');
  const filterBar   = document.getElementById('modal-filter-bar');
  const MODAL_FILTER_TYPES = [
    { type: 'keynote',      label: 'Keynote / Invited' },
    { type: 'oral',         label: 'Oral / Paper' },
    { type: 'poster',       label: 'Poster' },
    { type: 'break',        label: 'Break' },
    { type: 'housekeeping', label: 'Opening / Closing' },
    { type: 'default',      label: 'Other' },
  ];
  if (ev.program_found && ev.program_text) {
    // Determine which session types are present in this program
    const _pRows = parseProgramRows(ev.program_text, ev._slot);
    const _presentTypes = new Set(_pRows.filter(r => !r.noProgram).map(r => sessionTypeClass(r.session, r.title)));
    const _filterTypes = MODAL_FILTER_TYPES.filter(f => _presentTypes.has(f.type));
    if (_filterTypes.length > 1) {
      filterBar.innerHTML = '<span class="tl-filter-label">Show:</span>' +
        _filterTypes.map(({ type, label }) => {
          const off = _modalHiddenTypes.has(type) ? ' tl-off' : '';
          return `<button class="tl-filter-btn tl-filter-btn--${type} modal-filter-btn${off}" data-tltype="${type}">${esc(label)}</button>`;
        }).join('');
      filterBar.style.display = '';
    } else {
      filterBar.style.display = 'none';
    }
progText.innerHTML     = renderProgramFiltered(ev.program_text, _modalHiddenTypes);
progText.style.display = '';
progUnavail.style.display = 'none';
if (ev.program_url) {
  progSource.innerHTML =
    `🔎 Scraped from <a href="${esc(ev.program_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(ev.program_url)}</a>`;
  progSource.style.display = '';
} else {
  progSource.style.display = 'none';
}
  } else {
    filterBar.style.display = 'none';
progText.style.display   = 'none';
progSource.style.display = 'none';
if (ev.website) {
  progUnavail.innerHTML =
    `Program not yet available — <a href="${esc(ev.website)}" target="_blank" rel="noopener" style="color:var(--accent)">visit the workshop website ↗</a>`;
} else {
  progUnavail.textContent = 'No program or website available yet.';
}
progUnavail.style.display = '';
  }

  // Footer
  const scrapedEl = document.getElementById('modal-footer-scraped');
  if (ev.program_scraped_at) {
const d = new Date(ev.program_scraped_at);
scrapedEl.textContent =
  `Last checked: ${d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`;
  } else {
scrapedEl.textContent = '';
  }

  const websiteBtn = document.getElementById('modal-website-btn');
  if (ev.website) {
websiteBtn.href          = ev.website;
websiteBtn.style.display = '';
  } else {
websiteBtn.style.display = 'none';
  }

  // Build navigation list from the currently active tab
  const _schedActive = document.getElementById('tab-schedule').classList.contains('active');
  _modalList = _schedActive
? allEvents.filter(e => saved.has(e.id)).map(e => e.id)
: getFiltered().map(e => e.id);

  _updateModalSaveBtn(id);
  _updateModalNav();

  modal.style.display     = 'flex';
  document.body.style.overflow = 'hidden';
  document.getElementById('modal-close').focus();
}

function _updateModalNav() {
  const prevBtn   = document.getElementById('modal-prev');
  const nextBtn   = document.getElementById('modal-next');
  const counter   = document.getElementById('modal-nav-counter');
  if (!prevBtn || !nextBtn || !counter) return;
  const idx   = _modalList.indexOf(_modalEventId);
  const total = _modalList.length;
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx < 0 || idx >= total - 1;
  counter.textContent = idx >= 0 ? `${idx + 1} / ${total}` : '';
}

function _updateModalSaveBtn(id) {
  const btn     = document.getElementById('modal-save-btn');
  const isSaved = saved.has(id);
  btn.textContent = isSaved ? '✓ Saved' : '+ Save';
  btn.className   = `btn ${isSaved ? 'btn-saved' : 'btn-primary'}`;
  btn.style.fontSize = '.82rem';
}

function closeModal() {
  const modal     = document.getElementById('event-modal');
  const container = document.getElementById('modal-container');
  modal.classList.add('closing');
  container.classList.add('closing');
  setTimeout(() => {
modal.style.display     = 'none';
modal.classList.remove('closing');
container.classList.remove('closing');
document.body.style.overflow = '';
_modalEventId = null;
  }, 200);
}

// ─── Map Modal ────────────────────────────────────────────────────────────────
function openMapModal(location) {
  const coord = roomCoords[location];
  if (!coord) return;
  const modal = document.getElementById('map-modal');
  const img   = document.getElementById('map-modal-img');
  document.getElementById('map-modal-label').textContent = `Room: ${location}`;
  const mapFile = conferenceConfig?.map_images?.[String(coord.page)];
  if (!mapFile) return;
  const doDrawAndScroll = () => { drawMapHighlight(coord); scrollToHighlight(coord); };
  if (img.dataset.loadedSrc === mapFile) {
modal.style.display = 'flex';
document.body.style.overflow = 'hidden';
if (img.complete && img.naturalWidth) doDrawAndScroll();
else img.addEventListener('load', doDrawAndScroll, { once: true });
  } else {
img.dataset.loadedSrc = mapFile;
img.onload = doDrawAndScroll;
img.src = mapFile;
modal.style.display = 'flex';
document.body.style.overflow = 'hidden';
  }
}

function drawMapHighlight(coord) {
  const img    = document.getElementById('map-modal-img');
  const canvas = document.getElementById('map-modal-canvas');
  const W = img.offsetWidth, H = img.offsetHeight;
  const NW = img.naturalWidth, NH = img.naturalHeight;
  if (!NW || !NH) return;
  canvas.width  = W;
  canvas.height = H;
  const sx = W / NW, sy = H / NH;
  const x = coord.x * sx, y = coord.y * sy;
  const w = coord.w * sx, h = coord.h * sy;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle   = 'rgba(255,80,0,.20)';
  ctx.strokeStyle = 'rgba(255,80,0,.90)';
  ctx.lineWidth   = 3;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 5);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
}

function scrollToHighlight(coord) {
  const body = document.getElementById('map-modal-body');
  const img  = document.getElementById('map-modal-img');
  if (!body || !img.naturalWidth) return;
  const sx = img.offsetWidth  / img.naturalWidth;
  const sy = img.offsetHeight / img.naturalHeight;
  const cx = (coord.x + coord.w / 2) * sx;
  const cy = (coord.y + coord.h / 2) * sy;
  body.scrollLeft = cx - body.offsetWidth  / 2;
  body.scrollTop  = cy - body.offsetHeight / 2;
}

function closeMapModal() {
  document.getElementById('map-modal').style.display = 'none';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => {
  const mapOpen = document.getElementById('map-modal').style.display !== 'none';
  if (mapOpen && e.key === 'Escape') { closeMapModal(); return; }
  const modalOpen = document.getElementById('event-modal').style.display !== 'none';
  if (modalOpen) {
if (e.key === 'Escape') { closeModal(); return; }
if (e.key === 'ArrowLeft')  { const p = _modalList[_modalList.indexOf(_modalEventId) - 1]; if (p !== undefined) openModal(p); return; }
if (e.key === 'ArrowRight') { const n = _modalList[_modalList.indexOf(_modalEventId) + 1]; if (n !== undefined) openModal(n); }
return;
  }
  if (browseView === 'swipe' && document.getElementById('tab-browse').classList.contains('active')) {
if (e.key === 'ArrowRight') doSwipe('right');
if (e.key === 'ArrowLeft')  doSwipe('left');
  }
});

// ─── Bookmark Share ───────────────────────────────────────────────────────────
function encodeBookmarks() {
  return btoa(JSON.stringify([...saved]));
}

function decodeBookmarks(str) {
  try {
    const data = JSON.parse(atob(str));
    if (!Array.isArray(data)) return null;
    return data.filter(id => typeof id === 'string');
  } catch { return null; }
}

function buildShareURL() {
  return location.origin + location.pathname + '#import=' + encodeBookmarks();
}

function openSharePanel() {
  const panel  = document.getElementById('share-export-panel');
  const isOpen = panel.style.display !== 'none';
  if (isOpen) { panel.style.display = 'none'; return; }

  const url = buildShareURL();
  document.getElementById('share-url-input').value = url;
  panel.style.display = 'block';

  const qrWrap = document.getElementById('share-qr');
  qrWrap.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qrWrap, { text: url, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
  }
}

function resetSharePanels() {
  document.getElementById('share-export-panel').style.display = 'none';
}

function showImportConfirm(ids) {
  const modal = document.getElementById('import-confirm-modal');
  const msg   = document.getElementById('import-confirm-msg');
  msg.textContent = `Import ${ids.length} bookmark${ids.length !== 1 ? 's' : ''}? This will replace your current ${saved.size} bookmark${saved.size !== 1 ? 's' : ''}.`;
  document.getElementById('import-confirm-proceed').dataset.pending = JSON.stringify(ids);
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeImportConfirm() {
  document.getElementById('import-confirm-modal').style.display = 'none';
  document.body.style.overflow = '';
}

function executeImport(ids) {
  saved = new Set(ids);
  storeSaved();
  updateBadge();
  renderBrowse();
  renderSchedule();
  toast(`Imported ${ids.length} bookmark${ids.length !== 1 ? 's' : ''} ✓`, 't-saved');
}

function checkURLImport() {
  if (!location.hash.startsWith('#import=')) return;
  const encoded = location.hash.slice('#import='.length);
  history.replaceState(null, '', location.pathname);
  const ids = decodeBookmarks(encoded);
  if (!ids || ids.length === 0) { toast('Invalid or empty share link', ''); return; }
  showImportConfirm(ids);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
let settings = { theme: 'system', showOrganizers: true, showAbout: true };

const _sysDarkMQ = window.matchMedia('(prefers-color-scheme: dark)');

function loadSettings() {
  try {
const stored = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}');
// Migrate legacy darkMode flag
if (typeof stored.darkMode !== 'undefined' && typeof stored.theme === 'undefined') {
  stored.theme = stored.darkMode ? 'dark' : 'light';
  delete stored.darkMode;
}
settings = { ...settings, ...stored };
  } catch { /* use defaults */ }
  applySettings();
}

function saveSettings() {
  localStorage.setItem(SETTINGS_STORE, JSON.stringify(settings));
}

function applySettings() {
  const isDark = settings.theme === 'dark' ||
(settings.theme === 'system' && _sysDarkMQ.matches);
  document.documentElement.classList.toggle('dark-mode', isDark);
  document.documentElement.dataset.theme = settings.theme;

  document.querySelectorAll('.theme-btn').forEach(b =>
b.classList.toggle('active', b.dataset.theme === settings.theme)
  );

  document.body.classList.toggle('hide-organizers', !settings.showOrganizers);
  const orgChk = document.getElementById('settings-show-organizers');
  if (orgChk) orgChk.checked = settings.showOrganizers;

  document.body.classList.toggle('hide-about', !settings.showAbout);
  const aboutChk = document.getElementById('settings-show-about');
  if (aboutChk) aboutChk.checked = settings.showAbout;
}

// Reapply when OS theme changes while in 'system' mode
_sysDarkMQ.addEventListener('change', () => { if (settings.theme === 'system') applySettings(); });

// Filter toggle (mobile)
document.getElementById('filter-toggle-btn').addEventListener('click', () => {
  const row   = document.getElementById('filter-row');
  const arrow = document.querySelector('.filter-toggle-arrow');
  const open  = row.classList.toggle('open');
  if (arrow) arrow.textContent = open ? '▴' : '▾';
});

// Program compact toggle (mobile)
document.getElementById('program-compact-btn').addEventListener('click', function() {
  const wrap    = document.getElementById('modal-program-wrap');
  const compact = wrap.classList.toggle('compact');
  this.textContent = compact ? '⊞ Normal' : '⊟ Compact';
});

document.getElementById('theme-selector').addEventListener('click', e => {
  const btn = e.target.closest('.theme-btn');
  if (!btn) return;
  settings.theme = btn.dataset.theme;
  saveSettings(); applySettings();
});

document.getElementById('settings-show-organizers').addEventListener('change', e => {
  settings.showOrganizers = e.target.checked;
  saveSettings(); applySettings();
});

document.getElementById('settings-show-about').addEventListener('change', e => {
  settings.showAbout = e.target.checked;
  saveSettings(); applySettings();
});

document.getElementById('settings-refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('settings-refresh-btn');
  btn.classList.add('loading');
  btn.disabled = true;
  try {
await init(true);
toast('Data refreshed ✓', 't-saved');
  } catch {
toast('Refresh failed — check the server', '');
  } finally {
btn.classList.remove('loading');
btn.disabled = false;
  }
});

// ─── Share / Import listeners ─────────────────────────────────────────────────
document.getElementById('share-export-btn').addEventListener('click', openSharePanel);

document.getElementById('share-copy-btn').addEventListener('click', () => {
  const url = document.getElementById('share-url-input').value;
  const btn = document.getElementById('share-copy-btn');
  navigator.clipboard.writeText(url).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
  }).catch(() => {
    document.getElementById('share-url-input').select();
    toast('Copy with Cmd/Ctrl+C', '');
  });
});

document.getElementById('import-confirm-proceed').addEventListener('click', () => {
  const pending = document.getElementById('import-confirm-proceed').dataset.pending;
  if (!pending) return;
  closeImportConfirm();
  executeImport(JSON.parse(pending));
});

document.getElementById('import-confirm-cancel').addEventListener('click', closeImportConfirm);
document.getElementById('import-confirm-close').addEventListener('click', closeImportConfirm);
document.getElementById('import-confirm-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('import-confirm-modal')) closeImportConfirm();
});

// ─── Boot ─────────────────────────────────────────────────────────────────
// Compact with hysteresis: shrink after a meaningful downward scroll and only
// expand again near the top. Scroll anchoring is disabled in CSS so a height
// change cannot mutate scrollY and flip this state back and forth.
const _siteHeader = document.querySelector('header');
let _headerIsCompact = false;
let _headerScrollFrame = null;
function updateHeaderCompactState() {
  _headerScrollFrame = null;
  const scrollY = window.scrollY;
  const shouldCompact = _headerIsCompact ? scrollY > 32 : scrollY > 120;
  if (shouldCompact === _headerIsCompact) return;
  _headerIsCompact = shouldCompact;
  _siteHeader.classList.toggle('compact', _headerIsCompact);
}
window.addEventListener('scroll', () => {
  if (_headerScrollFrame === null) {
    _headerScrollFrame = requestAnimationFrame(updateHeaderCompactState);
  }
}, { passive: true });
updateHeaderCompactState();

// Auto-update the current-time red line every minute
setInterval(() => {
  updateLiveAvailability();
  if (view === 'timeline' && document.getElementById('tab-schedule').classList.contains('active')) {
    updateNowLine();
  }
  if (document.getElementById('tab-live').classList.contains('active')) renderLive();
}, 60 * 1000);

// Register service worker — enables offline support and ensures users always
// receive the latest JSON data when you push updates to the repository.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init()
  .then(() => {
    // Restore persisted view (list / calendar / timeline)
    const savedView = localStorage.getItem(VIEW_STORE);
    if (savedView && ['list', 'calendar', 'timeline'].includes(savedView)) {
      view = savedView;
      document.querySelectorAll('.view-btn:not(.browse-view-btn)').forEach(b =>
        b.classList.toggle('active', b.dataset.view === savedView));
    }
    // Restore persisted tab
    const savedTab = localStorage.getItem(TAB_STORE);
    if (savedTab && savedTab !== 'browse') {
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${savedTab}"]`);
      if (tabBtn && !tabBtn.hidden) tabBtn.click();
    }
  })
  .catch(() => {
  document.getElementById('events-grid').innerHTML = `
<div class="empty-state" style="grid-column:1/-1">
  <div class="empty-icon">⚠️</div>
  <h3>Could not load event data</h3>
  <p>Unable to fetch event data. If you're offline, visit once while connected to enable offline access.</p>
</div>`;
  });
