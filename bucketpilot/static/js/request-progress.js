document.addEventListener('DOMContentLoaded', () => {
  const root = document.querySelector('[data-bp-request]');
  if (!root) { return; }
  let pending = false;
  const update = async () => {
    if (pending || document.hidden) { return; }
    pending = true;
    try {
      const response = await fetch(window.bucketpilotSettings.bucketpilotBackupProgress, {cache: 'no-store'});
      if (!response.ok) { return; }
      const data = await response.json();
      if (!data.waiting) { location.reload(); return; }
      const setText = (selector, value) => {
        const node = root.querySelector(selector);
        if (node.textContent !== String(value)) { node.textContent = value; }
      };
      setText('[data-request-status]', data.status_label);
      setText('[data-request-label]', data.waiting.label);
      setText('[data-request-message]', data.waiting.message);
      setText('[data-request-error]', data.error);
      root.querySelector('[data-request-error]').hidden = !data.error;
      root.querySelector('[data-request-retry]').hidden = !data.next_attempt;
      if (data.next_attempt) {
        const local = new Intl.DateTimeFormat(undefined, {dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC'});
        setText('[data-request-retry] span', local.format(new Date(data.next_attempt * 1000)) + ' UTC');
      }
    } catch {
      // Keep the saved request visible and retry on the next interval.
    } finally { pending = false; }
  };
  const timer = setInterval(update, 2000);
  addEventListener('pagehide', () => clearInterval(timer), {once: true});
  document.addEventListener('visibilitychange', update);
});
