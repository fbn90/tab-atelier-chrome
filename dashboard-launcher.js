for(const [buttonId,type] of [['openDashboard','open-dashboard'],['openInbox','open-inbox'],['openDonate','open-donate']]) {
document.getElementById(buttonId).addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({type});
    if (!result?.ok) throw Error(result?.error || globalThis.atelierI18n.t("ui_could_not_open_the_view_5395c1"));
    window.close();
  } catch(error) {
    document.getElementById('dashboardOpenStatus').textContent = error.message;
    document.getElementById(buttonId).disabled = false;
  }
});

}
