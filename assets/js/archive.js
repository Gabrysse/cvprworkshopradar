(() => {
  const esc = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function applyStoredTheme(registry) {
    const active = (registry.conferences || []).find(conf => conf.id === registry.active_conference);
    if (active) document.body.dataset.conferenceTheme = active.theme || 'default';
    let setting = 'system';
    try {
      setting = JSON.parse(localStorage.getItem(`workshopradar_${registry.active_conference}_settings`) || '{}').theme || setting;
    } catch { /* Use the system preference. */ }
    const apply = () => document.documentElement.classList.toggle('dark-mode', setting === 'dark' || (setting === 'system' && systemDark.matches));
    apply();
    systemDark.addEventListener('change', () => { if (setting === 'system') apply(); });
  }

  const formatDate = value => {
    const [month, day, year] = String(value || '').split('/').map(Number);
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(year, month - 1, day, 12);
    return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
  };
  const eventCard = event => `
    <article class="archive-event">
      <div class="archive-event-top"><span class="archive-type">${esc(event.type || 'Event')}</span><span>${esc(formatDate(event.date))}</span></div>
      <h3>${esc(event.title)}</h3>
      <p class="archive-event-meta">${esc([event.location, event.time_slot].filter(Boolean).join(' · '))}</p>
      ${event.summary ? `<p class="archive-event-summary">${esc(event.summary)}</p>` : ''}
      <div class="archive-event-links">${event.website ? `<a href="${esc(event.website)}" target="_blank" rel="noopener">Event website ↗</a>` : ''}</div>
    </article>`;

  function mountConference(conf, data) {
    const events = [...(data.workshops || []), ...(data.tutorials || [])];
    const shell = document.createElement('section');
    shell.className = 'archive-conference';
    shell.innerHTML = `
      <div class="archive-conference-head">
        <div><p class="archive-eyebrow">${esc(conf.dates_label || '')}</p><h2>${esc(conf.name)}</h2><p>${esc(conf.venue || data.venue || '')}</p></div>
        <div class="archive-counts"><span>${data.total_workshops ?? (data.workshops || []).length} workshops</span><span>${data.total_tutorials ?? (data.tutorials || []).length} tutorials</span></div>
      </div>
      <label class="archive-search"><span>Search ${esc(conf.short_name || conf.name)}</span><input type="search" placeholder="Title, organizer, topic…"></label>
      <div class="archive-results"></div>`;
    const input = shell.querySelector('input');
    const results = shell.querySelector('.archive-results');
    const render = () => {
      const query = input.value.trim().toLowerCase();
      const found = events.filter(event => `${event.title} ${event.organizers || ''} ${event.summary || ''}`.toLowerCase().includes(query));
      results.innerHTML = found.length ? found.map(eventCard).join('') : '<p class="archive-empty">No archived events match that search.</p>';
    };
    input.addEventListener('input', render);
    render();
    return shell;
  }

  async function init() {
    const target = document.getElementById('archive-conferences');
    try {
      const registry = await fetch('conferences.json', { cache: 'no-cache' }).then(response => response.json());
      applyStoredTheme(registry);
      const archived = (registry.conferences || []).filter(conf => conf.status === 'archived' && conf.data_file);
      if (!archived.length) { target.innerHTML = '<p class="archive-loading">No past conferences have been archived yet.</p>'; return; }
      const entries = await Promise.all(archived.map(async conf => [conf, await fetch(conf.data_file, { cache: 'no-cache' }).then(response => response.json())]));
      target.innerHTML = '';
      entries.forEach(([conf, data]) => target.appendChild(mountConference(conf, data)));
    } catch {
      target.innerHTML = '<p class="archive-loading">The archive could not be loaded. Refresh once you are connected.</p>';
    }
  }
  init();
})();
