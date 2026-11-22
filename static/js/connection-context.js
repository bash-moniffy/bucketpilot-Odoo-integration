(function (bucketpilotUI, once, settings) {
  'use strict';
  bucketpilotUI.behaviors.bucketpilotConnection = {
    attach(context) {
      once('bp-connection-context', '.bucketpilot-ui', context).forEach(() => {
        const data = settings.bucketpilotConnection;
        if (!data?.site) { return; }
        let generation = Number(data.generation);
        const name = `bucketpilot.connection.${data.site}`;
        const receive = (value) => {
          const next = Number(value);
          if (Number.isSafeInteger(next) && next > generation) {
            generation = next;
            window.dispatchEvent(new CustomEvent('bucketpilot:connection-change', {detail: {generation: next}}));
          }
        };
        let channel;
        if (window.BroadcastChannel) {
          channel = new BroadcastChannel(name);
          channel.addEventListener('message', (event) => receive(event.data));
          channel.postMessage(generation);
        }
        try {
          receive(localStorage.getItem(name));
          localStorage.setItem(name, String(generation));
        } catch {}
        window.addEventListener('storage', (event) => { if (event.key === name) { receive(event.newValue); } });
        window.addEventListener('pagehide', () => channel?.close(), {once: true});
      });
    }
  };
})(window.bucketpilotUI, window.bucketpilotOnce, window.bucketpilotSettings);
