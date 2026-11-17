import './i18n.js';
import {canCloseYouTubeSource, meaningfulChannel, meaningfulYouTubeTitle, parseYouTubeTab, parkedVideoTitle} from './youtube-url.js';

export function limitedVideo(tab) {
  return tab && !tab.incognito && parseYouTubeTab(tab.pendingUrl || tab.url);
}

export function archiveCandidate(tab) {
  if (!tab || tab.incognito || tab.active || tab.pinned || tab.audible ||
      tab.pendingUrl || tab.status === 'loading' || !canCloseYouTubeSource(tab.url)) return null;
  return parseYouTubeTab(tab.url);
}

export async function archiveOverflowTab(api, store, snapshot, mayClose=async()=>true) {
  let tab = await api.tabs.get(snapshot.id).catch(() => null);
  const video = archiveCandidate(tab);
  if (!video || tab.url !== snapshot.url || tab.windowId !== snapshot.windowId || tab.groupId !== snapshot.groupId) return false;
  const title = video.parked ? parkedVideoTitle(video, tab.title) : meaningfulYouTubeTitle(tab.title?.replace(/\s+-\s+YouTube\s*$/i,''),video.videoId);
  const channel = meaningfulChannel(video.channel);
  await store.merge([{videoId: video.videoId, openUrl: video.sourceUrl, sourceUrls: [video.sourceUrl],
    title, channel, metadataComplete: !!title && !!channel}], {fillMissing: true});
  const saved = await store.get(video.videoId);
  if (!saved?.sourceUrls.includes(video.sourceUrl)) throw Error(globalThis.atelierI18n.t('overflowStorageError'));
  if(!await mayClose())return false;
  tab = await api.tabs.get(snapshot.id).catch(() => null);
  if (!archiveCandidate(tab) || tab.url !== snapshot.url || tab.windowId !== snapshot.windowId || tab.groupId !== snapshot.groupId) return false;
  await api.tabs.remove(tab.id);
  return true;
}
