(function (bucketpilotUI, once, settings) {
  'use strict';
  bucketpilotUI.behaviors.bucketpilotBackupProgress = {
    attach: function (context) {
      once('bucketpilot-progress', '#bucketpilot-backup-progress', context).forEach(function (element) {
        let timer;
        let failures = 0;
        let polling = false; let finished = false;
        const poll = async function () {
          if (polling || finished) { return; }
          window.clearTimeout(timer);
          if (!element.isConnected || document.hidden) {
            timer = window.setTimeout(poll, 2000);
            return;
          }
          polling = true;
          try {
            const response = await fetch(settings.bucketpilotBackupProgress, {credentials: 'same-origin', cache: 'no-store'});
            if (!response.ok) { throw new Error('Progress unavailable'); }
            const data = await response.json();
            const tone = bucketpilotUI.bucketpilotDisplay.tone(data.status);
            if (element.dataset.bpTone !== tone) { element.dataset.bpTone = tone; }
            const root = element.closest('[data-backup-detail]') || element;
            const text = (selector, value) => { const target = root.querySelector(selector); if (target && target.textContent !== String(value)) { target.textContent = value; } };
            text('[data-progress-summary]', data.headline || data.summary);
            text('[data-progress-technical-summary]', data.summary);
            text('[data-detail-status]', data.status_label || bucketpilotUI.bucketpilotDisplay.status(data.status));
            const badge = root.querySelector('[data-detail-status]');
            if (badge) { badge.dataset.bpTone = tone; badge.dataset.bpStatus = data.status; }
            root.querySelectorAll('[data-progress-value]').forEach((target) => {
              const value = new Intl.NumberFormat(document.documentElement.lang || undefined).format(Number(data[target.dataset.progressValue]));
              if (target.textContent !== value) { target.textContent = value; }
              if (target.dataset.progressValue === 'failed') { target.classList.toggle('has-failures', Number(data.failed) > 0); }
            });
            text('[data-progress-scan]', bucketpilotUI.formatPlural(Number(data.scan_errors), '1 discovery issue', '@count discovery issues'));
            const scan = root.querySelector('[data-progress-scan]'); if (scan) { scan.hidden = Number(data.scan_errors) === 0; }
            text('[data-progress-bytes]', bucketpilotUI.bucketpilotDisplay.bytes(data.processed_bytes));
            root.querySelectorAll('[data-progress-date]').forEach((target) => {
              const stamp = Number(data[target.dataset.progressDate]);
              const value = stamp > 0 ? new Intl.DateTimeFormat(document.documentElement.lang || undefined, {timeZone: settings.bucketpilotBackupTimezone || 'UTC', dateStyle: 'medium', timeStyle: 'short'}).format(new Date(stamp * 1000)) : '—';
              if (target.textContent !== value) { target.textContent = value; }
            });
            text('[data-progress-notice]', data.notice || '');
            const notice = root.querySelector('[data-progress-notice]'); if (notice) { notice.hidden = !data.notice; }
            text('[data-progress-error]', data.error || '');
            const issue = root.querySelector('[data-progress-error]'); if (issue) { issue.hidden = !data.error; }
            const active = ['pending', 'queued', 'scanning', 'running'].includes(data.status);
            root.querySelectorAll('[data-backup-action]').forEach((control) => { control.hidden = control.dataset.backupAction === 'cancel' ? !active : !['failed', 'cancelled'].includes(data.status); });
            const bar = element.querySelector('progress');
            if (data.total_files > 0 && data.status !== 'scanning') {
              const value = Math.min(100, data.processed_files / data.total_files * 100);
              if (!bar.hasAttribute('value') || bar.value !== value) { bar.value = value; }
            }
            else if (bar.hasAttribute('value')) { bar.removeAttribute('value'); }
            bar.hidden = !active && Number(data.total_files) === 0;
            text('[data-progress-feedback]', '');
            failures = 0;
            if (!['pending', 'queued', 'scanning', 'running'].includes(data.status)) { finished = true; return; }
          }
          catch (error) {
            failures += 1;
            element.querySelector('[data-progress-feedback]').textContent = failures >= 5 ? bucketpilotUI.t('Live updates paused. Reload this page to retry; background processing continues independently.') : bucketpilotUI.t('Progress temporarily unavailable. Retrying…');
            if (failures >= 5) { return; }
          }
          finally { polling = false; }
          timer = window.setTimeout(poll, 2000);
        };
        timer = window.setTimeout(poll, 2000);
        window.addEventListener('focus', poll);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); } });
        window.addEventListener('pageshow', (event) => { if (event.persisted) { poll(); } });
        window.addEventListener('pagehide', function () { window.clearTimeout(timer); }, {once: true});
      });
    }
  };
})(window.bucketpilotUI, window.bucketpilotOnce, window.bucketpilotSettings);
