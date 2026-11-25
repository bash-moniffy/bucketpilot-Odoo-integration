(function (bucketpilotUI, once, settings) {
  'use strict';
  const config = () => settings.bucketpilotBuilder;
  // Custom HTTP development hosts do not expose crypto.randomUUID().
  const newRequestId = () => {
    if (typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) { element.textContent = text; }
    if (className) { element.className = className; }
    return element;
  };
  const button = (text, action, className = '') => {
    const element = node('button', text, `button ${className}`);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  const iconButton = (label, icon, action, href = '') => {
    const control = href ? node('a', undefined, `button bp-action-icon bp-action-${icon}`) : button('', action, `bp-action-icon bp-action-${icon}`);
    if (href) { control.href = href; }
    control.title = label; control.setAttribute('aria-label', label);
    const paths = {details: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', edit: 'm16 3 5 5-12 12-6 1 1-6L16 3 M13 6l5 5', run: 'm8 4 12 8-12 8V4', resume: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M10 8l6 4-6 4V8', pause: 'M7 4h3v16H7z M15 4h3v16h-3z', delete: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7', retry: 'M3 11a9 9 0 1 1 2 7 M3 4v7h7'};
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[icon]); svg.append(path);
    control.append(svg, node('span', label, 'visually-hidden')); return control;
  };
  const sourceList = (rules) => {
    const list = node('div', undefined, 'bp-detail-source-list');
    if (rules.length > 5) { list.classList.add('is-scrollable'); list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', bucketpilotUI.t('Backup sources')); }
    [true, false].forEach((included) => {
      const entries = rules.filter((rule) => rule.include === included); if (!entries.length) { return; }
      const group = node('section', undefined, 'bp-source-group');
      group.append(node('h4', `${included ? bucketpilotUI.t('Included') : bucketpilotUI.t('Excluded')} (${entries.length})`));
      const items = node('ul');
      entries.forEach((rule) => { const entry = node('li'); entry.append(node('span', rule.path || 'Entire source', `bp-entry-name bp-entry-name--${rule.directory ? 'folder' : 'file'}`)); items.append(entry); });
      group.append(items); list.append(group);
    });
    if (!rules.length) { list.append(node('p', bucketpilotUI.t('No sources selected.'))); }
    return list;
  };
  const statusBadge = (status, label = bucketpilotUI.bucketpilotDisplay.status(status)) => {
    const element = node('span', label, 'bp-job-status');
    element.title = label; element.dataset.bpStatus = status; element.dataset.bpTone = bucketpilotUI.bucketpilotDisplay.tone(status);
    return element;
  };
  const stackedCell = (row, primary, secondary) => {
    const element = node('div', undefined, 'bp-cell-stack');
    element.append(node('strong', primary), node('small', secondary));
    const target = node('td'); target.append(element); row.append(target); return target;
  };
  const recentIndicators = (item) => {
    const group = node('div', undefined, 'bp-run-indicators');
    const oneTime = ['once', 'now'].includes(item.frequency || item.config?.schedule?.frequency);
    const count = oneTime ? 1 : 5;
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', oneTime ? bucketpilotUI.t('Backup execution') : bucketpilotUI.t('Last five runs, oldest to newest, left to right'));
    const runs = (item.recent_runs || []).slice(0, count).reverse();
    const empty = item.execution_status === 'History cleared' ? bucketpilotUI.t('History cleared') : bucketpilotUI.t('No execution history');
    const slots = [...runs, ...Array(count - runs.length).fill(null)];
    slots.forEach((run) => {
      const tone = !run ? 'neutral' : ['completed', 'done'].includes(run.status) ? 'success' : ['failed', 'cancelled'].includes(run.status) ? 'danger' : ['pending', 'queued', 'scanning', 'running', 'paused', 'completed_with_errors'].includes(run.status) ? 'warning' : 'neutral';
      const description = run ? `${bucketpilotUI.bucketpilotDisplay.status(run.status)} · ${bucketpilotUI.bucketpilotDisplay.status(run.execution_type)} · ${bucketpilotUI.t('Requested')}: ${stamp(run.created, item.config?.schedule?.timezone || 'UTC')}` : empty;
      const indicator = node('span', undefined, 'bp-run-dot');
      indicator.dataset.bpTone = tone; indicator.dataset.bpState = run?.status || 'empty';
      indicator.setAttribute('role', 'img'); indicator.setAttribute('aria-label', description); if (run) { indicator.tabIndex = 0; } indicator.title = description;
      group.append(indicator);
    });
    return group;
  };
  const pageButton = (element, available) => {
    element.hidden = !available;
    element.disabled = !available;
    const group = element.closest('.bp-pager-actions');
    if (group) { group.hidden = ![...group.querySelectorAll('.bp-page-control')].some((control) => !control.hidden); }
  };
  const read = async (action, parameters = {}, signal, silent = false) => {
    const labels = {state: 'Loading backup draft…', files: 'Loading files and folders…', search: 'Searching files…', buckets: 'Loading buckets…', folders: 'Loading backup folders…', destination_check: 'Checking the saved folder…', plans: 'Loading backup schedules…', history: 'Loading backup history…', plan: 'Loading plan details…', run: 'Loading execution details…', connection: 'Checking the backup connection…'};
    const regions = {files: '[data-source-rows]', search: '[data-source-rows]', buckets: '[data-bucket-rows]', folders: '[data-folder-list]', plans: '[data-record-rows]', history: '[data-record-rows]'};
    const perform = async () => {
      const url = new URL(config().endpoint, window.location.origin);
      url.search = new URLSearchParams({action, ...parameters});
      const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', signal, headers: {Accept: 'application/json'}});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { throw new Error(data.error || bucketpilotUI.t('Unable to load data. Check your connection and permissions.')); }
      return data;
    };
    return silent ? perform() : bucketpilotUI.bucketpilotAjax.run(bucketpilotUI.t(labels[action] || 'Loading…'), perform, document.querySelector(regions[action] || '[data-bp-builder]'));
  };
  const write = async (operation, revision, input, requestId) => {
    const labels = {edit_plan: 'Saving plan changes…', name: 'Checking backup name…', selection: 'Updating source selection…', clear: 'Clearing selection…', reset: 'Resetting the draft…', bucket: 'Updating bucket…', path: 'Updating folder…', timing: 'Updating timing…', commit: config().editing ? 'Saving plan changes…' : 'Saving backup…', folder: 'Creating folder…', clear_history: 'Deleting backup history…', load_plan: 'Loading the plan into your draft…', retry_run: 'Requesting a new execution…', plan_pause: 'Pausing schedule…', plan_resume: 'Resuming schedule…', plan_delete: 'Deleting plan…', plan_run: 'Queuing backup…'};
    const triggers = {commit: '[data-commit-builder]', clear: '[data-clear-selection]', reset: '[data-clear-all]', folder: '[data-create-folder-submit]', clear_history: '[data-clear-history]'};
    return bucketpilotUI.bucketpilotAjax.run(bucketpilotUI.t(labels[operation] || 'Saving changes…'), async () => {
      const response = await fetch(config().endpoint, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': config().csrf, Accept: 'application/json'},
        body: JSON.stringify({operation, revision, input, request_id: requestId})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(data.error || bucketpilotUI.t('Save failed. Reload this page if your login session expired.')); error.status = response.status; throw error; }
      const messages = {name: 'Backup name saved successfully.', selection: 'Source selection saved successfully.', bucket: 'Bucket saved successfully.', path: 'Destination saved successfully.', timing: 'Timing saved successfully.', folder: 'Folder created successfully.', clear: 'Selection cleared successfully.', reset: 'Draft reset successfully.', plan_pause: 'Schedule paused successfully.', plan_resume: 'Schedule resumed successfully.', plan_delete: 'Plan deleted successfully.', plan_run: 'Saved successfully.', retry_run: 'Saved successfully.'};
      if (messages[operation] && !['name', 'selection', 'bucket', 'path', 'timing'].includes(operation)) { bucketpilotUI.bucketpilotNotice.show(config().editing ? bucketpilotUI.t('Edit draft saved. Review and save changes to update the plan.') : bucketpilotUI.t(messages[operation])); }
      return data;
    }, triggers[operation] ? document.querySelector(triggers[operation]) : null);
  };
  const selected = (rules, path) => {
    let length = -1; let value = false;
    rules.forEach((rule) => {
      if ((rule.path === '' || path === rule.path || path.startsWith(`${rule.path}/`)) && rule.path.length > length) {
        length = rule.path.length; value = rule.include;
      }
    });
    return value;
  };
  const below = (path, parent) => parent === '' || path === parent || path.startsWith(`${parent}/`);
  const partial = (rules, path) => rules.some((rule) => rule.path !== path && below(rule.path, path) && rule.include !== selected(rules, path));
  const applyRule = (rules, change) => {
    const next = rules.filter((rule) => !below(rule.path, change.path));
    if (selected(next, change.path) !== change.include) { next.push(change); }
    return next;
  };
  bucketpilotUI.bucketpilotBuilderApi = {read, write};
  bucketpilotUI.bucketpilotSelection = {selected, partial, change: applyRule};
  const stamp = (value, zone = 'UTC') => Number(value) > 0 ? new Intl.DateTimeFormat(undefined, {timeZone: zone, dateStyle: 'medium', timeStyle: 'short'}).format(new Date(Number(value) * 1000)) + ` (${zone})` : '—';
  const scheduleText = (schedule) => {
    if (!schedule.frequency) { return bucketpilotUI.t('Choose a frequency'); }
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const time = schedule.time;
    const when = schedule.frequency === 'once' ? schedule.date : (schedule.frequency === 'weekly' ? weekdays[schedule.weekday - 1] : (schedule.frequency === 'monthly' ? `${bucketpilotUI.t('Day')} ${schedule.monthday} (${bucketpilotUI.t('or last day')})` : ''));
    return schedule.frequency === 'now' ? bucketpilotUI.t('Run Now') : `${schedule.frequency} ${when} · ${time} · ${schedule.timezone}`;
  };
  const runUrl = (id) => config().detail.replace('00000000-0000-0000-0000-000000000000', id);

  bucketpilotUI.behaviors.bucketpilotBuilder = {
    attach(context) {
      once('bucketpilot-builder', '[data-bp-builder]', context).forEach((root) => {
        const find = (selector) => root.querySelector(selector);
        let draft; let optimistic = []; let contextVersion = 0; let connectionRefreshing = false;
        let currentPath = ''; let nextFiles = null; let previousFiles = null; let searchToken = '';
        let retryFiles = () => loadFiles();
        let fileRequest; let bucketRequest; let bucketPage = 0; let bucketTotal = 0; let chosenBucket = '';
        let pathVersion = 0; let destinationMode = ''; let browserChoice = null; let pathAvailable = true; let destinationCheck = 0; let folderReady = false;
        let folderPage = 0; let folderPrefix = ''; let editingBucket = false; let editingPath = false;
        let queue = []; let pumping = false; let blocked = false; let selectionTimer; let selectionBatch = [];
        let fileTimer; let bucketTimer; let selectionSignature = '';
        let nameTimer; let nameVersion = 0; let nameDirty = false; let nameSaveError = false;
        let timingVersion = 0; let timingDirty = false; let pathDirty = false; let bucketDirty = false; let committing = false; let timingTimer; let pathTimer; let timeTouched = !!config().editing; let creatingFolder = false;

        const errorBox = find('[data-builder-error]');
        const feedback = find('[data-save-state]');
        const showError = (error, retry, operation = '') => {
          if (operation === 'folder' && error.status === 400) { find('[data-new-folder-error]').textContent = error.message; return; }
          if (operation === 'timing' || /future date and time|valid local time|frequency/i.test(error.message || '')) {
            const inline = find('[data-schedule-error]'); inline.hidden = false; inline.replaceChildren(node('span', error.message || error));
            if (retry) { inline.append(button(bucketpilotUI.t('Retry'), retry)); }
            const step = find('[data-step-schedule]'); root.querySelectorAll('.bp-config-panel > details').forEach((item) => { item.open = item === step; });
            return;
          }
          errorBox.hidden = false; errorBox.replaceChildren(node('span', error.message || error));
          if (retry) { errorBox.append(button(bucketpilotUI.t('Retry save'), retry)); }
        };
        const syncTree = () => {
          root.querySelectorAll('[data-source-path]').forEach((checkbox) => {
            checkbox.disabled = blocked;
            checkbox.checked = selected(optimistic, checkbox.dataset.sourcePath);
            checkbox.indeterminate = partial(optimistic, checkbox.dataset.sourcePath);
            checkbox.setAttribute('aria-checked', checkbox.indeterminate ? 'mixed' : String(checkbox.checked));
            checkbox.closest('tr')?.classList.toggle('bp-source-selected', checkbox.checked || checkbox.indeterminate);
          });
        };
        const timingControlsValid = () => [...find('[data-schedule-form]').querySelectorAll('input, select')].every((control) => control.disabled || control.checkValidity());
        const renderSelection = () => {
          const list = find('[data-selection-list]');
          const signature = JSON.stringify(optimistic);
          const rebuild = selectionSignature !== signature;
          selectionSignature = signature;
          if (rebuild) { list.replaceChildren(); }
          const files = optimistic.filter((rule) => rule.include && !rule.directory).length;
          const folders = optimistic.filter((rule) => rule.include && rule.directory).length;
          const exclusions = optimistic.filter((rule) => !rule.include).length;
          find('[data-selection-count]').textContent = bucketpilotUI.t('@files files · @folders folders · @excluded exclusions', {'@files': files, '@folders': folders, '@excluded': exclusions});
          find('[data-tree-count]').textContent = bucketpilotUI.t('@count selected rules', {'@count': optimistic.length});
          if (rebuild && !optimistic.length) { list.append(node('p', bucketpilotUI.t('Check a file or folder in the explorer to add it.'), 'bp-builder-hint')); }
          if (rebuild) { optimistic.forEach((rule) => {
            const item = node('div', undefined, `bp-rule ${rule.include ? '' : 'bp-rule-excluded'}`);
            const label = node('span', rule.path || bucketpilotUI.t('Entire source'), `bp-entry-name bp-entry-name--${rule.directory ? 'folder' : 'file'}`);
            const description = node('small', rule.include ? (rule.directory ? bucketpilotUI.t('Includes permitted descendants') : bucketpilotUI.t('Included file')) : bucketpilotUI.t('Excluded from inherited folder selection'));
            const text = node('div'); text.append(label, description);
            const remove = button(rule.include ? bucketpilotUI.t('Remove') : bucketpilotUI.t('Restore'), () => selectChange({...rule, include: !rule.include}));
            remove.setAttribute('aria-label', `${rule.include ? bucketpilotUI.t('Remove') : bucketpilotUI.t('Restore')} ${rule.path || bucketpilotUI.t('source root')}`);
            item.append(text, remove); list.append(item);
          }); }
          syncTree();
          if (!draft) { return; }
          const busy = pumping || queue.length > 0 || selectionBatch.length > 0;
          const data = draft.data;
          root.toggleAttribute('data-draft-pending', busy || nameDirty || timingDirty || pathDirty || bucketDirty);
          find('[data-name-state]').textContent = nameSaveError || (blocked && nameDirty) ? bucketpilotUI.t('Name not saved — retry or correct the input') : nameDirty ? bucketpilotUI.t('Checking name…') : (draft.validity.name ? bucketpilotUI.t('Ready') : bucketpilotUI.t('Required · enter a backup name'));
          const timingValid = draft.validity.schedule && timingControlsValid() && (data.schedule.frequency !== 'once' || !!data.schedule.date);
          find('[data-name-summary]').textContent = draft.validity.name && !nameDirty ? data.name : bucketpilotUI.t('Enter a backup name');
          const folderLocked = !data.bucket || bucketDirty;
          const folderStep = find('[data-step-path]'); folderStep.classList.toggle('bp-step-locked', folderLocked);
          folderStep.querySelector('summary').setAttribute('aria-disabled', String(folderLocked));
          find('[data-open-step="path"]').disabled = folderLocked;
          if (folderLocked) { folderStep.open = false; }
          const states = [
            [draft.validity.name && !nameDirty, '[data-step-name]', 'Enter a backup name.'],
            [data.bucket && !bucketDirty, '[data-step-bucket]', 'Choose a destination bucket.'],
            [!folderLocked && data.prefix_saved && !pathDirty && pathAvailable, '[data-step-path]', 'Choose a folder path or use the bucket root.'],
            [data.rules.some((rule) => rule.include) && !selectionBatch.length, '[data-step-selection]', 'Select at least one file or folder.'],
            [timingValid && !timingDirty, '[data-step-schedule]', !find('#bp-frequency').value ? 'Choose a frequency.' : find('#bp-frequency').value === 'once' ? 'Choose a future date and time.' : 'Choose valid timing.']
          ];
          states.forEach(([complete, selector, missing]) => {
            const step = find(selector);
            step.classList.toggle('bp-step-complete', !!complete);
            step.classList.toggle('bp-step-incomplete', !complete);
            let badge = step.querySelector('.bp-step-state');
            if (!badge) { badge = node('span', '', 'bp-step-state'); step.querySelector('summary').append(badge); }
            badge.textContent = complete ? bucketpilotUI.t('✓ Ready') : bucketpilotUI.t('Incomplete');
            let hint = step.querySelector('[data-step-hint]');
            if (!hint) { hint = node('p', '', 'bp-builder-hint'); hint.dataset.stepHint = ''; step.append(hint); }
            hint.textContent = complete ? '' : bucketpilotUI.t(missing); hint.hidden = !!complete || (selector === '[data-step-schedule]' && !find('[data-schedule-error]').hidden);
          });
          const keys = ['name', 'bucket', 'path', 'selection', 'schedule'];
          const firstIncomplete = states.findIndex(([complete]) => !complete);
          states.forEach(([complete], index) => {
            const point = find(`[data-progress="${keys[index]}"]`); const ready = !!complete;
            point.classList.toggle('is-complete', ready);
            point.classList.toggle('is-linked', ready && !!states[index + 1]?.[0]);
            point.querySelector('[data-progress-state]').textContent = ready ? bucketpilotUI.t('Completed') : bucketpilotUI.t('Incomplete');
            if (index === firstIncomplete) { point.querySelector('button').setAttribute('aria-current', 'step'); } else { point.querySelector('button').removeAttribute('aria-current'); }
          });
          const missing = states.filter(([complete]) => !complete).map((state) => bucketpilotUI.t(state[2]));
          find('[data-review-status]').textContent = blocked ? bucketpilotUI.t('A save failed. Retry it or reload the draft.') : (busy ? bucketpilotUI.t('Checking configuration…') : ((missing.length ? bucketpilotUI.t('Complete the highlighted steps before saving.') : '') || (config().editing && !draft.data._edit_dirty ? bucketpilotUI.t('No changes to save yet.') : bucketpilotUI.t('All five steps are ready. Review and confirm below.'))));
          find('[data-review-builder]').disabled = !!missing.length || !!busy || blocked || committing || (!!config().editing && !draft.data._edit_dirty);

        };
        const currentTime = (zone) => new Intl.DateTimeFormat('en-GB', {timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date());
        const fillTiming = () => {
          const data = draft.data; const schedule = data.schedule;
          find('#bp-plan-name').value = data.name;
          find('#bp-frequency').value = schedule.frequency;
          find('#bp-timezone').value = schedule.timezone;
          find('#bp-run-date').value = schedule.date;
          find('#bp-run-time').value = !config().editing && !data._frequency_chosen && !timeTouched ? currentTime(schedule.timezone) : schedule.time;
          find('#bp-weekday').value = schedule.weekday;
          find('#bp-monthday').value = schedule.monthday;
          timingVisibility();
        };
        const renderDestinationMode = () => {
          find('[data-root-mode]').hidden = destinationMode !== 'root';
          find('[data-manual-mode]').hidden = destinationMode !== 'manual';
          find('[data-browser-mode]').hidden = destinationMode !== 'browser';
          find('[data-pending-folder]').textContent = browserChoice === null ? bucketpilotUI.t('No folder selected') : `${draft.data.bucket?.name || ''} / ${browserChoice || bucketpilotUI.t('Top level')}`;
          find('[data-browse-folders]').disabled = !draft.data.bucket;
          find('[data-destination-modes]').disabled = !draft.data.bucket;
          root.querySelectorAll('[name="bp-destination-mode"]').forEach((radio) => { radio.disabled = !draft.data.bucket; radio.checked = radio.value === destinationMode; });
          find('#bp-destination-path').disabled = !draft.data.bucket || destinationMode !== 'manual';
          find('#bp-destination-path').required = destinationMode === 'manual';
        };
        const checkDestination = async () => {
          const token = ++destinationCheck;
          const saved = draft.data;
          const label = find('[data-destination-evidence]');
          pathAvailable = true;
          if (!saved.prefix_saved) { label.textContent = ''; return; }
          if (saved.destination_mode !== 'browser') {
            label.textContent = saved.prefix ? bucketpilotUI.t('Selected manual path. It may be created when the backup runs.') : bucketpilotUI.t('Bucket root selected.'); return;
          }
          pathAvailable = false; label.textContent = bucketpilotUI.t('Checking the latest folder listing…'); renderSelection();
          try {
            const result = await read('destination_check'); if (token !== destinationCheck) { return; }
            pathAvailable = result.evidence !== 'not_found_in_listing';
            label.textContent = !pathAvailable ? bucketpilotUI.t('Folder no longer found in the latest listing. The listing may be out of date. Choose or create a folder, or enter a manual path.') : (result.evidence === 'live_marker' ? bucketpilotUI.t('Folder marker confirmed by storage.') : bucketpilotUI.t('Selected folder found in the latest listing. Recent changes may not be reflected yet.'));
          }
          catch { if (token === destinationCheck) { label.textContent = bucketpilotUI.t('Could not verify this folder. Browse again or enter a manual path.'); } }
          if (token === destinationCheck) { renderSelection(); }
        };
        const renderDraft = (fillInputs = false) => {
          const data = draft.data;
          if (fillInputs || !chosenBucket) { chosenBucket = data.bucket?.id || ''; }
          find('[data-bucket-summary]').textContent = data.bucket ? `${data.bucket.name} · ${data.bucket.provider}` : bucketpilotUI.t('Choose connected storage');
          find('[data-bucket-saved]').textContent = data.bucket ? bucketpilotUI.t('Ready') : '';
          find('[data-bucket-card]').hidden = !data.bucket || editingBucket;
          find('[data-bucket-editor]').hidden = !!data.bucket && !editingBucket;
          if (data.bucket) {
            find('[data-bucket-card-name]').textContent = data.bucket.name;
            find('[data-bucket-card-meta]').textContent = `${data.bucket.provider} · ${data.bucket.region}`;
          }
          find('[data-path-saved]').textContent = data.prefix_saved ? bucketpilotUI.t('Ready') : bucketpilotUI.t('Choose a folder');
          find('[data-path-summary]').textContent = data.prefix_saved ? (data.prefix || bucketpilotUI.t('Top level')) : (data.bucket ? bucketpilotUI.t('Choose a folder path') : bucketpilotUI.t('Choose a bucket first'));
          find('[data-path-card]').hidden = !data.prefix_saved || editingPath;

          find('[data-path-form]').hidden = !!data.prefix_saved && !editingPath;
          find('[data-path-card-bucket]').textContent = data.bucket?.name || '';
          find('[data-path-card-prefix]').textContent = data.prefix || bucketpilotUI.t('Top level');
          if (fillInputs) {
            destinationMode = !data.prefix_saved ? '' : data.destination_mode === 'browser' ? 'browser' : data.prefix === '' ? 'root' : 'manual'; browserChoice = data.prefix_saved && destinationMode === 'browser' ? data.prefix : null;
            find('#bp-destination-path').value = data.prefix_saved ? data.prefix : '';
            fillTiming();
          }
          renderDestinationMode();
          find('[data-destination-preview]').textContent = data.bucket && data.prefix_saved ? `${data.bucket.name} / ${data.prefix ? data.prefix + ' / ' : ''}YYYY-MM-DD (UTC)` : bucketpilotUI.t('Choose a destination to preview it.');
          find('[data-schedule-summary]').textContent = scheduleText(data.schedule);
          find('[data-final-summary]').textContent = data.plan_id ? bucketpilotUI.t('Review and Save changes to apply your edits to future runs.') : bucketpilotUI.t('Review the destination and selection before creating a plan.');
          renderSelection();
        };
        const pump = async () => {
          if (pumping || blocked || !queue.length) { return; }
          pumping = true; renderSelection();
          const task = queue[0];
          task.contextVersion ??= contextVersion;
          task.revision ??= draft.revision;
          feedback.textContent = bucketpilotUI.t('Checking configuration…');
          try {
            const response = await write(task.operation, task.revision, task.input, task.id);
            if (task.contextVersion !== contextVersion) { return; }
            draft = response;
            if (task.operation === 'timing') { timingDirty = task.timingVersion !== timingVersion; }
            if (['name', 'timing'].includes(task.operation)) { nameSaveError = false; nameDirty = task.nameVersion !== nameVersion; }
            if (task.operation === 'path') { pathDirty = task.pathVersion !== pathVersion; pathAvailable = true; if (!pathDirty) { find('#bp-destination-path').value = response.data.prefix; } }
            if (task.operation === 'bucket') {
              bucketDirty = chosenBucket !== response.data.bucket?.id;
              if (task.bucketBefore !== response.data.bucket?.id) {
                folderRequest++; destinationCheck++; createdFolders.clear(); folderPrefix = ''; folderPage = 0; browserChoice = null; destinationMode = ''; pathDirty = false; pathAvailable = true; folderReady = false;
                find('[data-folder-list]').replaceChildren(); find('#bp-destination-path').value = '';
                root.querySelectorAll('[name="bp-destination-mode"]').forEach((radio) => { radio.checked = false; });
                find('[data-folder-browser]').close();
              }
            }
            queue.shift();
            optimistic = structuredClone(draft.data.rules);
            queue.filter((item) => item.operation === 'selection').forEach((item) => item.input.changes.forEach((rule) => { optimistic = applyRule(optimistic, rule); }));
            selectionBatch.forEach((rule) => { optimistic = applyRule(optimistic, rule); });
            errorBox.hidden = true;
            if (task.operation === 'timing') { find('[data-schedule-error]').hidden = true; }
            feedback.textContent = queue.length || selectionBatch.length ? bucketpilotUI.t('Checking configuration…') : bucketpilotUI.t('Draft ready');
            renderDraft();
            if (task.operation === 'commit') { commitSuccess(response); }
            task.resolve(response);
          }
          catch (error) {
            if (task.contextVersion !== contextVersion) { return; }
            if (task.operation === 'name') { nameSaveError = true; }
            if (error.status === 400) {
              queue.shift();
              optimistic = structuredClone(draft.data.rules);
              queue.filter((item) => item.operation === 'selection').forEach((item) => item.input.changes.forEach((rule) => { optimistic = applyRule(optimistic, rule); }));
              selectionBatch.forEach((rule) => { optimistic = applyRule(optimistic, rule); });
              feedback.textContent = bucketpilotUI.t('Not saved — correct the input and try again');
              showError(error, null, task.operation);
            }
            else {
              blocked = true;
              feedback.textContent = bucketpilotUI.t('Not saved — retry or reload');
              showError(error, () => { blocked = false; errorBox.hidden = true; pump(); }, task.operation);
            }
            task.reject(error);
            renderSelection();
          }
          finally { pumping = false; renderSelection(); if (!blocked) { pump(); } }
        };
        const command = (operation, input) => new Promise((resolve, reject) => {
          if (blocked) { reject(new Error(bucketpilotUI.t('Retry the failed save or reload the draft first.'))); return; }
          queue.push({operation, input, id: newRequestId(), resolve, reject, nameVersion, timingVersion, localPath: find('#bp-destination-path').value, pathVersion, bucketBefore: draft.data.bucket?.id}); pump();
        });
        const flushSelection = () => {
          window.clearTimeout(selectionTimer);
          if (!selectionBatch.length) { return Promise.resolve(); }
          const changes = selectionBatch; selectionBatch = [];
          return command('selection', {changes});
        };
        const selectChange = (change) => {
          if (!draft || blocked) { return; }
          optimistic = applyRule(optimistic, change);
          selectionBatch.push(change);
          renderSelection(); feedback.textContent = bucketpilotUI.t('Checking configuration…');
          window.clearTimeout(selectionTimer);
          selectionTimer = window.setTimeout(() => flushSelection().catch(() => {}), 150);
        };
        const parentFolder = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
        const renderBreadcrumb = (path) => {
          const crumbs = find('[data-tree-path]');
          const parts = path ? path.split('/') : [];
          const home = find('[data-tree-home]');
          home.toggleAttribute('aria-current', !parts.length);
          if (!parts.length) { home.setAttribute('aria-current', 'location'); }
          crumbs.replaceChildren(home.parentElement);
          parts.forEach((part, index) => {
            const crumb = node('li');
            if (index === parts.length - 1) {
              const current = node('span', part);
              current.setAttribute('aria-current', 'location');
              crumb.append(current);
            } else {
              const target = parts.slice(0, index + 1).join('/');
              const focus = parts.slice(0, index + 2).join('/');
              crumb.append(button(part, () => openFolder(target, focus), 'bp-crumb-link'));
            }
            crumbs.append(crumb);
          });
          find('[data-tree-back]').disabled = !path;
        };
        const sourceRow = (entry, depth, searchResult = false, currentFolder = false) => {
          const row = node('tr'); row.dataset.path = entry.path; row.dataset.depth = depth;
          const checkCell = node('td'); const check = document.createElement('input');
          check.type = 'checkbox'; check.dataset.sourcePath = entry.path;
          check.setAttribute('aria-label', bucketpilotUI.t('Select @path', {'@path': entry.path || bucketpilotUI.t('entire current folder')}));
          check.addEventListener('change', () => selectChange({path: entry.path, directory: entry.directory, include: partial(optimistic, entry.path) ? true : check.checked}));
          checkCell.append(check);
          const name = node('td'); name.style.setProperty('--bp-tree-indent', `${12 + depth * 26}px`);
          const canExpand = entry.directory && !currentFolder;
          const entryLayout = node('div', undefined, canExpand ? 'bp-source-entry' : 'bp-source-entry bp-source-entry--no-toggle');
          if (canExpand) {
            const expand = button('', async () => {
              const expanded = expand.getAttribute('aria-expanded') === 'true';
              if (expanded) {
                let next = row.nextElementSibling;
                while (next && Number(next.dataset.depth) > depth) { const previous = next; next = next.nextElementSibling; previous.remove(); }
                expand.setAttribute('aria-expanded', 'false'); return;
              }
              expand.disabled = true; expand.setAttribute('aria-busy', 'true'); expand.removeAttribute('title');
              try {
                const page = await read('files', {path: entry.path});
                if (!row.isConnected) { return; }
                if (find('[data-source-rows]').children.length + page.entries.length > 1000) { throw new Error(bucketpilotUI.t('Open this folder by its name to continue within the visible-row limit.')); }
                let last = row;
                page.entries.forEach((child) => { const childRow = sourceRow(child, depth + 1); last.after(childRow); last = childRow; });
                if (page.next !== null) { const more = node('tr'); more.dataset.depth = depth + 1; const cell = node('td'); cell.colSpan = 3; cell.append(button(bucketpilotUI.t('Open folder for more entries'), () => openFolder(entry.path))); more.append(cell); last.after(more); }
                if (!page.entries.length) { find('[data-tree-feedback]').textContent = bucketpilotUI.t('This folder has no eligible entries on this page.'); }
                expand.setAttribute('aria-expanded', 'true'); syncTree();
              }
              catch (error) { find('[data-tree-feedback]').textContent = error.message; expand.title = bucketpilotUI.t('Retry expanding this folder'); }
              finally { expand.disabled = false; expand.removeAttribute('aria-busy'); }
            }, 'bucketpilot-tree-toggle');
            expand.setAttribute('aria-expanded', 'false');
            expand.setAttribute('aria-label', bucketpilotUI.t('Expand or collapse @path', {'@path': entry.path}));
            entryLayout.append(expand);
          }
          const label = node('span', entry.name, `bp-entry-name bp-entry-name--${entry.directory ? 'folder' : 'file'}`);
          if (entry.directory && !currentFolder) {
            label.replaceChildren(button(entry.name, () => openFolder(entry.path), 'bp-source-link'));
          }
          const info = node('div', undefined, 'bp-source-result-info');
          info.append(label);
          if (currentFolder) {
            row.classList.add('bp-source-current');
            check.title = bucketpilotUI.t('Select this entire folder');
          }
          if (searchResult) {
            const parent = parentFolder(entry.path);
            info.append(node('div', parent || find('[data-tree-home]').textContent, 'bp-source-relative'));
            if (!entry.directory) {
              const reveal = button(bucketpilotUI.t('Reveal location'), () => openFolder(parent, entry.path), 'bp-reveal-location');
              reveal.setAttribute('aria-label', bucketpilotUI.t('Reveal location of @name', {'@name': entry.name}));
              entryLayout.append(reveal);
            }
          }
          entryLayout.append(info);
          name.append(entryLayout);
          row.append(checkCell, name, node('td', entry.directory ? '—' : bucketpilotUI.bucketpilotDisplay.bytes(entry.size)));
          return row;
        };
        const loadFiles = async (path = currentPath, options = {}) => {
          const {offset = 0, append = false, focus = ''} = options;
          fileRequest?.abort();
          const request = new AbortController();
          fileRequest = request;
          const body = find('[data-source-rows]');
          const scroller = find('.bp-tree-scroll');
          body.setAttribute('aria-busy', 'true');
          find('[data-tree-feedback]').textContent = bucketpilotUI.t('Loading files and folders…');
          find('[data-tree-retry]').hidden = true;
          retryFiles = () => loadFiles(path, options);
          try {
            const page = await read('files', {path, offset, focus}, request.signal);
            if (request !== fileRequest) { return; }
            if (append && body.children.length + page.entries.length > 1000) {
              throw new Error(bucketpilotUI.t('Open a child folder to continue within the visible-row limit.'));
            }
            currentPath = path;
            nextFiles = page.next;
            scroller.classList.remove('bp-tree-search-results');
            if (!append) {
              previousFiles = page.previous;
              const name = path ? path.split('/').at(-1) : find('[data-tree-home]').textContent;
              body.replaceChildren(sourceRow({name, path, directory: true}, 0, false, true));
              scroller.scrollTop = 0;
              renderBreadcrumb(path);
            }
            page.entries.forEach((entry) => body.append(sourceRow(entry, 1)));
            find('[data-tree-previous]').hidden = previousFiles === null;
            find('[data-tree-more]').hidden = nextFiles === null;
            find('[data-search-more]').hidden = true;
            find('[data-tree-feedback]').textContent = page.entries.length ? '' : bucketpilotUI.t('This folder is empty.');
            syncTree();
            const target = focus && [...body.children].find((row) => row.dataset.path === focus);
            if (target) {
              target.classList.add('bp-source-located');
              const headerHeight = scroller.querySelector('thead').offsetHeight;
              scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headerHeight;
              target.querySelector('input').focus({preventScroll: true});
            }
          } catch (error) {
            if (error.name !== 'AbortError') {
              find('[data-tree-feedback]').textContent = error.message;
              find('[data-tree-retry]').hidden = false;
            }
          } finally {
            if (request === fileRequest) { body.removeAttribute('aria-busy'); }
          }
        };
        const openFolder = async (path, focus = '') => {
          window.clearTimeout(fileTimer);
          find('#bp-file-search').value = '';
          await flushSelection().catch(() => {});
          await loadFiles(path, {focus});
        };
        const doSearch = async (continueSearch = false) => {
          const query = find('#bp-file-search').value.trim();
          if (query.length < 2) { if (!query) { loadFiles(); } return; }
          fileRequest?.abort(); fileRequest = new AbortController();
          if (!continueSearch) { searchToken = ''; }
          retryFiles = () => doSearch(continueSearch);
          find('[data-tree-retry]').hidden = true;
          find('[data-tree-feedback]').textContent = bucketpilotUI.t('Searching permitted nested folders…');
          try {
            const result = await read('search', {q: query, token: searchToken}, fileRequest.signal);
            if (find('#bp-file-search').value.trim() !== query) { return; }
            searchToken = result.token;
            find('.bp-tree-scroll').classList.add('bp-tree-search-results');
            const body = find('[data-source-rows]'); body.replaceChildren();
            result.entries.forEach((entry) => body.append(sourceRow(entry, 0, true)));
            find('[data-tree-previous]').hidden = true;
            find('[data-tree-more]').hidden = true;
            find('[data-search-more]').hidden = result.done;
            find('.bp-tree-scroll').scrollTop = 0;
            const count = bucketpilotUI.t(result.entries.length === 1 ? '@count match' : '@count matches', {'@count': result.entries.length});
            const searchStatus = result.limited ? bucketpilotUI.t('Search limit reached. More matches may exist.') : (result.done ? '' : bucketpilotUI.t('Search more folders to continue.'));
            find('[data-tree-feedback]').textContent = [count, searchStatus].filter(Boolean).join(' · ');
            if (result.skipped) { find('[data-tree-feedback]').textContent += ` ${result.skipped} ${bucketpilotUI.t('unavailable folders skipped')}.`; }
            if (!result.entries.length) { body.append(node('tr')); const cell = node('td', bucketpilotUI.t(result.done ? 'No matching files or folders.' : 'No matches yet.')); cell.colSpan = 3; body.lastChild.append(cell); }
            syncTree();
          }
          catch (error) { if (error.name !== 'AbortError') { find('[data-tree-feedback]').textContent = error.message; find('[data-tree-retry]').hidden = false; } }
        };
        const loadBuckets = async (page = 0) => {
          bucketRequest?.abort(); bucketRequest = new AbortController();
          find('[data-buckets-count]').textContent = bucketpilotUI.t('Loading…');
          try {
            const data = await read('buckets', {q: find('#bp-bucket-filter').value, page, size: 10}, bucketRequest.signal);
            bucketPage = data.page; bucketTotal = data.total;
            const body = find('[data-bucket-rows]'); body.replaceChildren();
            data.rows.forEach((bucket) => {
              const row = node('tr'); const choice = document.createElement('input'); choice.type = 'radio'; choice.name = 'bp-destination-bucket'; choice.value = bucket.id;
              choice.checked = chosenBucket === bucket.id; choice.setAttribute('aria-label', bucketpilotUI.t('Select bucket @name', {'@name': bucket.name}));
              choice.disabled = !['aws', 'r2', 'gcs'].includes(bucket.provider);
              choice.addEventListener('change', () => { chosenBucket = bucket.id; });
              const cell = node('td'); cell.append(choice); row.append(cell, node('td', bucket.name)); body.append(row);
            });
            if (!data.rows.length) { const row = node('tr'); const cell = node('td', bucketpilotUI.t('No matching buckets.')); cell.colSpan = 2; row.append(cell); body.append(row); }
            find('[data-buckets-count]').textContent = `${data.total} ${bucketpilotUI.t('buckets')} · ${bucketpilotUI.t('Page')} ${data.page + 1} / ${Math.max(1, Math.ceil(data.total / 10))}`;
            pageButton(find('[data-buckets-previous]'), bucketPage > 0);
            pageButton(find('[data-buckets-next]'), (bucketPage + 1) * 10 < bucketTotal);
          }
          catch (error) { if (error.name !== 'AbortError') { find('[data-buckets-count]').textContent = error.message; } }
        };
        const timingVisibility = () => {
          const frequency = find('#bp-frequency').value;
          find('[data-once-field]').hidden = frequency !== 'once';
          find('[data-weekly-field]').hidden = frequency !== 'weekly';
          find('[data-monthly-field]').hidden = frequency !== 'monthly';
          find('[data-time-field]').hidden = !frequency || frequency === 'now';
          find('#bp-run-date').required = frequency === 'once';
          find('#bp-run-time').required = !!frequency && frequency !== 'now';
          find('#bp-run-time').disabled = !frequency || frequency === 'now';
        };
        const saveTiming = () => { window.clearTimeout(nameTimer); return command('timing', {name: find('#bp-plan-name').value, schedule: {
          frequency: find('#bp-frequency').value, timezone: find('#bp-timezone').value,
          date: find('#bp-run-date').value, time: find('#bp-run-time').value,
          weekday: Number(find('#bp-weekday').value), monthday: Number(find('#bp-monthday').value), automatic: false
        }}); };
        let folderRequest = 0; const createdFolders = new Set();
        const loadFolders = async (prefix = '', page = 0, append = false) => {
          const token = ++folderRequest;
          folderReady = false; find('[data-use-folder]').disabled = true; find('[data-new-folder]').disabled = true;
          find('[data-folder-back]').disabled = true;
          find('[data-folders-feedback]').textContent = '';
          find('[data-folder-list]').setAttribute('aria-busy', 'true'); find('#bp-folder-search').disabled = true;
          if (!append) { const skeleton = node('div', '', 'bp-folder-skeleton'); skeleton.setAttribute('aria-hidden', 'true'); find('[data-folder-list]').replaceChildren(skeleton); }
          try {
            const result = await read('folders', {prefix, page});
            if (token !== folderRequest) { return; }
            folderPage = page; folderPrefix = prefix; folderReady = !!result.available || createdFolders.has(prefix);
            find('[data-new-folder]').disabled = false; find('[data-use-folder]').disabled = !folderReady;
            find('[data-folder-back]').disabled = prefix === '';
            find('[data-current-folder]').textContent = `${draft.data.bucket.name} / ${prefix || bucketpilotUI.t('Top level')}`;
            if (!append) { find('#bp-folder-search').value = ''; }
            const list = find('[data-folder-list]'); if (!append) { list.replaceChildren(); }
            result.folders.forEach((folder) => {
              if ([...list.children].some((item) => item.dataset.folder === folder)) { return; }
              const item = node('div', undefined, 'bp-folder-row'); item.dataset.folder = folder;
              item.classList.toggle('bp-folder-selected', folder === browserChoice);
              const open = button(folder.split('/').pop(), () => loadFolders(folder), 'bp-entry-name bp-entry-name--folder');
              item.append(open); list.append(item);
            });
            const crumbs = find('[data-folder-breadcrumbs]'); crumbs.replaceChildren(button(draft.data.bucket.name, () => loadFolders()));
            const parts = prefix ? prefix.split('/') : [];
            parts.forEach((part, index) => { crumbs.append(node('span', '/'), button(part, () => loadFolders(parts.slice(0, index + 1).join('/')))); });
            crumbs.lastElementChild.setAttribute('aria-current', 'location');
            find('[data-folders-feedback]').textContent = result.message + (!result.folders.length && !result.more ? ` ${bucketpilotUI.t('No folders are listed here. Create a folder, or cancel and use manual entry.')}` : '');
            find('[data-folders-more]').hidden = !result.more;
            folderSearch();
          }
          catch (error) {
            if (token !== folderRequest) { return; }
            folderPrefix = prefix; folderPage = page;
            find('[data-folder-list]').replaceChildren(button(bucketpilotUI.t('Retry folder listing'), () => loadFolders(prefix)));
            find('[data-folders-feedback]').textContent = `${error.message} ${bucketpilotUI.t('Cancel and choose manual entry to continue.')}`;
          }
          finally { if (token === folderRequest) { find('[data-folder-list]').removeAttribute('aria-busy'); find('#bp-folder-search').disabled = false; } }
        };
        const resetLocal = () => {
          window.clearTimeout(fileTimer); window.clearTimeout(bucketTimer); window.clearTimeout(timingTimer); window.clearTimeout(nameTimer); window.clearTimeout(pathTimer);
          find('#bp-file-search').value = ''; find('#bp-bucket-filter').value = ''; find('#bp-new-folder-name').value = ''; find('#bp-folder-search').value = '';
          chosenBucket = ''; editingBucket = false; editingPath = false; nameDirty = false; nameSaveError = false; timingDirty = false; pathDirty = false; bucketDirty = false;
          currentPath = ''; searchToken = ''; folderPrefix = ''; folderPage = 0; folderRequest++; destinationCheck++; createdFolders.clear();
          find('[data-folder-browser]').close(); browserChoice = null; destinationMode = ''; pathAvailable = true; find('[data-folder-list]').replaceChildren();
          timeTouched = !!config().editing || !!draft.data._frequency_chosen; find('[data-schedule-error]').hidden = true;
          renderDraft(true);
          ['name', 'bucket', 'path', 'selection', 'schedule'].forEach((step) => { find(`[data-step-${step}]`).open = false; });
          loadFiles(''); loadBuckets(0);
        };
        const loadDraft = async () => {
          if (pumping) { showError(new Error(bucketpilotUI.t('Wait for the current save to finish.'))); return; }
          try {
            draft = await read('state'); optimistic = structuredClone(draft.data.rules);
            blocked = false; queue = []; selectionBatch = []; errorBox.hidden = true;
            nameDirty = false; nameSaveError = false; timingDirty = false; pathDirty = false; bucketDirty = false;
            timeTouched = !!config().editing || !!draft.data._frequency_chosen; find('[data-schedule-error]').hidden = true;
            feedback.textContent = bucketpilotUI.t('Settings loaded'); renderDraft(true); checkDestination();
            root.querySelectorAll('details').forEach((step) => { step.open = false; });
            await loadFiles(''); loadBuckets();

          }
          catch (error) { showError(error); feedback.textContent = bucketpilotUI.t('Draft unavailable'); }
        };
        find('[data-reload-draft]').addEventListener('click', async (event) => { const control = event.currentTarget; if ((!queue.length && !config().editing) || await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t('Reload saved settings and discard draft changes?'), {label: bucketpilotUI.t('Reload'), destructive: false})) { bucketpilotUI.bucketpilotRefresh.run(control, async () => { if (config().editing) { await flushSelection(); await command('reset', {confirmed: true}); } await loadDraft(); }); } });
        find('[data-file-search]').addEventListener('submit', (event) => { event.preventDefault(); doSearch(); });
        find('#bp-file-search').addEventListener('input', () => { window.clearTimeout(fileTimer); fileTimer = window.setTimeout(() => doSearch(), 550); });
        find('[data-clear-search]').addEventListener('click', () => openFolder(currentPath));
        find('[data-tree-home]').addEventListener('click', () => openFolder('', currentPath.split('/')[0]));
        find('[data-tree-back]').addEventListener('click', () => openFolder(parentFolder(currentPath), currentPath));
        find('[data-tree-previous]').addEventListener('click', () => loadFiles(currentPath, {offset: previousFiles}));
        find('[data-tree-more]').addEventListener('click', () => loadFiles(currentPath, {offset: nextFiles, append: true}));
        find('[data-search-more]').addEventListener('click', () => doSearch(true));
        find('[data-tree-retry]').addEventListener('click', () => retryFiles());
        find('[data-bucket-search]').addEventListener('submit', (event) => { event.preventDefault(); loadBuckets(0); });
        find('#bp-bucket-filter').addEventListener('input', () => { window.clearTimeout(bucketTimer); bucketTimer = window.setTimeout(() => loadBuckets(0), 400); });
        find('[data-buckets-previous]').addEventListener('click', () => loadBuckets(bucketPage - 1));
        find('[data-buckets-next]').addEventListener('click', () => loadBuckets(bucketPage + 1));
        find('[data-change-bucket]').addEventListener('click', () => { editingBucket = true; find('[data-bucket-editor]').hidden = false; find('[data-bucket-card]').hidden = true; find('#bp-bucket-filter').focus(); loadBuckets(); });
        const persistPath = async () => {
          window.clearTimeout(pathTimer);
          if (!draft?.data.bucket || !destinationMode || (destinationMode === 'browser' && browserChoice === null)) { return; }
          const prefix = destinationMode === 'root' ? '' : destinationMode === 'manual' ? find('#bp-destination-path').value : browserChoice;
          if (destinationMode === 'manual' && !prefix.trim()) { return; }
          await command('path', {prefix, mode: destinationMode === 'root' ? 'manual' : destinationMode}); renderDraft(); checkDestination();
        };
        find('[data-path-form]').addEventListener('submit', (event) => { event.preventDefault(); persistPath().catch(() => {}); });
        find('[data-change-path]').addEventListener('click', () => { editingPath = true; renderDraft(); });
        root.querySelectorAll('[name="bp-destination-mode"]').forEach((radio) => radio.addEventListener('change', async () => {
          const previous = destinationMode; const mode = radio.value;
          if (mode === 'root' && draft.data.prefix_saved && draft.data.prefix && !await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t('Switch to the bucket root? This replaces the selected folder “@path”.', {'@path': draft.data.prefix}), {label: bucketpilotUI.t('Use bucket root')})) { destinationMode = previous; renderDestinationMode(); return; }
          destinationMode = mode; pathVersion++; pathDirty = true; editingPath = true;
          if (mode === 'root') { find('#bp-destination-path').value = ''; }
          if (mode === 'browser') { browserChoice = draft.data.destination_mode === 'browser' && draft.data.prefix_saved ? draft.data.prefix : null; }
          renderDestinationMode(); renderSelection();
          if (mode === 'root' || (mode === 'manual' && find('#bp-destination-path').value.trim()) || (mode === 'browser' && browserChoice !== null)) { persistPath().catch(() => {}); }
        }));
        find('[data-browse-folders]').addEventListener('click', () => {
          if (!draft.data.bucket) { return; }
          find('[data-folder-bucket]').textContent = draft.data.bucket.name;
          find('[data-folder-browser]').showModal(); loadFolders(''); checkDestination();
        });
        const closeBrowser = () => { folderRequest++; find('[data-folder-browser]').close(); };
        find('[data-close-browser]').addEventListener('click', closeBrowser);
        find('[data-cancel-browser]').addEventListener('click', closeBrowser);
        find('[data-folder-browser]').addEventListener('cancel', () => { folderRequest++; });
        find('[data-folder-back]').addEventListener('click', () => loadFolders(folderPrefix.includes('/') ? folderPrefix.slice(0, folderPrefix.lastIndexOf('/')) : ''));
        const folderSearch = () => {
          const query = find('#bp-folder-search').value.toLocaleLowerCase();
          find('[data-folder-list]').querySelectorAll('[data-folder]').forEach((row) => { row.hidden = !row.dataset.folder.toLocaleLowerCase().includes(query); });
        };
        find('#bp-folder-search').addEventListener('input', folderSearch);
        find('[data-clear-folder-search]').addEventListener('click', () => { find('#bp-folder-search').value = ''; folderSearch(); });
        find('[data-use-folder]').addEventListener('click', () => { if (!folderReady) { return; } browserChoice = folderPrefix; pathVersion++; pathDirty = true; closeBrowser(); renderDestinationMode(); renderSelection(); persistPath().catch(() => {}); });
        const closeNewFolder = () => { if (creatingFolder) { return; } find('[data-folder-dialog]').close(); find('[data-folder-browser]').showModal(); find('[data-new-folder]').focus(); };
        find('[data-new-folder]').addEventListener('click', () => {
          if (find('[data-new-folder]').disabled) { return; }
          find('#bp-new-folder-name').value = ''; find('[data-new-folder-error]').textContent = '';
          find('[data-new-folder-parent]').textContent = `${draft.data.bucket.name} / ${folderPrefix || bucketpilotUI.t('Bucket root')}`;
          find('[data-folder-browser]').close(); find('[data-folder-dialog]').showModal(); find('#bp-new-folder-name').focus();
        });
        find('[data-cancel-folder]').addEventListener('click', closeNewFolder); find('[data-close-new-folder]').addEventListener('click', closeNewFolder);
        find('[data-folder-dialog]').addEventListener('cancel', (event) => { event.preventDefault(); closeNewFolder(); });
        find('[data-new-folder-form]').addEventListener('submit', async (event) => {
          event.preventDefault(); if (creatingFolder) { return; } creatingFolder = true; const submit = event.submitter; submit.disabled = true;
          find('[data-new-folder-error]').textContent = ''; find('[data-new-folder-form]').setAttribute('aria-busy', 'true');
          find('#bp-new-folder-name').readOnly = true; find('[data-cancel-folder]').disabled = true; find('[data-close-new-folder]').disabled = true;
          try {
            const parent = folderPrefix;
            const response = await command('folder', {name: find('#bp-new-folder-name').value, parent, confirmed: true});
            const created = response.created_folder; if (created) { createdFolders.add(created); }
            find('[data-folder-dialog]').close(); find('[data-folder-browser]').showModal(); await loadFolders(parent);
            if (created && folderPrefix === parent && find('[data-folder-browser]').open) {
              const list = find('[data-folder-list]');
              if (![...list.children].some((row) => row.dataset.folder === created)) {
                const row = node('div', undefined, 'bp-folder-row bp-folder-selected'); row.dataset.folder = created;
                row.append(button(`${created.split('/').pop()} (${bucketpilotUI.t('Created just now')})`, () => loadFolders(created), 'bp-entry-name bp-entry-name--folder')); list.prepend(row);
              }
              find('[data-folders-feedback]').textContent = bucketpilotUI.t('Folder created here. Open it to select it.');
            }
          }
          catch (error) { find('[data-new-folder-error]').textContent = error.message; }
          finally { creatingFolder = false; submit.disabled = false; find('[data-new-folder-form]').removeAttribute('aria-busy'); find('#bp-new-folder-name').readOnly = false; find('[data-cancel-folder]').disabled = false; find('[data-close-new-folder]').disabled = false; }
        });
        find('[data-clear-bucket-search]').addEventListener('click', () => { window.clearTimeout(bucketTimer); find('#bp-bucket-filter').value = ''; loadBuckets(0); });
        find('#bp-destination-path').addEventListener('input', () => { pathVersion++; pathDirty = true; editingPath = true; renderSelection(); window.clearTimeout(pathTimer); pathTimer = window.setTimeout(() => persistPath().catch(() => {}), 450); });
        find('[data-bucket-rows]').addEventListener('change', async () => { bucketDirty = true; renderSelection(); try { await command('bucket', {id: chosenBucket}); editingBucket = false; renderDraft(); } catch {} });
        find('[data-clear-all]').addEventListener('click', async () => {
          if (committing || !await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t('Reset the entire current draft? Saved plans, queued backups and connection settings will remain.'), {label: bucketpilotUI.t('Reset draft'), destructive: true})) { return; }
          window.clearTimeout(timingTimer); window.clearTimeout(nameTimer); window.clearTimeout(pathTimer);
          try { await flushSelection(); await command('reset', {confirmed: true}); resetLocal(); } catch {}
        });
        find('[data-folders-more]').addEventListener('click', () => loadFolders(folderPrefix, folderPage + 1, true));
        find('[data-clear-selection]').addEventListener('click', async () => { if (await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t('Clear all saved inclusions and exclusions?'), {label: bucketpilotUI.t('Clear selection'), destructive: true})) { try { await flushSelection(); await command('clear', {confirmed: true}); } catch {} } });
        find('#bp-plan-name').addEventListener('input', () => {
          nameVersion++; nameDirty = true; nameSaveError = false; renderSelection(); window.clearTimeout(nameTimer);
          const name = find('#bp-plan-name').value;
          if (!name.trim()) { find('[data-name-state]').textContent = bucketpilotUI.t('Required · enter a backup name'); return; }
          nameTimer = window.setTimeout(async () => { try { await command('name', {name}); if (timingDirty && timingControlsValid()) { await saveTiming(); } } catch {} }, 500);
        });
        const timingChanged = () => {
          find('[data-schedule-error]').hidden = true;
          timingVersion++; timingDirty = true; timingVisibility(); renderSelection(); window.clearTimeout(timingTimer);
          if (timingControlsValid()) { timingTimer = window.setTimeout(() => saveTiming().catch(() => {}), 450); }
        };
        find('[data-schedule-form]').addEventListener('input', timingChanged);
        find('[data-schedule-form]').addEventListener('change', timingChanged);
        find('#bp-run-time').addEventListener('input', () => { timeTouched = true; });
        find('#bp-timezone').addEventListener('change', () => { if (!config().editing && !timeTouched) { find('#bp-run-time').value = currentTime(find('#bp-timezone').value); } });
        find('#bp-frequency').addEventListener('change', timingVisibility);
        find('[data-schedule-form]').addEventListener('submit', (event) => { event.preventDefault(); saveTiming().catch(() => {}); });
        find('[data-review-builder]').addEventListener('click', async () => {
          try {
            await flushSelection();
            if (nameDirty || timingDirty || pathDirty || bucketDirty || queue.length || pumping) { return; }
            const content = find('[data-review-content]'); const data = draft.data; content.replaceChildren();
            const hero = node('div', null, 'bp-detail-hero'); hero.append(node('h3', data.name), statusBadge('draft', bucketpilotUI.t('Draft'))); content.append(hero);
            const section = (heading, fields) => {
              const group = node('section', null, 'bp-detail-section'); group.append(node('h3', heading));
              const list = node('dl', null, 'bp-detail-grid');
              fields.forEach(([label, value]) => { const pair = node('div'); pair.append(node('dt', label), node('dd', value)); list.append(pair); });
              group.append(list); content.append(group);
            };
            section(bucketpilotUI.t('Destination'), [[bucketpilotUI.t('Bucket'), data.bucket.name], [bucketpilotUI.t('Folder'), data.prefix || '/'], [bucketpilotUI.t('Backup folder preview (UTC)'), find('[data-destination-preview]').textContent]]);
            section(bucketpilotUI.t('Schedule'), [[bucketpilotUI.t('Frequency'), scheduleText(data.schedule)], [bucketpilotUI.t('Timezone'), data.schedule.timezone]]);
            const sources = node('section', null, 'bp-detail-section');
            sources.append(node('h3', bucketpilotUI.t('Sources')));
            sources.append(sourceList(data.rules)); content.append(sources);
            find('[data-commit-builder]').textContent = config().editing ? bucketpilotUI.t('Save changes') : data.schedule.frequency === 'now' ? bucketpilotUI.t('Queue backup now') : bucketpilotUI.t('Save backup schedule');
            find('[data-review-dialog]').showModal();
          }
          catch {}
        });
        ['[data-review-back]', '[data-review-close]'].forEach((selector) => find(selector).addEventListener('click', () => find('[data-review-dialog]').close()));
        const commitSuccess = (response) => {
          find('[data-review-dialog]').close();
            if (response.submission) {
              const url = new URL(config().schedules, location.origin); if (response.submission.plan_id) { url.searchParams.set('saved', response.submission.plan_id); }
              bucketpilotUI.bucketpilotNotice.afterNavigation(bucketpilotUI.t('Saved successfully.'), url);
              resetLocal(); window.location.assign(url); return;
            }
            else {
              if (response.schedule_saved) {
                const url = new URL(config().schedules, location.origin);
                url.searchParams.set('saved', response.schedule_saved.id);
                bucketpilotUI.bucketpilotNotice.afterNavigation(config().editing ? bucketpilotUI.t('Backup plan updated successfully.') : bucketpilotUI.t('Backup schedule saved successfully.'), url);
                resetLocal(); window.location.assign(url); return;
              }
            }
        };
        find('[data-commit-builder]').addEventListener('click', async (event) => {
          if (committing) { return; }
          window.clearTimeout(timingTimer); window.clearTimeout(nameTimer); window.clearTimeout(pathTimer);
          committing = true; event.target.disabled = true; renderSelection();
          try {
            await command('commit', {});
          }
          catch { find('[data-review-dialog]').close(); }
          finally { committing = false; event.target.disabled = false; renderSelection(); }
        });
        const refreshConnection = async () => {
          if (!draft || connectionRefreshing) { return; }
          connectionRefreshing = true; contextVersion++; blocked = true; root.inert = true; root.setAttribute('aria-busy', 'true');
          window.clearTimeout(nameTimer); window.clearTimeout(timingTimer); window.clearTimeout(pathTimer); window.clearTimeout(selectionTimer); window.clearTimeout(fileTimer); window.clearTimeout(bucketTimer);
          fileRequest?.abort(); bucketRequest?.abort(); folderRequest++; destinationCheck++;
          queue.forEach((task) => task.reject(new Error(bucketpilotUI.t('Connection changed. The draft was cleared.'))));
          queue = []; selectionBatch = []; optimistic = []; nameDirty = false;
          root.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
          root.querySelectorAll('input:not([type="radio"]):not([type="checkbox"])').forEach((input) => { input.value = ''; });
          root.querySelectorAll('[data-source-path]').forEach((input) => { input.checked = false; input.indeterminate = false; });
          find('[data-selection-list]').replaceChildren(); find('[data-review-builder]').disabled = true;
          try {
            if (config().editing) { window.location.assign(config().schedules); return; }
            draft = await read('state'); blocked = false; resetLocal();
            feedback.textContent = bucketpilotUI.t('Connection changed. All backup draft fields were cleared.');
          }
          catch (error) { showError(error); }
          finally { connectionRefreshing = false; root.inert = false; root.removeAttribute('aria-busy'); }
        };
        window.addEventListener('bucketpilot:connection-change', (event) => { if (Number(event.detail.generation) > Number(draft?.connection_generation ?? -1)) { refreshConnection(); } });
        const checkConnection = async () => {
          if (!draft || document.hidden || connectionRefreshing) { return; }
          try {
            const result = await read('connection', {}, undefined, true);
            if (Number(result.generation) !== Number(draft.connection_generation)) { await refreshConnection(); }
          } catch {}
        };
        window.addEventListener('focus', checkConnection);
        const connectionTimer = window.setInterval(checkConnection, 15000);
        window.addEventListener('pagehide', () => window.clearInterval(connectionTimer), {once: true});
        window.addEventListener('beforeunload', (event) => { if (!config().editing && (queue.length || selectionBatch.length || nameDirty)) { event.preventDefault(); event.returnValue = ''; } });
        const openStep = (step) => {
          if (step.hasAttribute('data-step-path') && (!draft?.data.bucket || bucketDirty)) { return; }
          root.querySelectorAll('.bp-config-panel > details').forEach((other) => { other.open = other === step; });
        };
        root.querySelectorAll('.bp-config-panel > details').forEach((step) => {
          step.querySelector('summary').addEventListener('click', (event) => {
            event.preventDefault(); if (step.open) { step.open = false; } else { openStep(step); }
          });
          step.addEventListener('toggle', () => { if (step.open && step.hasAttribute('data-step-path') && (!draft?.data.bucket || bucketDirty)) { step.open = false; return; } if (step.open) { root.querySelectorAll('.bp-config-panel > details').forEach((other) => { if (other !== step && other.open) { other.open = false; } }); } });
        });
        root.querySelectorAll('[data-open-step]').forEach((control) => control.addEventListener('click', () => {
          const step = find(`[data-step-${control.dataset.openStep}]`); openStep(step); step.scrollIntoView({block: 'nearest'});
          if (control.dataset.openStep === 'name') { find('#bp-plan-name').focus(); } else { step.querySelector('summary').focus(); }
        }));
        window.addEventListener('pageshow', (event) => { if (config().editing && event.persisted) { window.location.reload(); } });
        loadDraft();
      });
      once('bucketpilot-records', '[data-bp-records]', context).forEach((root) => {
        const find = (selector) => root.querySelector(selector);
        const mode = root.dataset.mode;
        const query = new URLSearchParams(window.location.search);
        let savedPlan = mode === 'plans' ? query.get('saved') || '' : '';
        if (mode === 'plans' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(query.get('q') || '')) {
          savedPlan = savedPlan || query.get('q'); query.delete('q');
        }
        query.delete('plan');
        const initialAddress = new URL(window.location.href); initialAddress.searchParams.delete('plan'); if (savedPlan) { initialAddress.searchParams.set('saved', savedPlan); if (!query.has('q')) { initialAddress.searchParams.delete('q'); } } bucketpilotUI.replaceAddress(initialAddress);
        let page = 0; let request; let timer; let operationPending = false; let lastResponse = null; let rowCache = new Map(); let pollFailures = 0;
        const fail = (error) => { const box = find('[data-record-error]'); box.hidden = false; box.textContent = error.message; };
        const cell = (row, text) => { const element = node('td', text); row.append(element); return element; };
        let detailTarget; let detailRequest = false; let detailSignature = '';
        const details = async (id, isRun = false, silent = false) => {
          if (detailRequest) { return; } detailRequest = true;
          try {
            const item = await read(isRun ? 'run' : 'plan', {id}, undefined, silent);
            if (silent && !find('[data-plan-dialog]').open) { return; }
            const signature = JSON.stringify(item);
            if (silent && signature === detailSignature) { return; }
            detailTarget = {id, isRun}; detailSignature = signature;
            const scroll = find('[data-plan-detail]').scrollTop;
            const data = item.data; const content = find('[data-plan-detail]'); content.replaceChildren();
            find('#bp-plan-detail-title').textContent = isRun ? bucketpilotUI.t('Run details') : bucketpilotUI.t('Plan details');
            const hero = node('div', null, 'bp-detail-hero');
            hero.append(node('h3', item.name || item.plan_name || bucketpilotUI.t('Backup')), statusBadge(item.status));
            content.append(hero);
            if (item.waiting) {
              const waiting = node('div', null, 'bp-notice');
              const message = node('div'); message.append(node('strong', item.waiting.label), node('p', item.waiting.message)); waiting.append(message); content.append(waiting);
              if (Number(item.next_attempt) > Date.now() / 1000 && item.status === 'pending') { content.append(node('p', `${bucketpilotUI.t('Next retry check')}: ${stamp(item.next_attempt)}`, 'bp-muted')); }
            }
            if (item.error) { content.append(node('p', item.error, 'bp-detail-error')); }
            const section = (title) => {
              const element = node('section', null, 'bp-detail-section'); element.append(node('h3', title)); content.append(element); return element;
            };
            const field = (list, label, value) => {
              const pair = node('div'); pair.append(node('dt', label));
              const description = node('dd'); description.append(typeof value === 'string' ? document.createTextNode(value) : value); pair.append(description); list.append(pair);
            };
            const destination = section(bucketpilotUI.t('Destination'));
            const destinationFields = node('dl', null, 'bp-detail-grid');
            field(destinationFields, bucketpilotUI.t('Bucket'), data.bucket.name);
            field(destinationFields, bucketpilotUI.t('Folder'), item.prefix || data.prefix || '/');
            destination.append(destinationFields);
            const timing = section(bucketpilotUI.t('Schedule'));
            const timingFields = node('dl', null, 'bp-detail-grid');
            field(timingFields, bucketpilotUI.t('Frequency'), scheduleText(data.schedule));
            field(timingFields, bucketpilotUI.t('Timezone'), data.schedule.timezone);
            if (!isRun) {
              field(timingFields, bucketpilotUI.t('Next run'), stamp(item.next_run, data.schedule.timezone));
              field(timingFields, bucketpilotUI.t('Last requested run'), stamp(item.last_run, data.schedule.timezone));
              field(timingFields, bucketpilotUI.t('Latest execution'), statusBadge(item.latest_execution?.status || 'not_run', item.latest_execution ? bucketpilotUI.bucketpilotDisplay.status(item.latest_execution.status) : (item.latest_run_id || Number(item.last_run) ? bucketpilotUI.t('History cleared') : bucketpilotUI.t('Not run'))));
            }
            timing.append(timingFields);
            const sources = section(bucketpilotUI.t('Sources'));
            sources.append(sourceList(data.rules));
            if (!find('[data-plan-dialog]').open) { find('[data-plan-dialog]').showModal(); }
            if (silent) { find('[data-plan-detail]').scrollTop = scroll; }
          }
          catch (error) { if (!silent) { fail(error); } }
          finally { detailRequest = false; }
        };
        const planAction = async (plan, operation) => {
          if (operationPending) { return; }
          const description = {pause: 'Pause future runs? Unstarted scheduled requests will be cancelled. Running backups continue.', resume: 'Resume future runs using this plan’s current timing?', run: 'Request an additional backup now? The recurring schedule will remain unchanged.', delete: 'Delete this plan? Existing history and remote backup objects will remain.'};
          if (!await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t(description[operation]), {label: {pause: bucketpilotUI.t('Pause'), resume: bucketpilotUI.t('Resume'), run: bucketpilotUI.t('Run Now'), delete: bucketpilotUI.t('Delete plan')}[operation], destructive: operation === 'delete'}) || operationPending) { return; }
          operationPending = true;
          root.querySelectorAll('.bp-record-actions button').forEach((element) => { element.disabled = true; });
          find('[data-record-feedback]').textContent = bucketpilotUI.t('Saving operation…');
          const requestId = newRequestId();
          const perform = async () => {
            try { await write(`plan_${operation}`, Number(plan.revision), {id: plan.id, confirmed: true}, requestId); await load(); find('[data-record-feedback]').focus({preventScroll: true}); }
            catch (error) { fail(error); find('[data-record-error]').append(button(bucketpilotUI.t('Retry operation'), perform)); }
          };
          try { await perform(); } finally { operationPending = false; root.querySelectorAll('.bp-record-actions button').forEach((element) => { element.disabled = false; }); }
        };
        const edit = (id) => window.location.assign(config().edit.replace('00000000-0000-0000-0000-000000000000', id));
        const load = async (reset = false, silent = false) => {
          if (silent && (request || operationPending || document.hidden)) { return; }
          if (reset) { page = 0; }
          request?.abort(); request = new AbortController();
          const activeRequest = request; const refreshControl = find('[data-record-refresh]');
          if (!silent) {
            refreshControl.disabled = true; refreshControl.setAttribute('aria-busy', 'true');
            find('[data-record-feedback]').textContent = bucketpilotUI.t('Loading records…');
            find('[data-record-error]').hidden = true; root.setAttribute('aria-busy', 'true');
          }
          try {
            const size = Number(find('#bp-record-size').value);
            const filters = {q: find('#bp-record-search').value, status: find('#bp-record-status').value, size, page};
            if (mode === 'plans') { filters.saved = savedPlan; filters.sort = find('#bp-record-sort').value; filters.direction = find('#bp-record-direction').value; }
            if (!silent) {
              const address = new URL(location.href); if (savedPlan) { address.searchParams.set('saved', savedPlan); } else { address.searchParams.delete('saved'); } if (filters.q) { address.searchParams.set('q', filters.q); } else { address.searchParams.delete('q'); }
              bucketpilotUI.replaceAddress(address);
            }
            const data = await read(mode, filters, activeRequest.signal, silent);
            if (activeRequest !== request) { return; }
            pollFailures = 0;
            find('[data-saved-plan-filter]').hidden = !savedPlan;
            find('[data-saved-plan-label]').textContent = savedPlan ? bucketpilotUI.t('Showing saved schedule: @name', {'@name': data.rows[0]?.name || bucketpilotUI.t('Unavailable')}) : '';
            const feedback = find('[data-record-feedback]');
            const explanation = mode === 'plans' ? bucketpilotUI.t('Pending and queued schedules appear first by default, followed by scanning and running schedules. Last five runs are shown oldest to newest.') : bucketpilotUI.t('Times are shown in UTC. Open details for file activity and errors.');
            if (feedback.textContent !== explanation) { feedback.textContent = explanation; }
            const responseSignature = JSON.stringify({data, filters});
            if (responseSignature === lastResponse) { return; }
            page = data.page;
            const body = find('[data-record-rows]'); const nextRows = []; const nextCache = new Map();
            const focused = document.activeElement; const focusedRow = focused?.closest('[data-record-id]')?.dataset.recordId; const focusedLabel = focused?.getAttribute('aria-label');
            data.rows.forEach((item) => {
              const signature = JSON.stringify(item); const cached = rowCache.get(item.id);
              if (cached?.signature === signature) { nextRows.push(cached.row); nextCache.set(item.id, cached); return; }
              const row = node('tr'); row.dataset.recordId = item.id;
              if (mode === 'plans') {
                cell(row, item.name);
                stackedCell(row, item.bucket_label, item.destination);
                const includes = item.config.rules.filter((rule) => rule.include).length;
                const excludes = item.config.rules.length - includes;
                stackedCell(row, `${includes} ${bucketpilotUI.t('included')}`, `${excludes} ${bucketpilotUI.t('excluded')}`);
                const frequency = item.config.schedule.frequency;
                stackedCell(row, frequency === 'now' ? bucketpilotUI.t('Run Now') : bucketpilotUI.bucketpilotDisplay.status(frequency), frequency === 'now' ? bucketpilotUI.t('On demand') : scheduleText(item.config.schedule).slice(frequency.length).trim().replace(/^·\s*/, ''));
                cell(row, stamp(item.next_run, item.config.schedule.timezone));
                cell(row, stamp(item.last_run, item.config.schedule.timezone));
                const status = cell(row); status.append(statusBadge(item.status));
                if (item.pause_reason) { const reasons = {source_changed: 'Select files again and save this plan to use the current backup source.', connection_changed: 'Restore the original API key to continue.', bucket_missing: 'The original bucket is unavailable.', settings_changed: 'Workspace or bucket settings no longer match.', context_unverified: 'Revalidate this plan with its original key.', access_unavailable: 'Original connection permissions are unavailable.', verification_unavailable: 'Connection verification is temporarily unavailable.'}; const message = bucketpilotUI.t(reasons[item.pause_reason] || 'Waiting for the original connection settings.'); status.title = message; status.append(node('span', message, 'visually-hidden')); }
                cell(row).append(recentIndicators(item));
                const actions = cell(row); const group = node('div', undefined, 'bp-record-actions');
                group.append(iconButton(bucketpilotUI.t('Details'), 'details', () => details(item.id)));
                if (item.actions.includes('edit')) { group.append(iconButton(bucketpilotUI.t('Edit'), 'edit', () => edit(item.id))); }
                if (item.actions.includes('run')) { group.append(iconButton(bucketpilotUI.t('Run Now'), 'run', () => planAction(item, 'run'))); }
                if (item.actions.includes('pause')) { group.append(iconButton(bucketpilotUI.t('Pause'), 'pause', () => planAction(item, 'pause'))); }
                if (item.actions.includes('resume')) { group.append(iconButton(bucketpilotUI.t('Resume'), 'resume', () => planAction(item, 'resume'))); }
                group.append(iconButton(bucketpilotUI.t('Delete'), 'delete', () => planAction(item, 'delete'))); actions.append(group);
              }
              else {
                stackedCell(row, item.plan_name, item.id);
                stackedCell(row, item.bucket_label, item.prefix);
                const duration = Number(item.completed) && Number(item.started) ? `${Math.max(0, Number(item.completed) - Number(item.started))} s` : '';
                stackedCell(row, stamp(item.started), [bucketpilotUI.bucketpilotDisplay.status(item.execution_type), duration].filter(Boolean).join(' · '));
                const uploaded = stackedCell(row, bucketpilotUI.formatPlural(Number(item.successful), '1 file', '@count files'), bucketpilotUI.bucketpilotDisplay.bytes(item.uploaded_bytes));
                uploaded.title = `${item.successful} ${bucketpilotUI.t('files uploaded')} · ${item.uploaded_bytes} B`;
                const status = cell(row);
                const emptyRun = item.status === 'completed' && Number(item.successful) === 0;
                status.append(statusBadge(item.status, emptyRun ? bucketpilotUI.t('Finished — no files uploaded') : bucketpilotUI.bucketpilotDisplay.status(item.status)));
                if (emptyRun) { status.append(node('small', Number(item.total_files) === 0 ? bucketpilotUI.t('No eligible files were found.') : bucketpilotUI.t('No discovered files were uploaded.'))); }
                if (item.waiting) { status.append(node('small', item.waiting.label, 'bp-muted')); }
                if (item.error) { status.append(node('small', item.error, 'bp-error-text')); }
                const actions = node('div', undefined, 'bp-record-actions'); cell(row).append(actions);
                if (item.plan_id && !item.has_job) { actions.append(iconButton(bucketpilotUI.t('Request details'), 'details', () => details(item.id, true))); }
                else { actions.append(iconButton(bucketpilotUI.t('View progress'), 'details', null, runUrl(item.id))); }
                if (item.plan_id && ['failed', 'cancelled', 'completed_with_errors'].includes(item.status)) {
                  actions.append(iconButton(bucketpilotUI.t('Retry as new run'), 'retry', async () => {
                    if (!await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t('Create a fresh execution of this saved run configuration? The old record and objects stay unchanged; a new destination is allocated.'), {label: bucketpilotUI.t('Retry as new run'), destructive: false})) { return; }
                    try { await write('retry_run', 0, {id: item.id, confirmed: true}, newRequestId()); await load(); }
                    catch (error) { fail(error); }
                  }));
                }
              }
              nextRows.push(row); nextCache.set(item.id, {signature, row});
            });
            if (!data.rows.length) { const row = node('tr'); const empty = cell(row, mode === 'plans' ? bucketpilotUI.t('No results found. Create a backup plan or adjust the filters.') : (filters.q || filters.status ? bucketpilotUI.t('No backup history matches these filters.') : bucketpilotUI.t('No backup history yet.'))); empty.colSpan = mode === 'plans' ? 9 : 6; nextRows.push(row); }
            const retained = new Set(nextRows);
            [...body.children].forEach((row) => { if (!retained.has(row)) { row.remove(); } });
            nextRows.forEach((row, index) => { if (body.children[index] !== row) { body.insertBefore(row, body.children[index] || null); } });
            if (silent && focusedRow && !focused.isConnected) {
              const replacement = nextRows.find((row) => row.dataset.recordId === focusedRow);
              const control = [...(replacement?.querySelectorAll('[aria-label]') || [])].find((item) => item.getAttribute('aria-label') === focusedLabel);
              (control || find('[data-record-refresh]')).focus({preventScroll: true});
            }
            rowCache = nextCache; lastResponse = responseSignature;
            find('[data-record-count]').textContent = `${data.total} ${bucketpilotUI.t('results')} · ${bucketpilotUI.t('Page')} ${page + 1} / ${Math.max(1, Math.ceil(data.total / size))}`;
            pageButton(find('[data-record-previous]'), page > 0);
            pageButton(find('[data-record-next]'), (page + 1) * size < data.total);

            const address = new URL(window.location.href); address.searchParams.set('q', filters.q); address.searchParams.set('size', size); address.searchParams.set('page', page); address.searchParams.set('status', filters.status); bucketpilotUI.replaceAddress(address);
          }
          catch (error) {
            if (error.name !== 'AbortError') {
              if (!silent) { fail(error); }
              else if (++pollFailures >= 3) { find('[data-record-feedback]').textContent = bucketpilotUI.t('Live updates are temporarily unavailable. Use Refresh data to retry.'); }
            }
          }
          finally {
            if (activeRequest === request) {
              request = null;
              if (!silent) { root.removeAttribute('aria-busy'); refreshControl.disabled = false; refreshControl.removeAttribute('aria-busy'); }
            }
          }
        };
        find('#bp-record-search').value = query.get('q') || '';
        if (['10', '25', '50'].includes(query.get('size'))) { find('#bp-record-size').value = query.get('size'); }
        if ([...find('#bp-record-status').options].some((option) => option.value === query.get('status'))) { find('#bp-record-status').value = query.get('status'); }
        page = Math.max(0, Number(query.get('page')) || 0);
        find('[data-record-filters]').addEventListener('submit', (event) => { event.preventDefault(); load(true); });
        find('#bp-record-search').addEventListener('input', () => { savedPlan = ''; window.clearTimeout(timer); timer = window.setTimeout(() => load(true), 450); });
        find('#bp-record-size').addEventListener('change', () => load(true));
        const setScheduleOrderLabel = () => {
          if (mode !== 'plans') { return; }
          const timeOrder = ['priority', 'created', 'last_run'].includes(find('#bp-record-sort').value);
          const order = find('#bp-record-direction');
          order.options[0].textContent = bucketpilotUI.t(timeOrder ? 'Newest first' : 'Descending');
          order.options[1].textContent = bucketpilotUI.t(timeOrder ? 'Oldest first' : 'Ascending');
        };
        root.querySelectorAll('[data-record-filters] select').forEach((select) => select.addEventListener('change', () => {
          if (select.id === 'bp-record-sort') {
            find('#bp-record-direction').value = ['priority', 'created', 'last_run'].includes(select.value) ? 'desc' : 'asc';
            setScheduleOrderLabel();
          }
          load(true);
        }));
        find('[data-clear-filters]').addEventListener('click', () => { find('[data-record-filters]').reset(); setScheduleOrderLabel(); savedPlan = ''; query.delete('plan'); bucketpilotUI.replaceAddress(window.location.pathname); load(true); });
        find('[data-clear-history]')?.addEventListener('click', async (event) => {
          if (!await bucketpilotUI.bucketpilotConfirm(bucketpilotUI.t('Delete all finished, failed and cancelled backup history? Active jobs, saved plans and remote files will remain.'), {label: bucketpilotUI.t('Delete history'), destructive: true})) { return; }
          event.target.disabled = true; let count = 0;
          try {
            let result;
            do { result = await write('clear_history', 0, {confirmed: true}, newRequestId()); count += result.deleted; } while (result.more);
            await load(true); bucketpilotUI.bucketpilotNotice.show(bucketpilotUI.t('Backup history deleted successfully.')); find('[data-record-feedback]').textContent = bucketpilotUI.t('@count history records deleted. Active jobs and remote files were preserved.', {'@count': count});
          } catch (error) { fail(error); } finally { event.target.disabled = false; }
        });
        find('[data-show-all-plans]').addEventListener('click', () => { savedPlan = ''; load(true); });
        find('[data-record-refresh]').addEventListener('click', () => load());
        find('[data-record-previous]').addEventListener('click', () => { page--; load(); });
        find('[data-record-next]').addEventListener('click', () => { page++; load(); });
        root.querySelectorAll('[data-close-plan]').forEach((control) => control.addEventListener('click', () => find('[data-plan-dialog]').close()));
        const refreshLive = () => {
          if (!root.isConnected || document.hidden || operationPending) { return; }
          load(false, true);
          if (detailTarget && find('[data-plan-dialog]').open) { details(detailTarget.id, detailTarget.isRun, true); }
        };
        let interval = window.setInterval(refreshLive, 2000);
        window.addEventListener('focus', refreshLive);
        document.addEventListener('visibilitychange', refreshLive);
        window.addEventListener('pageshow', (event) => { if (event.persisted) { interval = window.setInterval(refreshLive, 2000); refreshLive(); } });
        window.addEventListener('pagehide', () => window.clearInterval(interval), {once: true});
        load();
      });
    }
  };
})(window.bucketpilotUI, window.bucketpilotOnce, window.bucketpilotSettings);
