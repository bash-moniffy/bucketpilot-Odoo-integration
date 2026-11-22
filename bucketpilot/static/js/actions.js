document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-bp-confirm-action]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (await window.bucketpilotUI.bucketpilotConfirm(form.dataset.bpConfirmAction, {label: 'Disconnect', destructive: true})) {
        form.submit();
      }
    });
  });
});
