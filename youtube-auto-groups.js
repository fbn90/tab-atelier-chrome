import {reviewProtection} from './inbox-review-protection.js';
import { runExclusive } from './action-coordinator.js';
import { AUTOMATION_SETTINGS, readTabSettings } from './tab-settings.js';
import { discoverTabParkers, parseYouTubeTab, tabParkerTarget } from './youtube-url.js';
import { ALIAS_STORAGE_KEY } from './topic-alias-store.js';
import { INBOX_PREFIX } from './inbox-store.js';

const OWNED_GROUPS = 'youtubeAutoGroupsV1';
const eligible = (tab, owned) => tab && !tab.pinned && (!tab.pendingUrl || tab.pendingUrl === tab.url) &&
  (tab.groupId === -1 || owned.has(tab.groupId));
const matchesGroup = (group, record) =>
  record && !group.shared && group.windowId === record.windowId && group.title === record.title;

export function installYouTubeAutoGroups(api, { resolveLabels }) {
  if (!api.tabGroups?.query || !api.windows?.getAll || !api.tabs.group) return;
  let timer;
  let running = false;
  let scanAll = false;
  const pendingWindows = new Set();
  const videosByWindow = new Map();
  let mode;
  let disposed = false;

  function schedule(windowId) {
    if (disposed) return;
    if (Number.isInteger(windowId)) pendingWindows.add(windowId);
    else scanAll = true;
    arm();
  }
  function arm() {
    if (running || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      reconcile().catch(error => console.warn('YouTube automatic grouping:', error));
    }, 200);
  }

  async function reconcile() {
    const all = scanAll;
    const dirty = [...pendingWindows];
    scanAll = false;
    pendingWindows.clear();
    running = true;
    try {
      mode = (await readTabSettings(api)).youtubeGrouping;
      if (mode === 'off') return;
      const passMode = mode;
      const [windows, stored] = await Promise.all([
        all ? api.windows.getAll({windowTypes:['normal']})
          : Promise.all(dirty.map(id=>api.windows.get(id).catch(()=>null))),
        api.storage.session.get(OWNED_GROUPS)
      ]);
      const windowIds = new Set(windows.filter(window=>window?.type==='normal').map(window=>window.id));
      const tabs = all ? await api.tabs.query({}) :
        (await Promise.all([...windowIds].map(windowId=>api.tabs.query({windowId})))).flat();
      const groups = all ? await api.tabGroups.query({}) :
        (await Promise.all([...windowIds].map(windowId=>api.tabGroups.query({windowId})))).flat();
      const records = stored[OWNED_GROUPS] || {};
      const owned = new Map(Object.entries(records).filter(([,record])=>!all&&!dirty.includes(record.windowId))
        .map(([id,record])=>[Number(id),record]));
      for(const group of groups)if(matchesGroup(group,records[group.id]))owned.set(group.id,records[group.id]);
      if(all)videosByWindow.clear();
      else for(const id of dirty)videosByWindow.delete(id);
      const review=await reviewProtection(api,tabs);
      const candidates = tabs.filter(tab => !review.admitted.has(tab.id)&&windowIds.has(tab.windowId)&&eligible(tab,owned));
      await discoverTabParkers(api, candidates);
      const entries = candidates.flatMap(tab => {
        const video = parseYouTubeTab(tab.url);
        return video ? [{ tab, video }] : [];
      });
      for(const {tab,video} of entries){
        if(!videosByWindow.has(tab.windowId))videosByWindow.set(tab.windowId,new Set());
        videosByWindow.get(tab.windowId).add(video.videoId);
      }
      const labels = await resolveLabels(entries, passMode);
      const buckets = new Map();
      for (const { tab } of entries) {
        const label = labels.get(tab.id);
        if (!label) continue;
        const key = JSON.stringify([tab.windowId, label.key]);
        if (!buckets.has(key)) buckets.set(key, { ...label, windowId: tab.windowId, tabs: [] });
        buckets.get(key).tabs.push(tab);
      }

      // Chrome assigns a new session's group IDs independently. Only use IDs
      // observed in this session and still matching their original window/title.
      const persist = () => api.storage.session.set({ [OWNED_GROUPS]: Object.fromEntries(owned) });
      if (owned.size !== Object.keys(records).length) await persist();

      const destinations = new Map();
      for (const [id, group] of owned) {
        if (group.mode !== passMode) continue;
        const key = JSON.stringify([group.windowId, group.key]);
        if (!destinations.has(key)) destinations.set(key, id);
      }
      for (const [key, bucket] of buckets) {
        if (bucket.tabs.every(tab => tab.groupId === destinations.get(key))) continue;
        if (disposed || mode !== passMode) break;
        await runExclusive(async () => {
          if ((await readTabSettings(api)).youtubeGrouping !== passMode) return;
          const currentGroups = await api.tabGroups.query({ windowId: bucket.windowId });
          const currentOwned = new Map(currentGroups.filter(group => matchesGroup(group, owned.get(group.id)))
            .map(group => [group.id, owned.get(group.id)]));
          const destination = [...currentOwned].find(([, group]) => group.mode === passMode && group.key === bucket.key)?.[0];
          const moving = bucket.tabs.filter(tab => tab.groupId !== destination);
          if (!moving.length) return;
          const liveTabs = await Promise.all(moving.map(tab => api.tabs.get(tab.id).catch(() => null)));
          const review=await reviewProtection(api,await api.tabs.query({windowId:bucket.windowId}));
          const ids = moving.filter((snapshot, index) => {
            const live = liveTabs[index];
            return !review.admitted.has(live?.id)&&eligible(live, currentOwned) && live.windowId === snapshot.windowId &&
              live.groupId === snapshot.groupId && live.url === snapshot.url &&
              (passMode !== 'topic' || live.title === snapshot.title);
          }).map(tab => tab.id);
          if (!ids.length || mode !== passMode) return;

          if (destination !== undefined) {
            await api.tabs.group({ tabIds: ids, groupId: destination });
          } else {
            const groupId = await api.tabs.group({ tabIds: ids, createProperties: { windowId: bucket.windowId } });
            const group = await api.tabGroups.update(groupId, { title: bucket.title, color: 'blue' });
            if (group?.windowId !== bucket.windowId || group.title !== bucket.title) return;
            owned.set(groupId, { windowId: group.windowId, title: group.title, key: bucket.key, mode: passMode });
            await persist();
          }
        }, api).catch(error => {
          // A tab or destination group may disappear while Chrome applies a
          // batch. Its next tab event supplies a fresh snapshot.
          console.debug('YouTube group changed during sorting:', error);
        });
      }
    } finally {
      running = false;
      if (scanAll || pendingWindows.size) arm();
    }
  }

  const active = () => mode !== 'off';
  const isVideo = url => parseYouTubeTab(url) || tabParkerTarget(url, true);
  api.tabs.onCreated.addListener(tab => { if (active() && isVideo(tab.pendingUrl || tab.url)) schedule(tab.windowId); });
  api.tabs.onUpdated.addListener((_id, change, tab) => {
    if (active() && ['url', 'title', 'groupId', 'pinned', 'discarded', 'status'].some(key => key in change) &&
      isVideo(tab?.pendingUrl || tab?.url || change.url)) schedule(tab?.windowId);
  });
  api.tabs.onAttached?.addListener(id => {
    if (active()) api.tabs.get(id).then(tab => { if (isVideo(tab.url)) schedule(tab.windowId); }).catch(() => {});
  });
  api.tabs.onReplaced?.addListener(id => {
    if(active())api.tabs.get(id).then(tab=>{if(isVideo(tab.url))schedule(tab.windowId)}).catch(()=>{});
  });
  api.tabGroups.onRemoved?.addListener(group => { if (active()) schedule(group.windowId); });
  api.tabGroups.onUpdated?.addListener(group => { if (active() && group.shared) schedule(group.windowId); });
  api.windows.onRemoved?.addListener(id => videosByWindow.delete(id));
  api.runtime.onStartup.addListener(() => schedule());
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (AUTOMATION_SETTINGS in changes) {
      const before = changes[AUTOMATION_SETTINGS].oldValue?.youtubeGrouping ?? 'channel';
      const after = changes[AUTOMATION_SETTINGS].newValue?.youtubeGrouping ?? 'channel';
      if (before !== after) {
        mode = after;
        schedule();
      }
    }
    if (!active()) return;
    if (ALIAS_STORAGE_KEY in changes && mode === 'topic') schedule();
    const changedVideos = new Set();
    for(const [key,change] of Object.entries(changes)){
      if(key.startsWith(INBOX_PREFIX)){
        if(change.oldValue?.title!==change.newValue?.title || change.oldValue?.channel!==change.newValue?.channel || change.oldValue?.channelKey!==change.newValue?.channelKey ||
          change.oldValue?.topicOverride!==change.newValue?.topicOverride)
          changedVideos.add(key.slice(INBOX_PREFIX.length));
      }else if(key.startsWith('ytMetadataV2:')){
        const before=change.oldValue||{},after=change.newValue||{};
        for(const id of new Set([...Object.keys(before),...Object.keys(after)])){
          if(before[id]?.title!==after[id]?.title || before[id]?.channel!==after[id]?.channel || before[id]?.channelKey!==after[id]?.channelKey)changedVideos.add(id);
        }
      }
    }
    if(changedVideos.size){
      const changed=[...changedVideos];
      for(const [windowId,ids] of videosByWindow)if(changed.some(id=>ids.has(id)))schedule(windowId);
    }
  });
  schedule();
  return { dispose() { disposed = true; clearTimeout(timer); } };
}
