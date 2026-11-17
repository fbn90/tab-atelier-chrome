import './i18n.js';
// Local, reviewed aliases. Job titles are deliberately explicit, never inferred
// from a company name alone. Palantir role checked 2026-09-20:
// https://investors.palantir.com/management.html
export const BUILTIN_PEOPLE = Object.freeze([
  { label: "Alex Karp", names: ["Alex Karp", "Alexander Karp"],
    roles: ["Palantir CEO", "CEO of Palantir", "CEO von Palantir", "Palantir Chef"] },
  { label: "Joachim Steinhöfel", names: ["Joachim Steinhöfel", "Joachim Steinhoefel"],
    surnames: ["Steinhöfel", "Steinhoefel"] },
  { label: "Douglas Murray", names: ["Douglas Murray"] },
  { label: "Michael Every", names: ["Michael Every"] },
  { label: "Marie-Astrid Langer", names: ["Marie-Astrid Langer"] },
  { label: "Scott Bessent", names: ["Scott Bessent"] },
  { label: "Max Levchin", names: ["Max Levchin"] },
  { label: "Jensen Huang", names: ["Jensen Huang"] }
]);

// Local title rules: specific topics precede broad categories.
export const BUILTIN_TOPICS = Object.freeze([
  {label:'Omarchy',terms:['Omarchy']},
  {label:'Arch Linux',terms:['Arch Linux','Archlinux']},
  {label:'Linux',terms:['Linux','Ubuntu','Debian','Fedora']},
  {label:'Künstliche Intelligenz',terms:['artificial intelligence','künstliche Intelligenz','ChatGPT','OpenAI','AI']},
  {label:'Programmierung',terms:['programming','Programmierung','JavaScript','TypeScript','Python']}
]);

export function aliasKey(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase("de").replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function phraseIndex(title, phrase) {
  return (` ${title} `).indexOf(` ${phrase} `);
}

export function resolveTopicOverride(label, rules = []) {
  const seen = new Set();
  let current = label;
  while (!seen.has(aliasKey(current))) {
    const key = aliasKey(current);
    seen.add(key);
    const match = rules.find(rule => aliasKey(rule.alias) === key);
    if (!match) return current;
    current = match.target;
  }
  return label; // Corrupt stored data must never hang the worker.
}

export function saveAliasRules(existing, target, aliases) {
  const clean = value => typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  target = clean(target);
  if (!aliasKey(target) || target.length > 72) throw new Error(globalThis.atelierI18n.t("ui_topic_name_enter_1_72_characters_e3d2c9"));
  if (!Array.isArray(aliases) || !aliases.length || aliases.length > 50) {
    throw new Error(globalThis.atelierI18n.t("ui_please_enter_1_50_variants_one_per_line_46bbce"));
  }
  const next = existing.map(rule => ({ ...rule }));
  for (const value of aliases) {
    const alias = clean(value);
    if (!aliasKey(alias) || alias.length > 160) throw new Error(globalThis.atelierI18n.t("ui_each_variant_must_contain_1_160_characters_4e1888"));
    if (aliasKey(alias) === aliasKey(target)) continue;
    const rule = { alias, target };
    const index = next.findIndex(item => aliasKey(item.alias) === aliasKey(alias));
    if (index >= 0) next[index] = rule;
    else next.push(rule);
  }
  if (next.length > 500) throw new Error(globalThis.atelierI18n.t("ui_you_can_save_up_to_500_variants_5ff547"));
  for (const rule of next) {
    const seen = new Set([aliasKey(rule.alias)]);
    let current = rule.target;
    while (true) {
      const key = aliasKey(current);
      if (seen.has(key)) throw new Error(globalThis.atelierI18n.t("ui_this_rule_creates_a_cycle_please_choose_another_targ_c06714"));
      seen.add(key);
      const following = next.find(item => aliasKey(item.alias) === key);
      if (!following) break;
      current = following.target;
    }
  }
  return next;
}

export function recognizeTopic(title, rules = []) {
  const normalized = aliasKey(title);
  if (!normalized) return null;
  // Explicit user corrections outrank built-in recognition; most specific first.
  const custom = rules.map(rule => ({ ...rule, key: aliasKey(rule.alias) }))
    .filter(rule => phraseIndex(normalized, rule.key) >= 0)
    .sort((a, b) => b.key.length - a.key.length || phraseIndex(normalized, a.key) - phraseIndex(normalized, b.key));
  if (custom.length) return resolveTopicOverride(custom[0].target, rules);

  const matches = [];
  for (const person of BUILTIN_PEOPLE) {
    for (const name of person.names) {
      const words = aliasKey(name).split(" ");
      // Ignore optional middle initials, but do not guess arbitrary nicknames.
      const pattern = new RegExp(`(?:^| )${words[0]}(?: [a-z])* ${words.slice(1).join(" ")}(?= |$)`, "u");
      const match = pattern.exec(normalized);
      if (match) matches.push({ label: person.label, rank: 3, index: match.index });
    }
    for (const role of person.roles || []) {
      const index = phraseIndex(normalized, aliasKey(role));
      if (index >= 0 && !/\b(?:former|ex|former chief|ehemalige\w*|neue\w*|next|new)\b/.test(normalized)) {
        matches.push({ label: person.label, rank: 2, index });
      }
    }
    for (const surname of person.surnames || []) {
      // A surname alone is accepted only at the start of a title/segment.
      // "Andreas Steinhöfel" must not turn into "Joachim Steinhöfel".
      for (const segment of String(title).split(/[|:–—!?]/u)) {
        if (aliasKey(segment).startsWith(`${aliasKey(surname)} `) || aliasKey(segment) === aliasKey(surname)) {
          matches.push({ label: person.label, rank: 1, index: phraseIndex(normalized, aliasKey(surname)) });
        }
      }
    }
  }
  matches.sort((a, b) => b.rank - a.rank || a.index - b.index);
  if(matches.length)return resolveTopicOverride(matches[0].label, rules);
  const topic=BUILTIN_TOPICS.find(topic=>topic.terms.some(term=>phraseIndex(normalized,aliasKey(term))>=0));
  return topic?resolveTopicOverride(topic.label,rules):null;
}
