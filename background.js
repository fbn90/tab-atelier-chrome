import './i18n.js';
import {installAutomaticMetadata} from './automatic-metadata.js';
import {channelIdentity,channelIdentityKeys,hasCardDuration,preferredVideoTitle} from './youtube-metadata.js';
import {installParkerUpdate} from "./parker-update.js";
import { installInbox } from "./inbox-service.js";
import { transferStep } from "./tab-transfer.js";
import { isTrustedPage, validateWindowId } from "./extension-pages.js";
import "./tab-manager.js";
import { parseYouTubeVideo as parseWatchVideo, parseYouTubeTab, discoverTabParkers, meaningfulYouTubeTitle, meaningfulChannel, parkedVideoTitle, canCloseYouTubeSource } from "./youtube-url.js";
import { installYouTubeAutoGroups } from "./youtube-auto-groups.js";
import { createMetadataCache } from "./metadata-cache.js";
import { runExclusive } from "./action-coordinator.js";
import { taskService } from "./task-runner.js";
import { recognizeTopic, resolveTopicOverride } from "./topic-aliases.js";
import { createAliasStore, ALIAS_STORAGE_KEY } from "./topic-alias-store.js";

const MESSAGE_TYPES = Object.freeze({
  EXPORT_WATCH_TABS: "export-watch-tabs",
  GET_GROUP_ACTIONS: "get-group-actions",
  MOVE_GROUP_TO_WINDOW: "move-group-to-window",
  CLOSE_GROUP_TABS: "close-group-tabs",
  GET_SETTINGS: "get-settings",
  SET_CHANNEL_THRESHOLD: "set-channel-threshold",
  GROUPS_INVALIDATED: "groups-invalidated"
});

const WATCH_TAB_PATTERNS = ["*://youtube.com/*", "*://*.youtube.com/*", "*://youtu.be/*", "*://www.youtu.be/*"];
const OEMBED_ENDPOINT = "https://www.youtube.com/oembed?format=json&url=";
const METADATA_CONCURRENCY = 4;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_CHANNEL_ACTION_MIN_COUNT = 2;
const MAX_CHANNEL_ACTION_MIN_COUNT = 999;
const CHANNEL_SCAN_CHUNK_SIZE = 4;
const CHANNEL_SCAN_CONCURRENCY = 4;
const UNKNOWN_CHANNEL = "Unbekannt";
const UNKNOWN_TOPIC = "Sonstiges";
const TOPIC_REPEAT_THRESHOLD = 2;
const GROUP_BY = Object.freeze({
  CHANNEL: "channel",
  TOPIC: "topic"
});
const TOPIC_STOP_PHRASES = new Set([
  "interview",
  "podcast",
  "reaction",
  "reactions",
  "debate",
  "discussion",
  "analysis",
  "update",
  "highlights",
  "episode",
  "livestream",
  "live"
]);
const TOPIC_FRAGMENT_STOP_PHRASES = new Set([
  "breaking",
  "breaking news",
  "clip",
  "clips",
  "full debate",
  "full episode",
  "full interview",
  "full podcast",
  "must watch",
  "official trailer",
  "shorts",
  "watch",
  "watch this",
  "youtube"
]);
const TOPIC_SEGMENT_LEADING_STOP_WORDS = new Set([
  "a",
  "an",
  "are",
  "der",
  "die",
  "diese",
  "dieser",
  "dieses",
  "du",
  "er",
  "he",
  "hes",
  "he's",
  "how",
  "i",
  "ich",
  "im",
  "i'm",
  "kann",
  "man",
  "she",
  "shes",
  "she's",
  "that",
  "the",
  "these",
  "this",
  "those",
  "watch",
  "was",
  "we",
  "what",
  "when",
  "why",
  "wie",
  "wir",
  "wtf",
  "you",
  "warum"
]);
const TOPIC_CANDIDATE_WEIGHTS = Object.freeze({
  PRIORITY: 400,
  PROPER_NAME: 260,
  QUOTED: 150,
  SEGMENT: 90
});
const TOPIC_SEGMENT_SPLIT_PATTERN = /\s*(?:\||:|–|—)\s*|\s+-\s+/;
const TOPIC_PROPER_NAME_FULL_PATTERN =
  /^(?:[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+|[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+\s+[A-ZÄÖÜ]\.?\s*[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+)$/;
const TOPIC_PROPER_NAME_GLOBAL_PATTERN =
  /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+|[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+\s+[A-ZÄÖÜ]\.?\s*[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+)\b/g;
const PRIORITY_TOPIC_PATTERNS = Object.freeze([
  {
    label: "Douglas Murray",
    pattern: /\bdouglas murray\b/i
  }
]);
const STORAGE_KEYS = Object.freeze({
  CHANNEL_THRESHOLD: "ytChannelActionMinCountV1"
});
const metadataCache = createMetadataCache(chrome.storage.local);
const tasks = taskService();
const inFlightMetadataRequests = new Map();
const knownWatchTabIds = new Set();
let groupsInvalidationNotifyTimer = null;

let channelScanState = null;
let scanGeneration = 0;
let scanQueue = Promise.resolve();
let channelActionMinCount = DEFAULT_CHANNEL_ACTION_MIN_COUNT;
let settingsLoaded = false;
let settingsLoadPromise = null, topicRevision=0;
const topicAliases = createAliasStore(chrome.storage.local, () => {
  topicRevision++;
  channelScanState?.groupsCache.clear();
  notifyGroupSnapshotChanged();
  chrome.runtime.sendMessage?.({type:"inbox-changed"})?.catch(()=>{});
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function compareStrings(a, b) {
  return a.localeCompare(b, "de", { sensitivity: "base" });
}

function normalizeChannelActionMinCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHANNEL_ACTION_MIN_COUNT;
  }

  return Math.min(MAX_CHANNEL_ACTION_MIN_COUNT, Math.max(0, Math.floor(parsed)));
}

async function broadcastGroupsInvalidated() {
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GROUPS_INVALIDATED });
  } catch {
    // Ignore when no popup is listening.
  }
}

function scheduleGroupsInvalidatedBroadcast() {
  if (groupsInvalidationNotifyTimer) {
    clearTimeout(groupsInvalidationNotifyTimer);
  }

  groupsInvalidationNotifyTimer = setTimeout(() => {
    groupsInvalidationNotifyTimer = null;
    broadcastGroupsInvalidated().catch(() => {
      // Ignore when no popup is listening.
    });
  }, 150);
}

async function ensureSettingsLoaded() {
  if (settingsLoaded) {
    return;
  }

  if (settingsLoadPromise) {
    await settingsLoadPromise;
    return;
  }

  settingsLoadPromise = (async () => {
    const stored = await chrome.storage.local.get({
      [STORAGE_KEYS.CHANNEL_THRESHOLD]: DEFAULT_CHANNEL_ACTION_MIN_COUNT
    });
    channelActionMinCount = normalizeChannelActionMinCount(
      stored?.[STORAGE_KEYS.CHANNEL_THRESHOLD]
    );
    settingsLoaded = true;
  })().finally(() => {
    settingsLoadPromise = null;
  });

  await settingsLoadPromise;
}

async function persistChannelActionMinCount(value) {
  await ensureSettingsLoaded();

  channelActionMinCount = normalizeChannelActionMinCount(value);
  await chrome.storage.local.set({
    [STORAGE_KEYS.CHANNEL_THRESHOLD]: channelActionMinCount
  });
  notifyGroupSnapshotChanged();

  return channelActionMinCount;
}

function notifyGroupSnapshotChanged() {
  scheduleGroupsInvalidatedBroadcast();
}
function resetGroupScanState() {
  // Existing work keeps its own snapshot. Invalidation never nulls its state.
  scanGeneration++;
  notifyGroupSnapshotChanged();
}
function withScanQueue(fn) {
  const result = scanQueue.then(fn);
  scanQueue = result.catch(() => {});
  return result;
}

function replaceKnownWatchTabIds(entries) {
  knownWatchTabIds.clear();

  for (const entry of entries || []) {
    if (typeof entry?.tabId === "number") {
      knownWatchTabIds.add(entry.tabId);
    }
  }
}

function isKnownWatchTabId(tabId) {
  return typeof tabId === "number" && knownWatchTabIds.has(tabId);
}

function scoreTab(entry) {
  let score = 0;
  if (!entry.discarded) {
    score += 2;
  }
  if (entry.status === "complete") {
    score += 3;
  }
  if (entry.active) {
    score += 1;
  }
  return score;
}

function pickPreferredTab(existing, candidate) {
  if (!existing) {
    return candidate;
  }

  const existingScore = scoreTab(existing);
  const candidateScore = scoreTab(candidate);

  if (candidateScore > existingScore) {
    return candidate;
  }
  if (candidateScore < existingScore) {
    return existing;
  }

  if (candidate.windowId !== existing.windowId) {
    return candidate.windowId < existing.windowId ? candidate : existing;
  }

  if (candidate.index !== existing.index) {
    return candidate.index < existing.index ? candidate : existing;
  }

  return existing;
}

async function collectRawWatchTabs() {
  const tabs = await chrome.tabs.query({});
  await discoverTabParkers(chrome,tabs);
  const entries = [];

  for (const tab of tabs) {
    if (typeof tab.id !== "number") {
      continue;
    }

    const parsed = parseYouTubeTab(tab.url);
    if (!parsed) {
      continue;
    }

    const entry = {
      tabId: tab.id,
      tabTitle: parsed.parked ? parkedVideoTitle(parsed,tab.title) : normalizeText(tab.title),
      parked: parsed.parked,
      tabChannel: parsed.channel,
      status: tab.status || "",
      discarded: Boolean(tab.discarded),
      active: Boolean(tab.active),
      incognito: Boolean(tab.incognito),
      windowId: typeof tab.windowId === "number" ? tab.windowId : Number.MAX_SAFE_INTEGER,
      index: typeof tab.index === "number" ? tab.index : Number.MAX_SAFE_INTEGER,
      videoId: parsed.videoId,
      url: parsed.canonicalUrl
    };

    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.windowId !== b.windowId) {
      return a.windowId - b.windowId;
    }
    return a.index - b.index;
  });

  return entries;
}

async function collectWatchTabs() {
  const rawEntries = await collectRawWatchTabs();
  const uniqueByVideoId = new Map();

  for (const entry of rawEntries) {
    uniqueByVideoId.set(entry.videoId, pickPreferredTab(uniqueByVideoId.get(entry.videoId), entry));
  }

  const entries = Array.from(uniqueByVideoId.values()).sort((a, b) => {
    if (a.windowId !== b.windowId) {
      return a.windowId - b.windowId;
    }
    return a.index - b.index;
  });

  return {
    entries,
    matchedTabs: rawEntries.length
  };
}

async function withTimeout(promise, ms) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(globalThis.atelierI18n.t("ui_timed_out_while_reading_the_tab_782dd5"))),ms)})]); }
  finally { clearTimeout(timer); }
}
async function readMetadataFromDom(tabId, expectedVideoId) {
  const before = await chrome.tabs.get(tabId);
  if (before.pendingUrl || before.status !== "complete" || before.discarded || parseWatchVideo(before.url)?.videoId !== expectedVideoId) return {};

  const injections = await chrome.scripting.executeScript({
    target: { tabId },
    args: [expectedVideoId],
    func: (expectedVideoId) => {
      const idFromUrl = raw => {
        try { const u=new URL(raw);return u.pathname==="/watch"?u.searchParams.get("v"):u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]; } catch {return null;}
      };
      if(idFromUrl(location.href)!==expectedVideoId) return {};
      const identities = [document.querySelector('meta[itemprop="videoId"]')?.content,
        document.querySelector('ytd-watch-flexy')?.getAttribute('video-id'),
        idFromUrl(document.querySelector('link[rel="canonical"]')?.href)].filter(Boolean);
      if(!identities.length || identities.some(id=>id!==expectedVideoId)) return {};
      const clean = (value) => {
        if (typeof value !== "string") {
          return "";
        }
        return value.replace(/\s+/g, " ").trim();
      };

      const firstNonEmpty = (values) => {
        for (const value of values) {
          const normalized = clean(value);
          if (normalized) {
            return normalized;
          }
        }
        return "";
      };

      const stripYouTubeSuffix = (value) => value.replace(/\s*-\s*YouTube\s*$/i, "").trim();

      const title = (() => {
        const rawTitle = firstNonEmpty([
          document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent,
          document.querySelector("ytd-watch-metadata h1 yt-formatted-string")?.textContent,
          document.querySelector("h1.title yt-formatted-string")?.textContent,
          document.querySelector("meta[property='og:title']")?.getAttribute("content"),
          document.querySelector("meta[name='title']")?.getAttribute("content"),
          document.title
        ]);

        const cleaned = stripYouTubeSuffix(rawTitle);
        return cleaned || null;
      })();

      const owner = document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a, ytd-video-owner-renderer ytd-channel-name a');
      const channelId = document.querySelector('meta[itemprop="channelId"]')?.content;
      let channel = clean(owner?.textContent);

      if (!channel) {
        const jsonLdNodes = document.querySelectorAll("script[type='application/ld+json']");
        for (const node of jsonLdNodes) {
          const raw = node.textContent || "";
          if (!raw.trim()) {
            continue;
          }

          try {
            const parsed = JSON.parse(raw);
            const candidates = Array.isArray(parsed) ? parsed : [parsed];

            for (const candidate of candidates) {
              if (!candidate || typeof candidate !== "object") {
                continue;
              }

              const type = candidate["@type"];
              const isVideoObject =
                type === "VideoObject" || (Array.isArray(type) && type.includes("VideoObject"));
              if (!isVideoObject) {
                continue;
              }

              const authorName =
                candidate.author && typeof candidate.author === "object"
                  ? clean(candidate.author.name)
                  : "";
              if (authorName) {
                channel = authorName;
                break;
              }
            }
          } catch {
            // Ignore malformed JSON-LD blocks from unrelated scripts.
          }

          if (channel) {
            break;
          }
        }
      }

      return {
        title: title || null,
        channel: channel || null, ownerUrl:owner?.href, channelId
      };
    }
  });

  const after = await chrome.tabs.get(tabId);
  if (after.pendingUrl || after.status !== "complete" || parseWatchVideo(after.url)?.videoId !== expectedVideoId) return {};
  const result = injections?.[0]?.result || {};
  return {
    title: normalizeText(result.title),
    channel: normalizeText(result.channel),
    ...((result.channelId||result.ownerUrl)?{
      channelKey:channelIdentity('https://www.youtube.com/channel/'+result.channelId)||channelIdentity(result.ownerUrl),
      channelHandle:channelIdentity(result.ownerUrl).startsWith('@')?channelIdentity(result.ownerUrl):''
    }:{})
  };
}

const oembedInFlight=new Map(),oembedWaiters=[];
let oembedActive=0,oembedCooldown=0;
function fetchOEmbed(videoUrl) {
  if(oembedInFlight.has(videoUrl))return oembedInFlight.get(videoUrl);
  const work=(async()=>{
    if(oembedActive>=2)await new Promise(resolve=>oembedWaiters.push(resolve));else oembedActive++;
    try {
      if(Date.now()<oembedCooldown)throw Object.assign(Error('YouTube rate limited'),{status:429,retryAfter:oembedCooldown-Date.now()});
      return await fetchOEmbedResponse(videoUrl);
    } finally {
      const next=oembedWaiters.shift();
      if(next)next();else oembedActive--;
    }
  })().finally(()=>oembedInFlight.delete(videoUrl));
  oembedInFlight.set(videoUrl,work);return work;
}

async function fetchOEmbedResponse(videoUrl) {
  const endpoint = `${OEMBED_ENDPOINT}${encodeURIComponent(videoUrl)}`;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(endpoint, { method: "GET", credentials:"omit", referrerPolicy:"no-referrer", signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const data = await response.json();
      return {
        title: normalizeText(data?.title),
        channel: normalizeText(data?.author_name),
        ...(data?.author_url?{channelKey:channelIdentity(data.author_url)}:{})
      };
    }

    if(response.status===429||response.status===503){
      const value=response.headers?.get('Retry-After'),seconds=value?Number(value):NaN;
      const pause=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-Date.now();
      const retryAfter=Math.max(5*60000,Number.isFinite(pause)?pause:0);
      oembedCooldown=Date.now()+retryAfter;
      throw Object.assign(Error('YouTube metadata temporarily unavailable'),{status:response.status,retryAfter});
    }
    if (attempt < 2 && RETRYABLE_HTTP_STATUSES.has(response.status)) {
      await sleep(300);
      continue;
    }

    throw new Error(globalThis.atelierI18n.t("ui_oembed_request_failed_c9aa25", [response.status]));
  }

  return { title: null, channel: null };
}

function fallbackTitleFromTab(tabTitle) {
  const title = normalizeText(tabTitle);
  if (!title) {
    return null;
  }

  const withoutSuffix = title.replace(/\s*-\s*YouTube\s*$/i, "").trim();
  return withoutSuffix || null;
}

function mergeMetadata(primary, fallback) {
  return {
    title: primary.title || fallback.title || null,
    channel: primary.channel || fallback.channel || null,
    channelKey:primary.channelKey||(!primary.channel||primary.channel===fallback.channel?fallback.channelKey:''),
    channelHandle:primary.channelHandle||(!primary.channel||primary.channel===fallback.channel?fallback.channelHandle:'')
  };
}

function normalizeChannelName(value) {
  return normalizeText(value) || UNKNOWN_CHANNEL;
}

function canReadMetadataFromDom(entry) {
  return Boolean(entry && entry.status === "complete" && !entry.discarded);
}

let metadataActive=0;
const metadataWaiters=[];
async function withMetadataSlot(fn) {
  if(metadataActive>=4)await new Promise(resolve=>metadataWaiters.push(resolve));
  else metadataActive++;
  try{return await fn();}finally{const next=metadataWaiters.shift();if(next)next();else metadataActive--;}
}
function getMetadataPromise(entry) {
  // Capturing a parked page must not wake it, inject into it or start an
  // external metadata request. Its local title and any existing cache suffice.
  if (entry.parked) {
    return (entry.incognito ? Promise.resolve(null) : metadataCache.get(entry.videoId))
      .then(async cached=>parkedMetadata(entry,cached,entry.incognito?null:await inbox.get(entry.videoId)));
  }
  const cacheKey = `${entry.incognito?'private:':''}${entry.videoId}`;
  if (inFlightMetadataRequests.has(cacheKey)) {
    return inFlightMetadataRequests.get(cacheKey);
  }

  const metadataPromise = withMetadataSlot(async () => {
    const revision = metadataCache.revision;
    const cached = entry.incognito?null:await metadataCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let domMetadata = { title: null, channel: null };
    if (canReadMetadataFromDom(entry)) {
      try {
        domMetadata = await withTimeout(readMetadataFromDom(entry.tabId, entry.videoId), 6000);
      } catch {
        // Ignore tabs that are not scriptable and continue with oEmbed/tab-title fallbacks.
      }
    }

    let oembedMetadata = { title: null, channel: null };
    if (!domMetadata.title || !domMetadata.channel) {
      try {
        oembedMetadata = await fetchOEmbed(entry.url);
      } catch {
        // Ignore oEmbed failures and continue with available metadata.
      }
    }

    const merged = mergeMetadata(domMetadata, oembedMetadata);
    const resolved = {
      title: merged.title || null,
      channel: normalizeChannelName(merged.channel),
      ...(merged.channelKey?{channelKey:merged.channelKey}:{}),...(merged.channelHandle?{channelHandle:merged.channelHandle}:{})
    };

    if(!entry.incognito)await metadataCache.set(cacheKey, resolved, revision);

    return resolved;
  }).finally(() => {
    if(inFlightMetadataRequests.get(cacheKey)===metadataPromise) inFlightMetadataRequests.delete(cacheKey);
  });

  inFlightMetadataRequests.set(cacheKey, metadataPromise);
  return metadataPromise;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function buildItems(entries) {
  return mapWithConcurrency(entries, METADATA_CONCURRENCY, async (entry) => {
    const metadata = await getMetadataPromise(entry);

    return {
      title: metadata.title || fallbackTitleFromTab(entry.tabTitle),
      channel: metadata.channel,
      metadataComplete: Boolean(metadata.title && metadata.channel !== UNKNOWN_CHANNEL),
      url: entry.url
    };
  });
}

function buildChannelSummary(items) {
  const channelCounts = new Map();

  for (const item of items) {
    const channelName = normalizeChannelName(item?.channel);
    channelCounts.set(channelName, (channelCounts.get(channelName) || 0) + 1);
  }

  return Array.from(channelCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }

      return compareStrings(a[0], b[0]);
    })
    .map(([channel, count]) => ({ channel, count }));
}

function sortItemsByChannel(items) {
  return [...items].sort((a, b) => {
    const channelA = normalizeChannelName(a?.channel);
    const channelB = normalizeChannelName(b?.channel);
    const byChannel = compareStrings(channelA, channelB);
    if (byChannel !== 0) {
      return byChannel;
    }

    const titleA = normalizeText(a?.title) || "";
    const titleB = normalizeText(b?.title) || "";
    const byTitle = compareStrings(titleA, titleB);
    if (byTitle !== 0) {
      return byTitle;
    }

    return compareStrings(a?.url || "", b?.url || "");
  });
}

function buildPayload({ totalOpenTabs, matchedTabs, items }) {
  const channelSummary = buildChannelSummary(items);

  return {
    exportedAt: new Date().toISOString(),
    totalOpenTabs,
    matchedWatchTabs: matchedTabs, // Legacy field; now includes Shorts/live/short links.
    matchedVideoTabs: matchedTabs,
    uniqueVideos: items.length,
    channelSummary,
    items
  };
}

function normalizeGroupBy(value) {
  return value === GROUP_BY.TOPIC ? GROUP_BY.TOPIC : GROUP_BY.CHANNEL;
}

function normalizeGroupKey(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLocaleLowerCase("de") : "";
}

function groupLookupKey(value) {
  return typeof value==='string'&&/^UC[A-Za-z0-9_-]{22}$/.test(value)?value:normalizeGroupKey(value);
}

function normalizeTopicName(value) {
  return normalizeText(value) || UNKNOWN_TOPIC;
}

function countTopicWords(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).filter(Boolean).length;
}

function getLeadingTopicToken(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  return normalized
    .split(/\s+/)[0]
    .toLocaleLowerCase("de")
    .replace(/^[^a-zäöüß]+|[^a-zäöüß]+$/g, "");
}

function containsShoutyToken(value) {
  return /\b[A-ZÄÖÜ]{4,}\b/.test(value);
}

function hasLeadingTitleCaseWord(value) {
  return /^\s*[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+/.test(value);
}

function hasTrailingTitleCaseWord(value) {
  return /[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+\s*$/.test(value);
}

function cleanTopicCandidate(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const cleaned = normalized
    .replace(/^[\s"'`“”‘’()[\]{}:;,.!?|/\\-]+/, "")
    .replace(/[\s"'`“”‘’()[\]{}:;,.!?|/\\-]+$/, "")
    .trim();

  if (!cleaned || !/[A-Za-zÄÖÜäöüß]/.test(cleaned)) {
    return null;
  }

  if (cleaned.length > 72) {
    return `${cleaned.slice(0, 69).trimEnd()}...`;
  }

  return cleaned;
}

function isLikelyProperNameCandidate(value) {
  const candidate = cleanTopicCandidate(value);
  if (!candidate) {
    return false;
  }

  const leadingToken = getLeadingTopicToken(candidate);
  if (TOPIC_SEGMENT_LEADING_STOP_WORDS.has(leadingToken)) {
    return false;
  }

  if (containsShoutyToken(candidate)) {
    return false;
  }

  return TOPIC_PROPER_NAME_FULL_PATTERN.test(candidate);
}

function isLikelyTopicFragmentCandidate(value) {
  const candidate = cleanTopicCandidate(value);
  if (!candidate) {
    return false;
  }

  const key = normalizeGroupKey(candidate);
  if (!key || TOPIC_STOP_PHRASES.has(key) || TOPIC_FRAGMENT_STOP_PHRASES.has(key)) {
    return false;
  }

  const leadingToken = getLeadingTopicToken(candidate);
  if (TOPIC_SEGMENT_LEADING_STOP_WORDS.has(leadingToken)) {
    return false;
  }

  const wordCount = countTopicWords(candidate);
  if (wordCount < 2 || wordCount > 7) {
    return false;
  }

  if (containsShoutyToken(candidate)) {
    return false;
  }

  return true;
}

function isEmbeddedInTitleCaseRun(title, startIndex, candidateLength) {
  const before = title.slice(0, startIndex);
  const after = title.slice(startIndex + candidateLength);
  return hasTrailingTitleCaseWord(before) && hasLeadingTitleCaseWord(after);
}

function extractTopicCandidates(title, channelName) {
  const normalizedTitle = normalizeText(title)?.replace(/\b(?:Mit|Featuring|Feat\.)\s+(?=\p{Lu})/gu,'');
  if (!normalizedTitle) {
    return [];
  }

  const candidates = [];
  const seenKeys = new Set();
  const normalizedChannelKey = normalizeGroupKey(channelName);

  const addCandidate = (value, { weight = 0, isPriority = false } = {}) => {
    const candidate = cleanTopicCandidate(value);
    if (!candidate) {
      return;
    }

    const key = normalizeGroupKey(candidate);
    if (
      !key ||
      seenKeys.has(key) ||
      key === normalizedChannelKey ||
      TOPIC_STOP_PHRASES.has(key) ||
      TOPIC_FRAGMENT_STOP_PHRASES.has(key)
    ) {
      return;
    }

    seenKeys.add(key);
    candidates.push({
      key,
      label: candidate,
      weight,
      isPriority
    });
  };

  for (const entry of PRIORITY_TOPIC_PATTERNS) {
    if (entry.pattern.test(normalizedTitle)) {
      addCandidate(entry.label, {
        weight: TOPIC_CANDIDATE_WEIGHTS.PRIORITY,
        isPriority: true
      });
    }
  }

  for (const match of normalizedTitle.matchAll(TOPIC_PROPER_NAME_GLOBAL_PATTERN)) {
    if (
      typeof match.index === "number" &&
      isEmbeddedInTitleCaseRun(normalizedTitle, match.index, match[1].length)
    ) {
      continue;
    }

    if (isLikelyProperNameCandidate(match[1])) {
      addCandidate(match[1], {
        weight: TOPIC_CANDIDATE_WEIGHTS.PROPER_NAME
      });
    }
  }

  const quotedPattern = /["“”'‘’]([^"“”'‘’]{3,72})["“”'‘’]/g;
  for (const match of normalizedTitle.matchAll(quotedPattern)) {
    if (isLikelyTopicFragmentCandidate(match[1])) {
      addCandidate(match[1], {
        weight: TOPIC_CANDIDATE_WEIGHTS.QUOTED
      });
    }
  }

  const titleSegments = normalizedTitle.split(TOPIC_SEGMENT_SPLIT_PATTERN);
  for (const segment of titleSegments.slice(0, 3)) {
    if (isLikelyTopicFragmentCandidate(segment)) {
      addCandidate(segment, {
        weight: TOPIC_CANDIDATE_WEIGHTS.SEGMENT
      });
    }
  }

  return candidates;
}

function buildTopicPhraseCounts(records) {
  const counts = new Map();

  for (const record of records) {
    const candidates = extractTopicCandidates(record.title, record.channel);
    for (const candidate of candidates) {
      const existing = counts.get(candidate.key);
      if (!existing) {
        counts.set(candidate.key, {
          label: candidate.label,
          count: 1,
          weight: candidate.weight,
          isPriority: candidate.isPriority
        });
        continue;
      }

      existing.count += 1;
      existing.isPriority = existing.isPriority || candidate.isPriority;
      const previousWeight = existing.weight;
      if (candidate.weight > existing.weight) {
        existing.weight = candidate.weight;
      }
      if (
        candidate.weight > previousWeight ||
        (candidate.weight === previousWeight && candidate.label.length > existing.label.length)
      ) {
        existing.label = candidate.label;
      }
    }
  }

  return counts;
}

function fallbackTopicLabel(record) {
  return normalizeChannelName(record?.channel);
}

function deriveTopicLabel(record, phraseCounts, allowChannelFallback = false) {
  if(record?.topicOverride)return record.topicOverride;
  const recognized = recognizeTopic(record?.title, topicAliases.rules);
  if (recognized) return recognized;
  const candidates = extractTopicCandidates(record?.title, record?.channel);
  let bestMatch = null;

  for (const candidate of candidates) {
    const entry = phraseCounts.get(candidate.key);
    if (!entry) {
      continue;
    }

    const isReusableTopic =
      entry.isPriority ||
      entry.weight >= TOPIC_CANDIDATE_WEIGHTS.PROPER_NAME ||
      entry.count >= TOPIC_REPEAT_THRESHOLD;
    if (!isReusableTopic) {
      continue;
    }

    const score = entry.count * 1000 + entry.weight * 10 + Math.min(entry.label.length, 80);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        label: entry.label,
        score
      };
    }
  }

  if (bestMatch) {
    return resolveTopicOverride(bestMatch.label, topicAliases.rules);
  }

  return allowChannelFallback ? resolveTopicOverride(fallbackTopicLabel(record), topicAliases.rules) : "";
}

function parkedMetadata(entry, metadata, saved) {
  return {
    title: preferredVideoTitle(entry.videoId,entry.tabTitle,metadata?.title,saved?.title)||null,
    channel: meaningfulChannel(entry.tabChannel) || meaningfulChannel(metadata?.channel) || meaningfulChannel(saved?.channel) || UNKNOWN_CHANNEL,
    channelKey:metadata?.channelKey||saved?.channelKey,channelHandle:metadata?.channelHandle||saved?.channelHandle,
    topicOverride:saved?.topicOverride||metadata?.topicOverride
  };
}

function buildResolvedGroupRecord(entry, metadata) {
  if(entry.parked)metadata=parkedMetadata(entry,metadata);
  return {
    tabId: entry.tabId,
    incognito: Boolean(entry.incognito),
    windowId: entry.windowId,
    index: entry.index,
    url: entry.url,
    title: normalizeText(metadata?.title),
    channel: normalizeChannelName(metadata?.channel),channelKey:metadata?.channelKey,channelHandle:metadata?.channelHandle,topicOverride:metadata?.topicOverride
  };
}

function buildGroupsFromRecords(records, groupBy, { includeRecords = false } = {}) {
  const normalizedGroupBy = normalizeGroupBy(groupBy);
  const topicPhraseCounts =
    normalizedGroupBy === GROUP_BY.TOPIC ? buildTopicPhraseCounts(records) : null;
  const groupMap = new Map();
  const identity = channelIdentityKeys(records);
  for (const record of records) {
    const label =
      normalizedGroupBy === GROUP_BY.TOPIC
        ? normalizeTopicName(deriveTopicLabel(record, topicPhraseCounts))
        : normalizeChannelName(record.channel);
    const key = normalizedGroupBy===GROUP_BY.CHANNEL ? identity(record)||normalizeGroupKey(label) : normalizeGroupKey(label);
    const existing = groupMap.get(key);

    if (!existing) {
      groupMap.set(key, {
        key,
        label,
        count: 1,
        records: includeRecords ? [record] : undefined
      });
      continue;
    }

    existing.count += 1;
    if (includeRecords) {
      existing.records.push(record);
    }
    if (compareStrings(label, existing.label) < 0) {
      existing.label = label;
    }
  }

  return Array.from(groupMap.values()).sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }

    return compareStrings(a.label, b.label);
  });
}

async function createGroupScanState() {
  const generation = scanGeneration;
  const rawEntries = await collectRawWatchTabs();
  replaceKnownWatchTabIds(rawEntries);
  const cached = await metadataCache.getMany(rawEntries.map(entry=>entry.videoId));
  const savedById=new Map((await inbox.list()).filter(item=>!item.metadataPrivate).map(item=>[item.videoId,item]));
  const records=[],pendingEntries=[];
  for(const entry of rawEntries) {
    const metadata=entry.parked&&entry.incognito?null:cached.get(entry.videoId);
    // Parked pages already contain their available local title. Resolve them
    // before network-backed entries, even in a large mixed tab collection.
    const saved=entry.incognito?null:savedById.get(entry.videoId);
    if(entry.parked||metadata) records.push(buildResolvedGroupRecord(entry,entry.parked?parkedMetadata(entry,metadata,saved):{...metadata,topicOverride:saved?.topicOverride}));
    else pendingEntries.push(entry);
  }
  return {generation,createdAt:Date.now(),matchedTabs:rawEntries.length,records,pendingEntries,nextIndex:0,groupsCache:new Map(),
    hasParkedRecords:rawEntries.some(entry=>entry.parked),firstSnapshotReturned:false};
}
async function resolveGroupScanChunk(state) {
  const entries=state.pendingEntries.slice(state.nextIndex,state.nextIndex+CHANNEL_SCAN_CHUNK_SIZE);
  if(!entries.length)return;
  const results=await mapWithConcurrency(entries,CHANNEL_SCAN_CONCURRENCY,async entry=>{
    const info=await getMetadataPromise(entry),saved=entry.incognito?null:await inbox.get(entry.videoId);
    return buildResolvedGroupRecord(entry,{...info,topicOverride:saved?.topicOverride});
  });
  await metadataCache.flush(); // A completed chunk survives worker termination.
  if(state.generation !== scanGeneration) return;
  state.records.push(...results);state.nextIndex+=entries.length;state.groupsCache.clear();
}

// Give the UI one immediate snapshot of local parked titles. Subsequent polls
// advance the normal metadata queue; the partial flag still guards actions.
async function resolveGroupScanForSnapshot(state) {
  const localFirst=!state.firstSnapshotReturned&&state.hasParkedRecords;
  state.firstSnapshotReturned=true;
  if(!localFirst)await resolveGroupScanChunk(state);
}

function getCachedStateGroups(state, groupBy) {
  const cacheKey = normalizeGroupBy(groupBy);
  const cached = state.groupsCache.get(cacheKey);
  if (cached && cached.recordCount === state.records.length) {
    return cached.groups;
  }

  const groups = buildGroupsFromRecords(state.records, groupBy);
  state.groupsCache.set(cacheKey, {
    recordCount: state.records.length,
    groups
  });
  return groups;
}

function buildGroupScanSnapshot(state, groupBy) {
  const unresolvedTabs = Math.max(0, state.pendingEntries.length - state.nextIndex);
  const resolvedTabs = state.records.length;
  const groups = getCachedStateGroups(state, groupBy)
    .filter((item) => item.count > channelActionMinCount)
    .map((item) => ({
      key: item.key,
      label: item.label,
      count: item.count
    }));

  return {
    groupBy: normalizeGroupBy(groupBy),
    matchedTabs: state.matchedTabs,
    resolvedTabs,
    unresolvedTabs,
    isPartial: unresolvedTabs > 0 || state.generation !== scanGeneration,
    channelActionMinCount,
    minChannelTabs: channelActionMinCount + 1,
    topicChoices: groupBy === GROUP_BY.TOPIC
      ? getCachedStateGroups(state, groupBy).map(({ label }) => label) : [],
    groups
  };
}

async function ensureGroupScanState() {
  if(!channelScanState || channelScanState.generation!==scanGeneration || (channelScanState.nextIndex>=channelScanState.pendingEntries.length && channelScanState.createdAt && Date.now()-channelScanState.createdAt>60000)) channelScanState=await createGroupScanState();
  return channelScanState;
}
async function handleGetGroupActions(rawGroupBy) {
  return withScanQueue(async()=>{
    await ensureSettingsLoaded();await topicAliases.load();
    let snapshot=await ensureGroupScanState();
    await resolveGroupScanForSnapshot(snapshot);
    if(snapshot.generation!==scanGeneration) snapshot=await ensureGroupScanState();
    return {ok:true,...buildGroupScanSnapshot(snapshot,normalizeGroupBy(rawGroupBy)),cacheError:metadataCache.error};
  });
}
// Both columns use the same scan and global topic vocabulary. Window filtering
// happens after recognition, so a topic keeps its identity across views/actions.
async function handleDashboardGroups(windowId) {
  validateWindowId(windowId);
  return withScanQueue(async()=>{
    await ensureSettingsLoaded();await topicAliases.load();
    let state=await ensureGroupScanState();
    await resolveGroupScanForSnapshot(state);
    if(state.generation!==scanGeneration)state=await ensureGroupScanState();
    const groupsFor=mode=>buildGroupsFromRecords(state.records,mode,{includeRecords:true})
      .map(group=>{
        const records=group.records.filter(record=>windowId===undefined || record.windowId===windowId);
        return {key:group.key,label:group.label,count:records.length,tabIds:records.map(record=>record.tabId)};
      }).filter(group=>group.count).sort((a,b)=>b.count-a.count || compareStrings(a.label,b.label));
    return {ok:true,channels:groupsFor(GROUP_BY.CHANNEL),topics:groupsFor(GROUP_BY.TOPIC),
      resolvedTabs:state.records.length,matchedTabs:state.matchedTabs,
      isPartial:state.nextIndex<state.pendingEntries.length || state.generation!==scanGeneration,
      cacheError:metadataCache.error};
  });
}
async function getMatchingGroupRecords(groupBy,rawGroupKey) {
  await topicAliases.load();
  const snapshot=await ensureGroupScanState();
  if(snapshot.generation!==scanGeneration || snapshot.nextIndex<snapshot.pendingEntries.length) throw Error(globalThis.atelierI18n.t("ui_analysis_has_not_finished_yet_f55447"));
  return buildGroupsFromRecords(snapshot.records,groupBy,{includeRecords:true}).find(group=>group.key===rawGroupKey)||null;
}

async function handleGetSettings() {
  await ensureSettingsLoaded();

  return {
    ok: true,
    channelActionMinCount
  };
}

function createTabGroupTitle(channelName) {
  const title = normalizeChannelName(channelName);
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
}

async function downloadJson(payload) {
  const json = JSON.stringify(payload, null, 2);
  const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `youtube-watch-tabs-export-${fileTimestamp}.json`;

  await chrome.downloads.download({
    url: `data:application/json;charset=utf-8,${encodeURIComponent(json)}`,
    filename,
    saveAs: true,
    conflictAction: "uniquify"
  });

  return filename;
}

async function groupStep(job,ctx) {
  const groupBy=normalizeGroupBy(job.payload.groupBy),key=groupLookupKey(job.payload.groupKey);
  validateWindowId(job.payload.windowId);
  if(!key)throw Error(globalThis.atelierI18n.t("ui_group_name_is_missing_2c8f3d"));
  if(!job.prepared) {
    job.phase=globalThis.atelierI18n.t("ui_analyzing_youtube_8a9877");
    const snapshot=await handleGetGroupActions(groupBy);
    job.processed=snapshot.resolvedTabs;job.total=snapshot.matchedTabs;
    if(snapshot.isPartial)return false;
    let group;
    try { group=await getMatchingGroupRecords(groupBy,key); }
    catch(error) { if(error.message===globalThis.atelierI18n.t("ui_analysis_has_not_finished_yet_f55447")) return false; throw error; }
    const records=(group?.records||[]).filter(record=>job.payload.windowId===undefined || record.windowId===job.payload.windowId);
    await ctx.write(records);job.prepared=true;job.cursor=0;job.processed=0;job.total=records.length;
    job.label=group?.label||job.payload.groupKey;job.count=0;job.destinations={};job.groups={};
  }
  const records=await ctx.read();
  if(job.type==='move-group-to-window') {
    const done=await transferStep(job,ctx,records,{api:chrome,groupTitle:createTabGroupTitle(job.label),reuseGroups:true,sourceWindowId:job.payload.windowId,matches:(tab,record)=>
      !tab.pendingUrl && tab.status!=='loading' && !!tab.incognito===!!record.incognito &&
      Boolean(parseWatchVideo(record.url)?.videoId) && parseYouTubeTab(tab.url)?.videoId===parseWatchVideo(record.url)?.videoId});
    if(done)resetGroupScanState();return done;
  }
  job.phase=job.type==="close-group-tabs"?globalThis.atelierI18n.t("ui_closing_group_0b5167"):globalThis.atelierI18n.t("ui_moving_group_f5f12b");
  for(const record of records.slice(job.cursor,job.cursor+10)) {
    if(ctx.cancelled())break;
    let live;try{live=await chrome.tabs.get(record.tabId)}catch{}
    const videoId=parseWatchVideo(record.url)?.videoId;
    if(live && (job.payload.windowId===undefined || live.windowId===job.payload.windowId) && videoId && canCloseYouTubeSource(live.url) && !live.pendingUrl && live.status!=="loading" && parseYouTubeTab(live.url)?.videoId===videoId && Boolean(live.incognito)===Boolean(record.incognito)) {
      await ctx.effect(async()=>{
        try{live=await chrome.tabs.get(record.tabId)}catch{live=null;}
        if(!live || (job.payload.windowId!==undefined && live.windowId!==job.payload.windowId) || !canCloseYouTubeSource(live.url) || live.pendingUrl || live.status==="loading" || parseYouTubeTab(live.url)?.videoId!==videoId || Boolean(live.incognito)!==Boolean(record.incognito)) {
          job.cursor++;job.processed=job.cursor;return;
        }
        await chrome.tabs.remove(live.id);
        job.count++;job.cursor++;job.processed=job.cursor;
      });
    } else {job.cursor++;job.processed=job.cursor;}
  }
  if(job.cursor<records.length)return false;
  resetGroupScanState();
  job.result={ok:true,label:job.label,closedTabs:job.count,movedTabs:job.count,windowsCreated:Object.keys(job.destinations).length,groupCreated:Object.keys(job.groups).length>0,skipped:records.length-job.count};
  return true;
}
async function exportStep(job,ctx) {
  if(!job.prepared) {
    const [watchResult,allTabs]=await Promise.all([collectWatchTabs(),chrome.tabs.query({})]);
    await ctx.write(watchResult.entries);
    job.prepared=true;job.total=watchResult.entries.length;job.totalOpenTabs=allTabs.length;job.matchedTabs=watchResult.matchedTabs;job.chunks=[];
  }
  job.phase=globalThis.atelierI18n.t("ui_preparing_export_7eea02");
  const entries=await ctx.read();
  const selected=entries.slice(job.cursor,job.cursor+4);
  if(selected.length) {
    const items=await buildItems(selected);await metadataCache.flush();
    if(ctx.cancelled())return false;
    const chunk=`items-${job.cursor}`;await ctx.write(items,chunk);job.chunks.push(chunk);
    job.cursor+=selected.length;job.processed=job.cursor;
  }
  if(job.cursor<entries.length)return false;
  job.phase=globalThis.atelierI18n.t("ui_ready_to_save_c90fc6");
  job.result={ok:true,taskId:job.id,exportReady:true,count:job.total,matchedTabs:job.matchedTabs};return true;
}
async function finishExport(taskId) {
  return runExclusive(async()=>{
    const {task}=await tasks.data(taskId);
    if(task.type!=="export-watch-tabs" || task.status!=="done")throw Error(globalThis.atelierI18n.t("ui_the_export_is_not_ready_yet_8ce1b4"));
    if(task.result.filename)return {ok:true,...task.result};
    if(task.downloadPending)throw Error(globalThis.atelierI18n.t("ui_saving_was_interrupted_check_chrome_downloads_first_4ba870"));
    const items=[];
    for(const chunk of task.chunks) items.push(...(await tasks.data(taskId,chunk)).value);
    task.downloadPending=true;await tasks.save();
    try {
      const filename=await downloadJson(buildPayload({totalOpenTabs:task.totalOpenTabs,matchedTabs:task.matchedTabs,items:sortItemsByChannel(items)}));
      task.result.filename=filename;task.downloadPending=false;task.result.exportReady=false;
      await chrome.storage.session.remove(task.keys || []);task.keys=[];await tasks.save();
      await chrome.runtime.sendMessage({type:"tasks-changed"}).catch(()=>{});
      return {ok:true,...task.result};
    } catch(error){task.downloadPending=false;await tasks.save();throw error;}
  });
}
tasks.register("move-group-to-window",groupStep);
tasks.register("close-group-tabs",groupStep);
tasks.register("export-watch-tabs",exportStep);

function handleRelevantTabChange() {
  resetGroupScanState();
}

function isWatchUrlLike(rawUrl) {
  return Boolean(parseYouTubeTab(rawUrl));
}

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab?.id === "number" && isWatchUrlLike(tab.pendingUrl || tab.url)) {
    knownWatchTabIds.add(tab.id);
    handleRelevantTabChange();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!knownWatchTabIds.delete(tabId)) {
    return;
  }

  handleRelevantTabChange();
});

chrome.tabs.onAttached?.addListener(tabId=>{if(knownWatchTabIds.has(tabId))handleRelevantTabChange();});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!knownWatchTabIds.delete(removedTabId)) {
    return;
  }

  knownWatchTabIds.add(addedTabId);
  handleRelevantTabChange();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const changedUrl = typeof changeInfo.url === "string" ? changeInfo.url : null;
  const nextIsWatch = changedUrl
    ? isWatchUrlLike(changedUrl)
    : isWatchUrlLike(tab?.pendingUrl || tab?.url);
  const wasWatch = isKnownWatchTabId(tabId);

  if (!changedUrl) {
    if(changeInfo.title!==undefined && (nextIsWatch||wasWatch))handleRelevantTabChange();
    return;
  }

  if (nextIsWatch) {
    knownWatchTabIds.add(tabId);
  } else {
    knownWatchTabIds.delete(tabId);
  }

  if (nextIsWatch || wasWatch) {
    handleRelevantTabChange();
  }
});

ensureSettingsLoaded().catch(() => {
  // Ignore transient storage read errors.
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[ALIAS_STORAGE_KEY]) topicAliases.replace(changes[ALIAS_STORAGE_KEY].newValue);

  if (changes[STORAGE_KEYS.CHANNEL_THRESHOLD]) {
    channelActionMinCount = normalizeChannelActionMinCount(
      changes[STORAGE_KEYS.CHANNEL_THRESHOLD].newValue
    );
    settingsLoaded = true;
    notifyGroupSnapshotChanged();
  }
});

const backgroundRequestTypes = new Set([
  ...Object.values(MESSAGE_TYPES).filter(type => type !== MESSAGE_TYPES.GROUPS_INVALIDATED),
  'get-dashboard-groups', 'metadata-cache-stats', 'metadata-cache-clear', 'download-export',
  'get-topic-aliases', 'save-topic-aliases', 'remove-topic-alias'
]);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Other modules authenticate and handle their own routes, including the
  // tab-limit notice. Do not race them with an unrelated denial response.
  if (!backgroundRequestTypes.has(message?.type)) return false;
  if (!isTrustedPage(sender)) {
    sendResponse({ ok: false, error: globalThis.atelierI18n.t("ui_unauthorized_message_source_674efb") });
    return false;
  }

  if (message?.type === "get-dashboard-groups") {
    handleDashboardGroups(message.windowId).then(sendResponse,error=>sendResponse({ok:false,error:error.message}));
    return true;
  }

  if (["metadata-cache-stats", "metadata-cache-clear", "download-export"].includes(message?.type)) {
    const action = message.type === "metadata-cache-stats" ? metadataCache.stats().then(stats=>({ok:true,...stats})) :
      message.type === "metadata-cache-clear" ? withScanQueue(async()=>{await metadataCache.clear();inFlightMetadataRequests.clear();resetGroupScanState();return {ok:true};}) : finishExport(message.taskId);
    action.then(sendResponse,error=>sendResponse({ok:false,error:error.message}));return true;
  }

  const aliasHandlers = {
    "get-topic-aliases": () => topicAliases.list(),
    "save-topic-aliases": () => topicAliases.save(message.target, message.aliases),
    "remove-topic-alias": () => topicAliases.remove(message.alias)
  };
  if (Object.hasOwn(aliasHandlers, message?.type)) {
    Promise.resolve().then(aliasHandlers[message.type]).then(sendResponse,
      error => sendResponse({ ok: false, error: error.message || globalThis.atelierI18n.t("ui_could_not_save_the_topic_rule_cd2e2b") }));
    return true;
  }

  if (message?.type === MESSAGE_TYPES.EXPORT_WATCH_TABS) {
    tasks.start("export-watch-tabs", {}, globalThis.atelierI18n.t("ui_youtube_export_7dd80b"))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || globalThis.atelierI18n.t("ui_export_failed_e6a141")
        })
      );

    return true;
  }

  if (message?.type === MESSAGE_TYPES.GET_GROUP_ACTIONS) {
    handleGetGroupActions(message?.groupBy)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || globalThis.atelierI18n.t("ui_could_not_load_groups_431aa3")
        })
      );

    return true;
  }

  if (message?.type === MESSAGE_TYPES.MOVE_GROUP_TO_WINDOW) {
    const requestedGroupKey = normalizeText(message?.groupKey);
    if (!requestedGroupKey) {
      sendResponse({ ok: false, error: globalThis.atelierI18n.t("ui_group_name_is_missing_2c8f3d") });
      return false;
    }

    tasks.start("move-group-to-window", { groupBy:message.groupBy, groupKey:requestedGroupKey, windowId:message.windowId }, globalThis.atelierI18n.t("ui_move_youtube_group_95bb22"))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || globalThis.atelierI18n.t("ui_could_not_move_the_group_8180cc")
        })
      );

    return true;
  }

  if (message?.type === MESSAGE_TYPES.CLOSE_GROUP_TABS) {
    const requestedGroupKey = normalizeText(message?.groupKey);
    if (!requestedGroupKey) {
      sendResponse({ ok: false, error: globalThis.atelierI18n.t("ui_group_name_is_missing_2c8f3d") });
      return false;
    }

    tasks.start("close-group-tabs", { groupBy:message.groupBy, groupKey:requestedGroupKey, windowId:message.windowId }, globalThis.atelierI18n.t("ui_close_youtube_group_f01ecb"))
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || globalThis.atelierI18n.t("ui_could_not_close_the_group_6228c8")
        })
      );

    return true;
  }

  if (message?.type === MESSAGE_TYPES.GET_SETTINGS) {
    handleGetSettings()
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || globalThis.atelierI18n.t("ui_could_not_load_settings_456203")
        })
      );

    return true;
  }

  if (message?.type === MESSAGE_TYPES.SET_CHANNEL_THRESHOLD) {
    persistChannelActionMinCount(message?.channelActionMinCount)
      .then((updatedValue) =>
        sendResponse({
          ok: true,
          channelActionMinCount: updatedValue
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || globalThis.atelierI18n.t("ui_could_not_save_the_threshold_74ac9e")
        })
      );

    return true;
  }
  return false;
});

const inbox = installInbox({api:chrome,tasks,getMetadata:getMetadataPromise,getLocalMetadata:ids=>metadataCache.getMany(ids),
  classificationVersion:()=>topicRevision,metadataStatus:()=>automaticMetadata.status(),
  enrichMetadata:async entry=>{
    const local=await getMetadataPromise(entry);
    if(local.title&&meaningfulChannel(local.channel)&&!hasCardDuration(local.title))return local;
    return withMetadataSlot(async()=>{
      const revision=metadataCache.revision;
      let fetched;try{fetched=await fetchOEmbed(entry.url)}catch{return local}
      const result={title:hasCardDuration(local.title)&&!hasCardDuration(fetched.title)?fetched.title||local.title:local.title||fetched.title,
        channel:meaningfulChannel(local.channel)||fetched.channel,channelKey:!meaningfulChannel(local.channel)||local.channel===fetched.channel?fetched.channelKey:local.channelKey};
      await metadataCache.set(entry.videoId,result,revision);await metadataCache.flush();return result;
    });
  },onMetadataChanged:()=>resetGroupScanState(),
  selectGroup:async(groupBy,key)=>{
    const result=await handleGetGroupActions(groupBy);
    if(result.isPartial)throw Error(globalThis.atelierI18n.t("ui_wait_for_the_current_youtube_analysis_in_the_dashboa_6afac7"));
    const group=await getMatchingGroupRecords(groupBy,groupLookupKey(key));
    return (group?.records||[]).map(record=>record.tabId);
  },
  decorate:async items=>{
    await topicAliases.load();
    const topics=new Map();
    for(const group of buildGroupsFromRecords(items,'topic',{includeRecords:true}))for(const item of group.records)topics.set(item.videoId,group.label);
    const identity=channelIdentityKeys(items);
    const labels=new Map();
    for(const item of items){
      const key=identity(item);
      if(key&&meaningfulChannel(item.channel)&&(!labels.has(key)||labels.get(key).addedAt<item.addedAt))labels.set(key,item);
    }
    return items.map(item=>({...item,channel:labels.get(identity(item))?.channel||item.channel,
      channelGroupKey:identity(item)||normalizeGroupKey(item.channel),
      topic:topics.get(item.videoId)||UNKNOWN_TOPIC}));
  }
});

const automaticMetadata=installAutomaticMetadata({api:chrome,store:inbox,
  getLocalMetadata:ids=>metadataCache.getMany(ids),
  readLoadedMetadata:(tab,id)=>readMetadataFromDom(tab.id,id),
  fetchMetadata:async url=>{
    const info=await fetchOEmbed(url),video=parseWatchVideo(url);
    if(video){await metadataCache.set(video.videoId,info);await metadataCache.flush();}
    return info;
  },
  onMetadataChanged:()=>resetGroupScanState()
});
export {inbox};

// Restore pending work after Chrome has registered every handler.
tasks.resume().catch(error=>console.warn(globalThis.atelierI18n.t("ui_resuming_tasks_fb1fc1"),error));

installParkerUpdate(chrome);



// The automatic pass uses only local sources. In particular, it never calls
// getMetadataPromise, whose dashboard path can request oEmbed.
const automaticDomMetadata = new Map();
chrome.tabs.onRemoved.addListener(id=>automaticDomMetadata.delete(id));
chrome.tabs.onReplaced.addListener((_id,oldId)=>automaticDomMetadata.delete(oldId));
async function resolveAutomaticGroupLabels(entries, mode) {

  if (!entries.length) return new Map();

  const cached = await metadataCache.getMany(entries.filter(({ tab }) => !tab.incognito)
    .map(({ video }) => video.videoId));
  const records = await mapWithConcurrency(entries, METADATA_CONCURRENCY, async ({ tab, video }) => {
    const stored = tab.incognito ? null : cached.get(video.videoId);
    let title = video.parked ? parkedVideoTitle(video, tab.title) : "";
    let channel = meaningfulChannel(video.channel), channelKey,channelHandle,topicOverride;
    if (!video.parked && !tab.discarded && tab.status === "complete" &&
      (!meaningfulChannel(stored?.channel) || !meaningfulYouTubeTitle(stored?.title, video.videoId))) {
      const previous = automaticDomMetadata.get(tab.id);
      let dom = previous?.url === tab.url && previous.tabTitle === tab.title ? previous.metadata : null;
      if (!dom) {
        dom = await withMetadataSlot(() => withTimeout(readMetadataFromDom(tab.id, video.videoId), 3000))
          .catch(() => ({}));
        if(automaticDomMetadata.size>=1000)automaticDomMetadata.delete(automaticDomMetadata.keys().next().value);
        automaticDomMetadata.set(tab.id, { url: tab.url, tabTitle: tab.title, metadata: dom });
      }
      title = meaningfulYouTubeTitle(dom.title, video.videoId);
      channel = meaningfulChannel(dom.channel);channelKey=dom.channelKey;channelHandle=dom.channelHandle;
    }
    if (tab.discarded || tab.status !== "complete") automaticDomMetadata.delete(tab.id);
    title=preferredVideoTitle(video.videoId,title,stored?.title);
    channel ||= meaningfulChannel(stored?.channel);
    channelKey||=stored?.channelKey;channelHandle||=stored?.channelHandle;
    if (!tab.incognito && (!title || !channel || hasCardDuration(title)||mode==='topic'||!channelKey)) {
      const saved = await inbox.get(video.videoId);
      title=preferredVideoTitle(video.videoId,title,saved?.title);
      channel ||= meaningfulChannel(saved?.channel);
      channelKey||=saved?.channelKey;channelHandle||=saved?.channelHandle;topicOverride=saved?.topicOverride;
    }
    if (!video.parked && (tab.status === "complete" || tab.discarded)) title ||= meaningfulYouTubeTitle(fallbackTitleFromTab(tab.title), video.videoId);
    return { tabId: tab.id, windowId: tab.windowId, title, channel,channelKey,channelHandle,topicOverride };
  });

  const labels = new Map();
  const identity=channelIdentityKeys(records);
  const byWindow = new Map();
  for (const record of records) {
    if (!byWindow.has(record.windowId)) byWindow.set(record.windowId, []);
    byWindow.get(record.windowId).push(record);
  }
  if (mode === "topic") await topicAliases.load();
  for (const windowRecords of byWindow.values()) {
    const phraseCounts = mode === "topic" ? buildTopicPhraseCounts(windowRecords) : null;
    for (const record of windowRecords) {
      const label = mode === "topic"
        ? (record.title||record.topicOverride) && deriveTopicLabel(record, phraseCounts, false)
        : record.channel;
      const key = mode==='channel' ? identity(record)||normalizeGroupKey(label) : normalizeGroupKey(label);
      if (key && label !== UNKNOWN_TOPIC && label !== UNKNOWN_CHANNEL) {
        labels.set(record.tabId, { key, title: createTabGroupTitle(label) });
      }
    }
  }
  return labels;
}

installYouTubeAutoGroups(chrome, { resolveLabels: resolveAutomaticGroupLabels });
