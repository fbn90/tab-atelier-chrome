(() => {
  const dialog = document.getElementById('domainGroupDialog');
  const input = document.getElementById('domainGroupName');
  dialog.querySelector('[value=cancel]').addEventListener('click', () => dialog.close());
  window.atelierDomainGroupName = domain => new Promise(resolve => {
    dialog.returnValue = '';
    input.value = Array.from(domain).slice(0, 80).join('');
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'group' ? input.value.trim() : '');
    }, { once: true });
    dialog.showModal();
    input.select();
  });
  window.atelierDomainGroupFeedback = result => {
    const t = globalThis.atelierI18n.t;
    const summary = result.windows ? t("domainGroupPartial",[result.count,result.skipped]) :
      t("domainGroupResult",[result.count,result.title,result.skipped]);
    const failures = (result.windows || []).filter(window=>window.error)
      .map(window=>`${t("ui_window_22c978")} ${window.windowId}: ${window.error}`);
    return [summary,...failures].join(" · ");
  };
})();
