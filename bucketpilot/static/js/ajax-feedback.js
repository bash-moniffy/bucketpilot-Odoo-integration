(function (bucketpilotUI) {
  'use strict';

  const scopes = new Map();
  const targets = new WeakMap();

  const start = (message, target = null) => {
    const dialog = [...document.querySelectorAll('.bucketpilot-ui dialog[open]')].at(-1);
    const scope = dialog?.querySelector('[data-bp-inline-feedback]') || dialog || document.querySelector('.bucketpilot-ui');
    if (!scope) { return () => {}; }
    let state = scopes.get(scope);
    if (!state) {
      const indicator = document.createElement('div');
      indicator.className = 'bp-ajax-activity';
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.setAttribute('aria-atomic', 'true');
      const icon = document.createElement('span');
      icon.className = 'bp-loading-icon';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      indicator.append(icon, label);
      scope.append(indicator);
      state = {indicator, label, requests: new Map()};
      scopes.set(scope, state);
    }
    const token = Symbol();
    state.requests.set(token, message);
    if (target) {
      targets.set(target, (targets.get(target) || 0) + 1);
      target.classList.add('bp-ajax-pending');
    }
    const update = () => {
      const count = state.requests.size;
      const first = state.requests.values().next().value;
      state.indicator.dataset.pendingCount = String(count);
      state.label.textContent = count > 1 ? bucketpilotUI.t('@message (@count operations)', {'@message': first, '@count': count}) : first;
    };
    update();
    let finished = false;
    return () => {
      if (finished) { return; }
      finished = true;
      state.requests.delete(token);
      if (target) {
        const count = (targets.get(target) || 1) - 1;
        if (count) { targets.set(target, count); }
        else { targets.delete(target); target.classList.remove('bp-ajax-pending'); }
      }
      if (state.requests.size) { update(); }
      else { state.indicator.remove(); scopes.delete(scope); }
    };
  };

  bucketpilotUI.bucketpilotAjax = {
    start,
    async run(message, operation, target = null) {
      const finish = start(message, target);
      try { return await operation(); }
      finally { finish(); }
    }
  };
})(window.bucketpilotUI);
