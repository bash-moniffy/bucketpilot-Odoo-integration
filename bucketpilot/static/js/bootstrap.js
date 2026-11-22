(() => {
  const settings = JSON.parse(document.getElementById('bp-settings').textContent);
  const attached = new Map();
  const translate = (value, args = {}) => Object.entries(args).reduce(
    (text, [key, replacement]) => text.replaceAll(key, () => String(replacement)), value);
  window.bucketpilotSettings = settings;
  window.bucketpilotUI = {
    behaviors: {},
    t: translate,
    replaceAddress(url) {
      window.history.replaceState({}, '', url);
      if (window.parent !== window) {
        window.parent.postMessage('bucketpilot:address-change', window.location.origin);
      }
    },
    formatPlural: (count, single, plural) => translate(count === 1 ? single : plural, {'@count': count})
  };
  window.bucketpilotOnce = (id, selector, context = document) => {
    if (!attached.has(id)) { attached.set(id, new WeakSet()); }
    const known = attached.get(id);
    return [...context.querySelectorAll(selector)].filter((element) => {
      if (known.has(element)) { return false; }
      known.add(element);
      return true;
    });
  };
  document.addEventListener('DOMContentLoaded', () => {
    Object.values(window.bucketpilotUI.behaviors).forEach((behavior) => behavior.attach(document, settings));
  });
})();
