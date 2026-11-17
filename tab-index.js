import {discoverTabParkers} from './youtube-url.js';
import { duplicateKey } from './tab-rules.js';
export function createTabIndex(api) {
  const tabs = new Map(), duplicates = new Map(), changes = new Map();
  let ready = false, loading;
  function put(tab) {
    if (!tab || !Number.isInteger(tab.id)) return;
    const before = tabs.get(tab.id), oldKey = duplicateKey(before), key = duplicateKey(tab);
    if (oldKey) { duplicates.get(oldKey)?.delete(tab.id); if (!duplicates.get(oldKey)?.size) duplicates.delete(oldKey); }
    tabs.set(tab.id, { ...tab });
    if (key) { if (!duplicates.has(key)) duplicates.set(key, new Set()); duplicates.get(key).add(tab.id); }
    if (loading) changes.set(tab.id, { ...tab });
  }
  function remove(id) {
    const key = duplicateKey(tabs.get(id));
    if (key) { duplicates.get(key)?.delete(id); if (!duplicates.get(key)?.size) duplicates.delete(key); }
    tabs.delete(id); if (loading) changes.set(id, null);
  }
  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      const snapshot = await api.tabs.query({});
      await discoverTabParkers(api,snapshot);
      const intervening = new Map(changes); changes.clear();
      tabs.clear(); duplicates.clear();
      for (const tab of snapshot) put(tab);
      for (const [id, value] of intervening) value ? put(value) : remove(id);
      changes.clear(); ready = true;
    })().finally(() => { loading = null; });
    return loading;
  }
  return {
    put, remove, refresh,
    get: id => tabs.get(id),
    async snapshot() {
      if (!ready) await refresh();
      const all=[...tabs.values()];
      if(await discoverTabParkers(api,all)) {duplicates.clear();for(const tab of all)put(tab);}
      return all;
    },
    matching: key => [...duplicates.get(key) || []].map(id => tabs.get(id)),
    async refreshTab(id) { try { put(await api.tabs.get(id)); } catch { remove(id); } }
  };
}
