document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('bucketpilot-dashboard');
  if (!root) { return; }
  const form = root.querySelector('form');
  const search = root.querySelector('#bp-bucket-search');
  const results = root.querySelector('[data-dashboard-results]');
  const context = root.querySelector('[data-dashboard-context]');
  const error = root.querySelector('[data-dashboard-error]');
  const refresh = root.querySelector('[data-dashboard-refresh]');
  let running;
  let debounce;

  const load = async (page = 0, force = false) => {
    running?.abort();
    const current = new AbortController();
    running = current;
    const filter = new URLSearchParams({q: search.value, size: results.querySelector('select').value, page});
    const params = new URLSearchParams(filter);
    params.set('view', location.pathname.endsWith('/buckets') ? 'buckets' : 'overview');
    if (force) { params.set('refresh', '1'); }
    error.hidden = true;
    results.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/bucketpilot/dashboard-data?' + params, {signal: current.signal, cache: 'no-store'});
      const data = await response.json();
      if (!response.ok) { throw new Error(data.error || 'Bucket directory unavailable.'); }
      if (current !== running) { return; }
      const focus = document.activeElement;
      results.innerHTML = data.markup;
      context.innerHTML = data.context;
      const badge = document.querySelector('[data-bp-connection]');
      badge.className = 'bp-status bp-status--' + data.status;
      badge.dataset.bpTone = window.bucketpilotUI.bucketpilotDisplay.tone(data.status);
      badge.textContent = data.label;
      document.querySelector('[data-bp-workspace]').textContent = data.workspace;
      if (focus.id === 'bp-bucket-size') { results.querySelector('select').focus(); }
      else if (focus.dataset.page !== undefined) { (results.querySelector('[data-page]') || results.querySelector('[tabindex]')).focus(); }
      filter.set('page', data.page);
      window.bucketpilotUI.replaceAddress('?' + filter);

    } catch (issue) {
      if (issue.name !== 'AbortError') { error.textContent = issue.message; error.hidden = false; }
    } finally {
      if (current === running) { results.removeAttribute('aria-busy'); }
    }
  };

  form.addEventListener('submit', (event) => { event.preventDefault(); clearTimeout(debounce); load(); });
  search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => load(), 350); });
  results.addEventListener('change', (event) => { if (event.target.id === 'bp-bucket-size') { load(); } });
  results.addEventListener('click', (event) => {
    const link = event.target.closest('[data-page]');
    if (link) { event.preventDefault(); load(Number(link.dataset.page)); }
  });
  refresh.addEventListener('click', () => window.bucketpilotUI.bucketpilotRefresh.run(refresh, () => load(0, true)));
});
