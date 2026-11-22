(function (bucketpilotUI, once) {
  'use strict';
  let notice; let timer;
  const key = 'bucketpilot.savedNotice';
  bucketpilotUI.bucketpilotNotice = {
    show(message) {
      const root = document.querySelector('.bucketpilot-ui'); if (!root) { return; }
      window.clearTimeout(timer); notice?.remove();
      notice = document.createElement('div'); notice.className = 'bp-save-notice';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      const icon = document.createElement('span'); icon.className = 'bp-save-notice-icon'; icon.textContent = '✓'; icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = message;
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', bucketpilotUI.t('Dismiss notification'));
      const dismiss = () => { window.clearTimeout(timer); notice?.remove(); notice = null; };
      close.addEventListener('click', dismiss);
      notice.append(icon, text, close); root.append(notice);
      notice.addEventListener('mouseenter', () => window.clearTimeout(timer));
      notice.addEventListener('focusin', () => window.clearTimeout(timer));
      notice.addEventListener('mouseleave', () => { timer = window.setTimeout(dismiss, 6000); });
      timer = window.setTimeout(dismiss, 6000);
    },
    afterNavigation(message, url) {
      try { sessionStorage.setItem(key, JSON.stringify({message, path: url.pathname, expires: Date.now() + 30000})); } catch {}
    }
  };
  bucketpilotUI.behaviors.bucketpilotSaveNotices = {
    attach(context) {
      once('bp-save-notices', '.bucketpilot-ui', context).forEach(() => {
        try {
          const pending = JSON.parse(sessionStorage.getItem(key)); sessionStorage.removeItem(key);
          if (pending?.path === location.pathname && pending.expires > Date.now()) { bucketpilotUI.bucketpilotNotice.show(pending.message); }
        } catch {}
        once('bp-status-notice', '[data-bp-save-message]', document).forEach((element) => {
          const message = element.querySelector('.messages__content') || element;
          bucketpilotUI.bucketpilotNotice.show(message.textContent.trim());
        });
      });
    }
  };
})(window.bucketpilotUI, window.bucketpilotOnce);
