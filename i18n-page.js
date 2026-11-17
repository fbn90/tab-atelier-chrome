globalThis.atelierI18n.localize(document);

const extensionVersion = chrome.runtime.getManifest().version;
for (const node of document.querySelectorAll('[data-i18n="ui_tab_atelier_01e1cc"]')) {
  node.append(document.createTextNode(` · v${extensionVersion}`));
}
document.title += ` · v${extensionVersion}`;
