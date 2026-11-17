import './i18n.js';
import { aliasKey, saveAliasRules } from "./topic-aliases.js";

export const ALIAS_STORAGE_KEY = "ytTopicAliasesV1";

export function createAliasStore(storage, changed) {
  let rules = [];
  let loaded = false;
  let loading;
  let revision = 0;
  let writes = Promise.resolve();
  function replace(value) {
    rules = Array.isArray(value) ? value.filter(rule => typeof rule?.alias === "string" &&
      typeof rule?.target === "string" && aliasKey(rule.alias) && aliasKey(rule.target)).slice(0, 500) : [];
    loaded = true;
    revision++;
    changed();
  }
  async function load() {
    if (loaded) return;
    if (!loading) {
      const before = revision;
      loading = storage.get(ALIAS_STORAGE_KEY).then(value => {
        if (before === revision) replace(value[ALIAS_STORAGE_KEY]);
      }).finally(() => { loading = null; });
    }
    await loading;
  }
  function update(transform) {
    const result = writes.then(async () => {
      await load();
      const next = transform(rules);
      await storage.set({ [ALIAS_STORAGE_KEY]: next });
      replace(next);
      return { ok: true, rules };
    });
    writes = result.catch(() => {});
    return result;
  }
  return {
    load, replace,
    get rules() { return rules; },
    async list() { await load(); return { ok: true, rules }; },
    save(target, aliases) { return update(current => saveAliasRules(current, target, aliases)); },
    remove(alias) {
      if (typeof alias !== "string" || !aliasKey(alias)) return Promise.reject(new Error(globalThis.atelierI18n.t("ui_variant_is_missing_5f8c77")));
      return update(current => current.filter(rule => aliasKey(rule.alias) !== aliasKey(alias)));
    }
  };
}
