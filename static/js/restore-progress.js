(function (bucketpilotUI, once, settings) {
  'use strict';

  async function json(url, options = {}) {
    const response = await fetch(url, {...options, cache: 'no-store', headers: {Accept: 'application/json'}});
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Object.keys(result).length) {
      throw new Error(result.error || 'The restore request could not be loaded. Try again.');
    }
    return result;
  }

  bucketpilotUI.behaviors.bucketpilotRestorePageSize = {
    attach(context) {
      once('bucketpilot-restore-page-size', '[data-restore-page-size]', context).forEach((size) => {
        size.addEventListener('change', () => size.form.requestSubmit());
      });
    },
  };

  bucketpilotUI.behaviors.bucketpilotRestoreReview = {
    attach(context) {
      once('bucketpilot-restore-review', '[data-restore-dialog]', context).forEach((dialog) => {
        const find = (selector) => dialog.querySelector(selector);
        const form = find('form');
        const submit = find('button[type="submit"]');
        const loading = find('[data-restore-loading]');
        const review = find('[data-restore-review]');
        const error = find('[data-restore-dialog-error]');
        const reason = form.elements.namedItem('reason');
        const closeButtons = dialog.querySelectorAll('[data-close-restore]');
        let controller;
        let trigger;
        let url;
        let pending = false;

        function showError(message) {
          error.textContent = message;
          error.hidden = false;
        }

        for (const button of document.querySelectorAll('[data-open-restore]')) {
          button.addEventListener('click', async () => {
            controller?.abort();
            const request = new AbortController();
            controller = request;
            trigger = button;
            url = new URL(button.dataset.openRestore, window.location.origin);
            form.reset();
            const mode = url.searchParams.get('mode') || 'backup';
            find('[data-restore-title]').textContent = mode === 'file' ? 'Restore file' : 'Restore backup';
            find('[data-restore-name]').textContent = '';
            form.elements.namedItem('mode').value = mode;
            form.elements.namedItem('file').value = url.searchParams.get('file') || '';
            loading.hidden = false;
            review.hidden = error.hidden = true;
            submit.disabled = true;
            dialog.showModal();
            try {
              const result = await json(url, {signal: request.signal});
              if (controller !== request || !dialog.open) { return; }
              find('[data-restore-name]').textContent = result.name;
              find('[data-restore-bucket]').textContent = result.bucket;
              find('[data-restore-key]').textContent = result.object_key;
              find('[data-restore-target]').textContent = result.source_path ? result.root + '/' + result.source_path : result.root;
              find('[data-restore-scope]').textContent =
                bucketpilotUI.formatPlural(result.total, '@count confirmed file', '@count confirmed files');
              const excluded = find('[data-restore-excluded]');
              excluded.hidden = !result.excluded;
              excluded.textContent = bucketpilotUI.formatPlural(result.excluded, '@count unconfirmed upload is excluded.',
                '@count unconfirmed uploads are excluded.');
              review.hidden = false;
              submit.disabled = false;
              reason.focus();
            } catch (issue) {
              if (controller === request && issue.name !== 'AbortError') { showError(issue.message); }
            } finally {
              if (controller === request) { loading.hidden = true; }
            }
          });
        }

        closeButtons.forEach((button) => button.addEventListener('click', () => dialog.close()));
        dialog.addEventListener('cancel', (event) => { if (pending) { event.preventDefault(); } });
        dialog.addEventListener('close', () => {
          controller?.abort();
          trigger?.focus();
        });
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (submit.disabled || pending) { return; }
          reason.value = reason.value.trim();
          if (!form.reportValidity()) { return; }
          pending = true;
          error.hidden = true;
          submit.disabled = true;
          closeButtons.forEach((button) => { button.disabled = true; });
          submit.textContent = 'Queuing restore…';
          try {
            const result = await json(url, {method: 'POST', body: new FormData(form)});
            window.location.assign(result.url);
          } catch (issue) {
            showError(issue.message);
            pending = false;
            submit.disabled = false;
            closeButtons.forEach((button) => { button.disabled = false; });
            submit.textContent = 'Start restore';
          }
        });
      });
    },
  };

  const phaseLabels = {
    waiting: 'Waiting for the worker',
    preparing: 'Preparing the file list',
    checking: 'Checking the backup files',
    downloading: 'Downloading from the bucket',
    verifying: 'Verifying file contents',
    saving: 'Writing to the filestore',
    retrying: 'Waiting to retry',
  };

  function resultsTable(files, items) {
    files.replaceChildren(...items.map((item) => {
      const row = document.createElement('tr');
      for (const path of [item.object_key, item.source_path]) {
        const code = document.createElement('code');
        code.textContent = path;
        row.insertCell().append(code);
      }
      const badge = document.createElement('span');
      badge.className = 'bp-restore-badge';
      badge.dataset.state = item.state;
      badge.textContent = item.label;
      row.insertCell().append(badge);
      const details = row.insertCell();
      details.textContent = item.error || '—';
      if (item.created_folders.length) {
        const folders = document.createElement('div');
        folders.className = 'bp-restore-secondary';
        folders.textContent = 'Created ' + item.created_folders.join(', ');
        details.append(folders);
      }
      return row;
    }));
  }

  bucketpilotUI.behaviors.bucketpilotRestoreProgress = {
    attach(context) {
      once('bucketpilot-restore-progress', '[data-bp-restore][data-active="yes"]', context).forEach((root) => {
        const progress = root.querySelector('progress');
        const card = root.querySelector('.bp-restore-progress');
        const feedback = root.querySelector('[data-restore-feedback]');
        const files = root.querySelector('[data-restore-files]');
        let signature;
        const refresh = async () => {
          if (!root.isConnected) { return; }
          try {
            const report = await json(settings.bucketpilotRestore);
            card.dataset.state = report.state;
            progress.value = report.percentage;
            root.querySelector('[data-restore-percent]').textContent = Math.floor(report.percentage) + '%';
            root.querySelector('[data-restore-phase]').textContent = phaseLabels[report.phase] || report.label;
            root.querySelector('[data-restore-count]').textContent = report.phase === 'preparing'
              ? `${report.prepared} of ${report.total} files prepared`
              : `${report.processed} of ${report.total} files checked`;
            const display = bucketpilotUI.bucketpilotDisplay;
            root.querySelector('[data-restore-transfer]').textContent = report.phase === 'downloading' && report.expected
              ? `${display.bytes(report.received)} / ${display.bytes(report.expected)}` : '';
            root.querySelectorAll('[data-restore-text]').forEach((element) => {
              const field = element.dataset.restoreText;
              const value = report[field];
              element.textContent = value;
              if (field === 'label') { element.dataset.state = report.state; }
              if (field === 'error' || field === 'current_path') { element.hidden = !value; }
            });
            const nextSignature = JSON.stringify(report.items);
            if (report.items.length && nextSignature !== signature) {
              resultsTable(files, report.items);
              signature = nextSignature;
            }
            feedback.hidden = true;
            if (!report.active) {
              root.dataset.active = 'no';
              root.querySelector('[data-restore-retry]').hidden = !['failed', 'completed_with_issues'].includes(report.state);
              return;
            }
          } catch {
            feedback.textContent = 'Could not refresh progress. Retrying…';
            feedback.hidden = false;
          }
          window.setTimeout(refresh, 1250);
        };
        refresh();
      });
    },
  };
})(window.bucketpilotUI, window.bucketpilotOnce, window.bucketpilotSettings);
