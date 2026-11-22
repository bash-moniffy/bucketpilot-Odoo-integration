(function (bucketpilotUI, once, settings) {
  'use strict';
  bucketpilotUI.bucketpilotDisplay = {
    value(value) { return value === null || value === undefined || value === '' ? '—' : value === false ? bucketpilotUI.t('No') : value === true ? bucketpilotUI.t('Yes') : String(value); },
    tone(value) { return settings.bucketpilotDisplay?.tones[value] || 'neutral'; },
    bytes(value) {
      const bytes = Number(value); if (value === null || value === undefined || value === '' || !Number.isFinite(bytes) || bytes < 0) { return '—'; }
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; const index = bytes ? Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1000)))) : 0;
      return `${new Intl.NumberFormat(document.documentElement.lang || undefined, {maximumFractionDigits: index ? 1 : 0}).format(bytes / (1000 ** index))} ${units[index]}`;
    },
    status(value) { if (value === 'not_applicable' || value === 'not_indexed') { return bucketpilotUI.t('Not indexed'); } const text = this.value(value).replaceAll('_', ' '); return text.replace(/^./, (letter) => letter.toUpperCase()); }
  };
  bucketpilotUI.bucketpilotRefresh = {
    async run(control, operation) {
      if (control.disabled) { return; }
      control.disabled = true; control.setAttribute('aria-busy', 'true');
      try { return await operation(); }
      finally { control.disabled = false; control.removeAttribute('aria-busy'); }
    }
  };
  bucketpilotUI.behaviors.bucketpilotTables = {
    attach(context) {
      once('bp-table-ui', '.bucketpilot-ui', context).forEach((root) => {
        const canvas = document.createElement('canvas'); const measure = canvas.getContext('2d');
        const values = new WeakMap();
        const ruler = document.createElement('span'); ruler.className = 'bp-cell-measure'; ruler.setAttribute('aria-hidden', 'true'); root.append(ruler);
        const fit = (element) => {
          const full = values.get(element); if (full === undefined || !element.isConnected) { return; }
          const visible = element.firstElementChild;
          const style = window.getComputedStyle(element);
          measure.font = style.font;
          const width = ruler.getBoundingClientRect().width;
          if (!width) { return; }
          const chars = Array.from(full);
          let result = full;
          if (measure.measureText(full).width > width) {
            let low = 0; let high = chars.length;
            const middle = element.dataset.ellipsis === 'middle';
            const shorten = (count) => {
              const tail = middle ? Math.max(1, Math.floor(count * 0.4)) : 0;
              return chars.slice(0, count - tail).join('') + '…' + (tail ? chars.slice(-tail).join('') : '');
            };
            while (low < high) { const next = Math.ceil((low + high) / 2); if (measure.measureText(shorten(next)).width <= width) { low = next; } else { high = next - 1; } }
            result = shorten(low);
          }
          if (visible.textContent !== result) { visible.textContent = result; }
          const truncated = result !== full;
          element.toggleAttribute('data-truncated', truncated);
          if (truncated && !element.closest('a, button')) { element.tabIndex = 0; element.setAttribute('role', 'button'); element.setAttribute('aria-label', bucketpilotUI.t('Read or copy full value: @value', {'@value': full})); }
          else { element.removeAttribute('tabindex'); element.removeAttribute('role'); element.removeAttribute('aria-label'); }
        };
        const resize = new ResizeObserver((entries) => entries.forEach((entry) => fit(entry.target)));
        const decorate = () => {
          root.querySelectorAll('table').forEach((table) => {
            if (!table.closest('.bp-table-scroll, .bp-tree-scroll, .bp-bucket-picker-scroll') && !table.classList.contains('bucketpilot-backup-table')) {
              const scroll = document.createElement('div'); scroll.className = 'bp-table-scroll'; scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', bucketpilotUI.t('Scrollable table')); table.before(scroll); scroll.append(table);
            }
            table.querySelectorAll('tbody td').forEach((cell) => {
              const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT); const texts = [];
              while (walker.nextNode()) {
                const text = walker.currentNode; const parent = text.parentElement;
                if (text.textContent.trim() && !parent.closest('.bp-cell-value, .visually-hidden, .bp-record-actions, .button:not(.bp-source-link), button:not(.bp-source-link), svg, script, select, textarea, .bp-job-status, label')) { texts.push(text); }
              }
              texts.forEach((text) => {
                const full = text.textContent;
                const element = document.createElement('span'); element.className = 'bp-cell-value'; element.title = full;
                element.dataset.ellipsis = /[\/\\]|[\da-f]{8}-[\da-f-]+/i.test(full) || full.split(/\s+/).length < 5 ? 'middle' : 'end';
                const visible = document.createElement('span'); visible.textContent = full; visible.setAttribute('aria-hidden', 'true');
                const accessible = document.createElement('span'); accessible.className = 'visually-hidden'; accessible.textContent = full;
                element.append(visible, accessible); text.replaceWith(element); values.set(element, full); resize.observe(element); fit(element);
              });
            });
          });
          // Detached rows should not be retained by ResizeObserver after AJAX.
          observed.forEach((element) => { if (!element.isConnected) { resize.unobserve(element); observed.delete(element); } });
          root.querySelectorAll('.bp-cell-value').forEach((element) => observed.add(element));
        };
        const observed = new Set();
        let scheduled = false;
        const observer = new MutationObserver((records) => {
          if (records.every((record) => record.target.parentElement?.closest('.bp-cell-value') || record.target.closest?.('.bp-cell-value'))) { return; }
          if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; decorate(); }); }
        });
        observer.observe(root, {childList: true, subtree: true, characterData: true});
        let dialog;
        const reveal = (element) => {
          if (!element.hasAttribute('data-truncated')) { return; }
          if (!dialog) {
            dialog = document.createElement('dialog'); dialog.className = 'bp-full-value-dialog'; dialog.setAttribute('aria-label', bucketpilotUI.t('Full table value'));
            const label = document.createElement('label'); label.textContent = bucketpilotUI.t('Full value — select and copy'); label.htmlFor = 'bp-full-table-value';
            const input = document.createElement('textarea'); input.id = label.htmlFor; input.readOnly = true; input.rows = 5;
            const close = document.createElement('button'); close.type = 'button'; close.className = 'button'; close.textContent = bucketpilotUI.t('Close'); close.addEventListener('click', () => dialog.close());
            dialog.append(label, input, close); root.append(dialog);
          }
          dialog.querySelector('textarea').value = values.get(element); dialog.showModal(); dialog.querySelector('textarea').focus(); dialog.querySelector('textarea').select();
        };
        root.addEventListener('click', (event) => { const element = event.target.closest('.bp-cell-value[data-truncated]'); if (element && !element.closest('a, button')) { reveal(element); } });
        root.addEventListener('keydown', (event) => { const element = event.target.closest('.bp-cell-value[data-truncated]') || (event.altKey ? event.target.closest('a, button')?.querySelector('.bp-cell-value[data-truncated]') : null); if (element && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); reveal(element); } });
        decorate();
        document.fonts?.ready.then(() => root.querySelectorAll('.bp-cell-value').forEach(fit));
        window.addEventListener('pagehide', () => { observer.disconnect(); resize.disconnect(); }, {once: true});
      });
    }
  };
})(window.bucketpilotUI, window.bucketpilotOnce, window.bucketpilotSettings);
