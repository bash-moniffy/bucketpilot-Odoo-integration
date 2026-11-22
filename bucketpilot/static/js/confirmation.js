(function (bucketpilotUI) {
  'use strict';
  let active = false;

  // Share one accessible confirmation across all module screens.
  bucketpilotUI.bucketpilotConfirm = (message, options = {}) => {
    if (active) { return Promise.resolve(false); }
    active = true;
    return new Promise((resolve) => {
      const trigger = document.activeElement;
      const root = trigger?.closest('.bucketpilot-ui') || document.querySelector('.bucketpilot-ui');
      const dialog = document.createElement('dialog');
      dialog.className = 'bp-confirm-dialog';
      dialog.setAttribute('aria-labelledby', 'bp-confirm-heading');
      dialog.setAttribute('aria-describedby', 'bp-confirm-message');
      const heading = document.createElement('h2'); heading.id = 'bp-confirm-heading'; heading.textContent = options.title || bucketpilotUI.t('Confirm action');
      const text = document.createElement('p'); text.id = 'bp-confirm-message'; text.textContent = message;
      const actions = document.createElement('div'); actions.className = 'bp-confirm-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button'; cancel.textContent = bucketpilotUI.t('Cancel'); cancel.dataset.confirmCancel = '';
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button button--primary'; confirm.textContent = options.label || bucketpilotUI.t('Confirm'); confirm.dataset.confirmAccept = '';
      if (options.destructive) { confirm.classList.add('bp-confirm-destructive'); }
      actions.append(cancel, confirm); dialog.append(heading, text, actions); (root || document.body).append(dialog);
      let accepted = false;
      cancel.addEventListener('click', () => dialog.close());
      confirm.addEventListener('click', () => { accepted = true; dialog.close(); });
      dialog.addEventListener('close', () => {
        dialog.remove(); active = false;
        if (trigger?.isConnected) { trigger.focus({preventScroll: true}); }
        resolve(accepted);
      }, {once: true});
      // Escape uses the native dialog cancel event and resolves as cancellation.
      dialog.showModal(); cancel.focus();
    });
  };
})(window.bucketpilotUI);
