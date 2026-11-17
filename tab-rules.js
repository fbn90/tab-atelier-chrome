import { navigationKey, tabParkerTarget, canCloseYouTubeSource } from "./youtube-url.js";
export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || "";
}

export function domainOf(tab) {
  try {
    const raw=tabUrl(tab);
    const url = new URL(tabParkerTarget(raw) || raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const host = url.hostname.replace(/^www\./, "");
    return host;
    }
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return "Andere Tabs";
  }
}

export function duplicateKey(tab) {
  if (!tab || tab.pendingUrl || tab.status !== "complete" || tab.discarded) return null;
  const raw = tab.url || "";
  if (!canCloseYouTubeSource(raw)) return null;
  // Browser tools and unrelated extension pages must remain usable. Tab Parker
  // placeholders carry their supported original YouTube URL in the fragment.
  if (!/^https?:\/\//i.test(raw) && !tabParkerTarget(raw)) return null;
  return `${Boolean(tab.incognito)}:${navigationKey(raw)}`;
}

export function duplicatePairs(tabs, order) {
  const groups = new Map();
  for (const tab of tabs) {
    const key = duplicateKey(tab);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }
  return [...groups.values()].flatMap(group => {
    group.sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
      (order[b.id] ?? b.id) - (order[a.id] ?? a.id));
    return group.slice(1).map(loser => ({ keeper: group[0], loser }));
  });
}

export function windowSortPlan(tabs, order, dissolveGroups = false) {
  const byAge = (a, b) => (order[a.id] ?? a.id) - (order[b.id] ?? b.id) || a.id - b.id;
  const pinned = tabs.filter(tab => tab.pinned).sort(byAge);
  const groups = new Map();
  for (const tab of tabs.filter(tab => !tab.pinned)) {
    const groupId = !dissolveGroups && Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null;
    const key = groupId === null ? `tab:${tab.id}` : `group:${groupId}`;
    if (!groups.has(key)) groups.set(key, { groupId, tabs: [] });
    groups.get(key).tabs.push(tab);
  }
  const blocks = [...groups.values()];
  for (const block of blocks) block.tabs.sort(byAge);
  blocks.sort((a, b) => byAge(a.tabs[0], b.tabs[0]));
  return [...pinned.map(tab => ({ groupId: null, tabs: [tab] })), ...blocks];
}

export function domainSummary(tabs, includeSubdomains = false) {
  const counts = new Map();
  for (const tab of tabs) {
    const domain = domainOf(tab);
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  if (includeSubdomains) {
    const base = new Map(counts);
    for (const [host, count] of base) {
      if (host.includes(":")) continue;
      const parts = host.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join(".");
        if (base.has(parent)) counts.set(parent, counts.get(parent) + count);
      }
    }
  }
  return [...counts].map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

export function domainMatches(tab, domain, includeSubdomains = false) {
  const host = domainOf(tab);
  return host === domain || (includeSubdomains && /^https?:/.test(tabParkerTarget(tabUrl(tab))||tabUrl(tab)) && host.endsWith(`.${domain}`));
}
