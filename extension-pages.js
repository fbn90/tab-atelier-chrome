import './i18n.js';
// Chrome supplies sender identity; only these bundled pages may control tabs.
export function isTrustedPage(sender, api = chrome) {
  if (sender?.id !== api.runtime.id) return false;
  if(sender.url === api.runtime.getURL('dashboard.html') || sender.url === api.runtime.getURL('inbox.html') ||
      (!sender.tab && sender.url === api.runtime.getURL('popup.html')))return true;
  // The bundled Inbox can carry a capture preview from the dashboard. Preserve
  // the exact origin/path boundary and accept only these bounded view options.
  try {
    const page=new URL(sender.url),base=new URL(api.runtime.getURL('inbox.html'));
    if(page.protocol!==base.protocol||page.host!==base.host||page.pathname!==base.pathname||
       page.username||page.password||page.hash)return false;
    const seen=new Set();
    for(const [key,value] of page.searchParams) {
      if(seen.has(key))return false;seen.add(key);
      if(key==='titleSearch'){if(Array.from(value).length>200)return false}
      else if(key==='parkedOnly'){if(!['0','1'].includes(value))return false}
      else if(key==='windowId'){if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))return false}
      else return false;
    }
    return true;
  }catch{return false;}
}

export function validateWindowId(windowId) {
  if (windowId !== undefined && (!Number.isInteger(windowId) || windowId < 0)) {
    throw Error(globalThis.atelierI18n.t("ui_invalid_window_1b1226"));
  }
}
