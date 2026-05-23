function renderProgram(src) {
  if (!src) return '';
  const e = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmt = s => e(s)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\d{1,2}:\d{2}(?:\s*[AP]M)?(?:\s*[-\u2013\u2014]\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?/gi,
      m => `<span class="time-nowrap">${m.trim().replace(/\s*([-\u2013\u2014])\s*/g, '\u00a0$1\u00a0')}</span>`);
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

// ─── State ────────────────────────────────────────────────────────────────────
let allEvents     = [];
let saved         = new Set();
let view          = 'list';
let browseView   = 'grid';
let calDay       = 0;
let swipeIdx     = 0;
let swipeList    = [];
let swipeHistory = [];
let roomCoords    = {};
let _modalEventId = null;
let _modalList    = [];
const STORE       = 'cvpr2026_saved';

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadSaved()  { try { saved = new Set(JSON.parse(localStorage.getItem(STORE) || '[]')); } catch { saved = new Set(); } }
function storeSaved() { localStorage.setItem(STORE, JSON.stringify([...saved])); }

// ─── Normalise time slot ───────────────────────────────────────────────────────
function slot(raw) {
  if (!raw) return '';
  const s = raw.toLowerCase();
  if (s.startsWith('full')) return 'Full Day';
  if (s === 'am')            return 'AM';
  if (s === 'pm')            return 'PM';
  return raw;
}

// ─── Load JSON ────────────────────────────────────────────────────────────────
async function init(bustCache = false) {
  const url  = bustCache
? `cvpr2026_workshops_tutorials.json?t=${Date.now()}`
: 'cvpr2026_workshops_tutorials.json';
  const [res, coordsRes] = await Promise.all([
fetch(url, bustCache ? { cache: 'no-store' } : { cache: 'no-cache' }),
fetch('room_coords.json').catch(() => null),
  ]);
  const data = await res.json();
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
  const sel = document.getElementById('f-track');
  tracks.forEach(t => {
const o = document.createElement('option');
o.value = t;
o.textContent = t.replace(/^Track on\s*/i, '');
sel.appendChild(o);
  });

  renderBrowse();
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function getFiltered() {
  const search = document.getElementById('f-search').value.trim().toLowerCase();
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
  const hay = `${e.title} ${e.organizers||''} ${e.summary||''}`.toLowerCase();
  if (!hay.includes(search)) return false;
}
return true;
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const crop = (s, n) => s && s.length > n ? s.slice(0, n).trimEnd() + '…' : (s||'');

function slotBadge(s) {
  if (s === 'AM')       return '<span class="badge badge-am">🌅 Morning</span>';
  if (s === 'PM')       return '<span class="badge badge-pm">🌇 Afternoon</span>';
  if (s === 'Full Day') return '<span class="badge badge-fd">☀️ Full Day</span>';
  return '';
}

function dateStr(d) {
  if (d === '6/3/2026') return 'Wed, June 3';
  if (d === '6/4/2026') return 'Thu, June 4';
  return d || '';
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
if (newIds !== oldIds) { swipeList = filtered; swipeIdx = 0; swipeHistory = []; }
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
  if (v === 'swipe') { swipeList = getFiltered(); swipeIdx = 0; swipeHistory = []; renderSwipeDeck(); }
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
  el.innerHTML = `
<div class="swipe-color-overlay"></div>
<div class="badges-row">
  <span class="badge ${typeCls}">${esc(ev.type)}</span>
  ${slotBadge(ev._slot)}
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

  if (!events.length) {
el.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><h3>Your schedule is empty</h3><p>Browse events and click <strong>+ Save</strong> to add them here.</p></div>`;
return;
  }

  const byDate = {};
  events.forEach(e => { (byDate[e.date] ||= []).push(e); });
  const dayName = { '6/3/2026':'Wednesday, June 3, 2026', '6/4/2026':'Thursday, June 4, 2026' };
  const slotOrder = { AM:0, 'Full Day':1, PM:2 };

  el.innerHTML = Object.keys(byDate).sort().map(d => {
const evts = byDate[d].slice().sort((a,b) => (slotOrder[a._slot]??3)-(slotOrder[b._slot]??3));
return `
<div class="schedule-day">
  <div class="day-header">
<span class="day-label">📅 ${esc(dayName[d]||d)}</span>
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
  document.getElementById('sched-list').style.display = 'none';

  if (!events.length) {
el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗓</div><h3>Your schedule is empty</h3><p>Browse events and click <strong>+ Save</strong> to add them here.</p></div>`;
return;
  }

  const DAYS    = ['6/3/2026','6/4/2026'];
  const DAY_LBL = { '6/3/2026':'Wed, June 3', '6/4/2026':'Thu, June 4' };

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
html += `<button class="cal-day-btn${calDay === i ? ' active' : ''}" data-calday="${i}">${DAY_LBL[d]}</button>`;
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
function renderSchedule() {
  updateBadge();
  const events = allEvents.filter(e => saved.has(e.id));
  if (view === 'list') renderList(events); else renderCalendar(events);
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
  if (document.getElementById('tab-schedule').classList.contains('active')) renderSchedule();
  else updateBadge();
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
if (tab.dataset.tab === 'schedule') renderSchedule();
return;
  }

  // Save buttons (icon or footer button in cards)
  const saveBtn = e.target.closest('.save-icon-btn, .save-action-btn');
  if (saveBtn) { toggleSave(saveBtn.dataset.id); return; }

  // Unsave from calendar
  const unsaveBtn = e.target.closest('.unsave-cal-btn');
  if (unsaveBtn) { e.stopPropagation(); toggleSave(unsaveBtn.dataset.id); return; }

  // Open details by clicking a calendar item
  const calItem = e.target.closest('.cal-item');
  if (calItem && !e.target.closest('button,a')) { openModal(calItem.dataset.id); return; }

  // Calendar day switcher
  const cdBtn = e.target.closest('.cal-day-btn');
  if (cdBtn) { calDay = +cdBtn.dataset.calday; renderSchedule(); return; }

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
  const vBtn = e.target.closest('.view-btn');
  if (vBtn) {
document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
vBtn.classList.add('active');
view = vBtn.dataset.view;
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
  if (ev.program_found && ev.program_text) {
progText.innerHTML     = renderProgram(ev.program_text);
progText.style.display = '';
progUnavail.style.display = 'none';
// Quality badge
const QUALITY_LABELS = { clean:'✓ Clean', partial:'⚠ Partial', structured:'⏱ Structured', wrong:'✗ Wrong', llm:'🤖 LLM' };
const QUALITY_COLORS = { clean:'#22c55e', partial:'#f59e0b', structured:'#60a5fa', wrong:'#ef4444', llm:'#8b5cf6' };
const q = ev.program_quality;
const qBadge = q ? ` <span style="font-size:0.75em;font-weight:600;padding:1px 6px;border-radius:4px;background:${QUALITY_COLORS[q]||'#888'};color:#fff;vertical-align:middle">${QUALITY_LABELS[q]||q}</span>` : '';
if (ev.program_url) {
  progSource.innerHTML =
    `🔎 Scraped from <a href="${esc(ev.program_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(ev.program_url)}</a>${qBadge}`;
  progSource.style.display = '';
} else if (q) {
  progSource.innerHTML = qBadge;
  progSource.style.display = '';
} else {
  progSource.style.display = 'none';
}
  } else {
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
  const mapFile = coord.page === 1 ? 'assets/images/map_ballroom.png' : 'assets/images/map_meeting.png';
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

// ─── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_STORE = 'cvpr2026_settings';
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

function openSettingsModal() {
  const modal     = document.getElementById('settings-modal');
  const container = document.getElementById('settings-modal-container');
  modal.classList.remove('closing');
  container.classList.remove('closing');
  applySettings();
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.getElementById('settings-modal-close').focus();
}

function closeSettingsModal() {
  const modal     = document.getElementById('settings-modal');
  const container = document.getElementById('settings-modal-container');
  modal.classList.add('closing');
  container.classList.add('closing');
  setTimeout(() => {
modal.style.display = 'none';
modal.classList.remove('closing');
container.classList.remove('closing');
document.body.style.overflow = '';
  }, 200);
}

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

document.getElementById('btn-settings').addEventListener('click', openSettingsModal);
document.getElementById('settings-modal-close').addEventListener('click', closeSettingsModal);
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('settings-modal')) closeSettingsModal();
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

// ─── Boot ─────────────────────────────────────────────────────────────────
loadSaved();
loadSettings();
updateBadge();

// Register service worker — enables offline support and ensures users always
// receive the latest JSON data when you push updates to the repository.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init().catch(() => {
  document.getElementById('events-grid').innerHTML = `
<div class="empty-state" style="grid-column:1/-1">
  <div class="empty-icon">⚠️</div>
  <h3>Could not load event data</h3>
  <p>Unable to fetch event data. If you're offline, visit once while connected to enable offline access.</p>
</div>`;
});
