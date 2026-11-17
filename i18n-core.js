// Shared by extension pages and the service worker. Stored data is never translated.
(() => {
  function createI18n(api) {
    const locale='en';
    function t(key,values=[]) {
      return api?.getMessage?.(key,values.map(value=>String(value??''))) || key;
    }
    const labels={"Künstliche Intelligenz":"ui_topic_artificial_intelligence","Programmierung":"ui_topic_programming","Unbekannt": "ui_unknown_276ffa", "Sonstiges": "ui_other_9f3d5f", "Andere Tabs": "ui_other_tabs_b3d909", "Alle Videos": "ui_all_videos_0aed7a", "angefordert": "ui_requested_6cb37a", "übersprungen": "ui_skipped_9e74d8", "geschlossen": "ui_closed_da731d", "fehlgeschlagen": "ui_failed_e650a8"};
    function label(value){return Object.hasOwn(labels,value)?t(labels[value]):value}
    function localize(root) {
      if(root.documentElement)root.documentElement.lang=locale==='de-DE'?'de':'en';
      for(const node of root.querySelectorAll('[data-i18n]'))node.textContent=t(node.getAttribute('data-i18n'));
      for(const attr of ['title','placeholder','aria-label','alt']) {
        for(const node of root.querySelectorAll('[data-i18n-'+attr+']'))node.setAttribute(attr,t(node.getAttribute('data-i18n-'+attr)));
      }
    }
    return Object.freeze({t,label,locale,localize});
  }
  globalThis.atelierCreateI18n=createI18n;
  globalThis.atelierI18n ??= createI18n(globalThis.chrome?.i18n);
})();
