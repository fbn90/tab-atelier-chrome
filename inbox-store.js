import './i18n.js';
import {hasCardDuration} from './youtube-metadata.js';
import { meaningfulChannel, meaningfulYouTubeTitle, parseYouTubeVideo } from './youtube-url.js';
import { createActionQueue } from './action-coordinator.js';
export const INBOX_PREFIX='videoInboxV1:';
export const INBOX_STATES=['open','done','keep'];
export function inboxSelection(value) {
  if(!Array.isArray(value)||!value.length||value.length>10000||value.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw Error(globalThis.atelierI18n.t("ui_please_select_between_1_and_10_000_saved_videos_645de8"));
  return [...new Set(value)];
}
const clean=(value,max=1000)=>typeof value==='string'?value.trim().slice(0,max):'';
const date=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;
export function normalizeInboxItem(raw, now=Date.now()) {
  if(!raw || typeof raw!=='object')throw Error(globalThis.atelierI18n.t("ui_invalid_inbox_entry_e9770d"));
  const video = raw.url !== undefined ? parseYouTubeVideo(raw.url) :
    typeof raw.videoId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw.videoId)
      ? parseYouTubeVideo(`https://www.youtube.com/watch?v=${raw.videoId}`) : null;
  if(!video || (raw.videoId!==undefined && raw.videoId!==video.videoId))throw Error(globalThis.atelierI18n.t("ui_invalid_youtube_link_or_mismatched_video_id_fbfe60"));
  if(raw.url===undefined && raw.canonicalSource!==undefined &&
      (typeof raw.canonicalSource!=='boolean'||raw.canonicalSource===false&&!raw.openUrl)){
    throw Error(globalThis.atelierI18n.t("ui_invalid_source_link_d3bad6"));
  }
  const sourceUrls=[...new Set([
    raw.openUrl || raw.url || video.canonicalUrl,
    ...(Array.isArray(raw.sourceUrls)?raw.sourceUrls:[]),
    ...(raw.url===undefined && raw.canonicalSource!==false?[video.canonicalUrl]:[])
  ])];
  for(const url of sourceUrls)if(typeof url!=='string' || url.length>4096 || parseYouTubeVideo(url)?.videoId!==video.videoId)throw Error(globalThis.atelierI18n.t("ui_invalid_source_link_d3bad6"));
  if(raw.status!==undefined&&!INBOX_STATES.includes(raw.status))throw Error(globalThis.atelierI18n.t("ui_invalid_inbox_status_aae1c6"));
  return {videoId:video.videoId,url:video.canonicalUrl,openUrl:sourceUrls[0],sourceUrls:sourceUrls.slice(0,16),
    title:clean(raw.title)||`YouTube · ${video.videoId}`,channel:clean(raw.channel,250)||'Unbekannt',
    ...(typeof raw.topicOverride==='string'&&raw.topicOverride.trim()?{topicOverride:clean(raw.topicOverride,120)}:{}),
    ...(typeof raw.channelKey==='string'&&/^(UC[A-Za-z0-9_-]{22}|@[\p{L}\p{N}_.-]{1,100})$/u.test(raw.channelKey)?{channelKey:raw.channelKey}:{}),
    ...(typeof raw.channelHandle==='string'&&/^@[\p{L}\p{N}_.-]{1,100}$/u.test(raw.channelHandle)?{channelHandle:raw.channelHandle}:{}),
    ...(raw.metadataPrivate===true?{metadataPrivate:true}:{}),
    metadataComplete:!!meaningfulYouTubeTitle(raw.title,video.videoId)&&!!meaningfulChannel(raw.channel),status:raw.status||'open',
    addedAt:date(raw.addedAt,now),updatedAt:date(raw.updatedAt,now)};
}
export function compactInboxItem(item) {
  const {url,openUrl,sourceUrls,...data}=item;
  const variants=sourceUrls.filter(source=>source!==url);
  if(openUrl!==url)data.openUrl=openUrl;
  // The preferred link is already represented by openUrl.
  const additional=variants.filter(source=>source!==openUrl);
  if(additional.length)data.sourceUrls=additional;
  if(!sourceUrls.includes(url))data.canonicalSource=false;
  return data;
}
export function parseInboxBackup(value) {
  if(value?.format!=='tab-atelier-inbox' || ![1,2].includes(value.version) || !Array.isArray(value.items) || value.items.length>10000)throw Error(globalThis.atelierI18n.t("ui_please_select_a_valid_tab_atelier_inbox_backup_versi_5d8fa1"));
  return value.items.map(item=>normalizeInboxItem(item));
}
export function createInboxStore(storage) {
  const queue=createActionQueue();let revision=0,cache=null;
  function invalidate(){revision++;cache=null}
  const key=id=>INBOX_PREFIX+id;
  async function get(id){
    const item=(await storage.get(key(id)))[key(id)];
    return item?normalizeInboxItem(item):null;
  }
  async function list(){
    if(cache)return cache;
    const version=revision;
    const values=storage.getKeys?await storage.get((await storage.getKeys()).filter(k=>k.startsWith(INBOX_PREFIX))):await storage.get(null);
    const items=Object.entries(values).filter(([k])=>k.startsWith(INBOX_PREFIX)).map(([,v])=>normalizeInboxItem(v));
    if(version===revision)cache=items;
    return items;
  }
  async function writeVerified(updates) {
    if(!Object.keys(updates).length)return;
    const packed=Object.fromEntries(Object.entries(updates).map(([k,item])=>[k,compactInboxItem(item)]));
    try{await storage.set(packed)}catch(error){
      if(/quota|storage.*(?:full|limit)/i.test(error.message))throw Error(globalThis.atelierI18n.t("ui_local_storage_is_full_back_up_your_inbox_as_json_and_1dad54"));
      throw error;
    }
    invalidate();
    const persisted=await storage.get(Object.keys(updates));
    const canonical=value=>value&&JSON.stringify(Object.keys(value).sort().map(key=>[key,value[key]]));
    for(const [k,value] of Object.entries(packed))if(canonical(persisted[k])!==canonical(value))throw Error(globalThis.atelierI18n.t("ui_could_not_verify_inbox_storage_no_more_tabs_will_be_4c2125"));
  }
  async function compactStored(){
    const marker='videoInboxCompactV2';
    if((await storage.get(marker))[marker])return;
    const keys=(storage.getKeys?await storage.getKeys():Object.keys(await storage.get(null))).filter(k=>k.startsWith(INBOX_PREFIX));
    for(let offset=0;offset<keys.length;offset+=100){
      await queue(async()=>{
        const previous=await storage.get(keys.slice(offset,offset+100)),updates={};
        for(const [k,item] of Object.entries(previous))if(item?.url!==undefined)updates[k]=normalizeInboxItem(item);
        await writeVerified(updates);
      });
    }
    await storage.set({[marker]:true});
  }
  return {get revision(){return revision},invalidate,list,get,compactStored,
    removeOpened(videoId) {
      return queue(async()=>{
        await storage.remove(key(videoId));
        invalidate();
      });
    },
    merge(rawItems,{metadata=false,fillMissing=false,restore=false,repairTitle=false,existingOnly=false}={}) {
      return queue(async()=>{
        const incoming=rawItems.map(item=>normalizeInboxItem(item));
        const previous=await storage.get(incoming.map(item=>key(item.videoId))),updates={};
        for(const item of incoming) {
          const k=key(item.videoId),old=updates[k]||(previous[k]?normalizeInboxItem(previous[k]):null);
          if(!old&&existingOnly)continue;
          if(!old)updates[k]=item;
          else {
            const improve=!fillMissing&&item.metadataComplete&&(metadata||!old.metadataComplete);
            updates[k]={...old,
              title:improve?item.title:old.title,
              channel:improve?item.channel:old.channel,
              metadataComplete:old.metadataComplete||item.metadataComplete,
              sourceUrls:[...new Set([...old.sourceUrls,...item.sourceUrls])].slice(0,16),updatedAt:Date.now()};
            const updated=updates[k];
            if(metadata||fillMissing){
              if(!meaningfulChannel(old.channel)&&meaningfulChannel(item.channel))updated.channel=item.channel;
              if(!meaningfulYouTubeTitle(old.title,item.videoId)&&meaningfulYouTubeTitle(item.title,item.videoId))updated.title=item.title;
              if(item.channelKey&&updated.channel===item.channel)updated.channelKey=item.channelKey;
              if(item.channelHandle&&updated.channel===item.channel)updated.channelHandle=item.channelHandle;
              if(repairTitle&&hasCardDuration(old.title)&&!hasCardDuration(item.title)&&meaningfulYouTubeTitle(item.title,item.videoId))updated.title=item.title;
            }
            if(restore&&item.topicOverride&&!old.topicOverride)updated.topicOverride=item.topicOverride;
            if(item.metadataPrivate)updated.metadataPrivate=true;
            updated.metadataComplete=!!meaningfulYouTubeTitle(updated.title,item.videoId)&&!!meaningfulChannel(updated.channel);
          }
        }
        await writeVerified(updates);return Object.values(updates);
      });
    },
    setTopic(videoId,topic) {
      return queue(async()=>{
        const item=await get(videoId);
        if(!item)throw Error(globalThis.atelierI18n.t('ui_video_not_in_the_inbox_e458e2'));
        if(topic)item.topicOverride=topic;
        else delete item.topicOverride;
        await writeVerified({[key(videoId)]:item});
        return item;
      });
    },
    setStatus(videoId,status) {
      return queue(async()=>{
        if(!INBOX_STATES.includes(status))throw Error(globalThis.atelierI18n.t("ui_invalid_status_a78b4e"));
        const item=await get(videoId);if(!item)throw Error(globalThis.atelierI18n.t("ui_video_no_longer_in_the_inbox_f20f42"));
        const updated={...item,status,updatedAt:Date.now()};await writeVerified({[key(videoId)]:updated});return updated;
      });
    },
    setStatuses(videoIds,status) {
      return queue(async()=>{
        const ids=inboxSelection(videoIds);
        if(!INBOX_STATES.includes(status))throw Error(globalThis.atelierI18n.t("ui_invalid_status_a78b4e"));
        const previous=await storage.get(ids.map(key)),updates={},now=Date.now();
        // Validate the entire frozen selection before writing any of it.
        for(const id of ids) {
          const item=previous[key(id)];
          if(!item||item.videoId!==id)throw Error(globalThis.atelierI18n.t("ui_a_selected_video_is_no_longer_in_the_inbox_please_re_710771"));
          if(item.status!==status)updates[key(id)]={...normalizeInboxItem(item),status,updatedAt:now};
        }
        await writeVerified(updates);return {count:ids.length,updated:Object.keys(updates).length};
      });
    }
  };
}
