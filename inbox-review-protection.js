import {parseYouTubeTab,tabParkerTarget,parseYouTubeVideo} from './youtube-url.js';

const PREFIX='inboxReviewV1:';
const BINDING='inboxReviewBindingV1:';
export const reviewId=tab=>{
  if(!tab||tab.incognito)return null;
  const url=tab.pendingUrl||tab.url;
  return parseYouTubeTab(url)?.videoId||parseYouTubeVideo(tabParkerTarget(url,true))?.videoId||null;
};
export const reviewPage=(api,id)=>api.runtime.getURL('inbox-review.html')+'#'+id;
export function reviewToken(api,url){
  if(typeof url!=='string')return null;
  const prefix=api.runtime.getURL('inbox-review.html')+'#';
  const token=url.startsWith(prefix)?url.slice(prefix.length):'';
  return /^[a-f0-9-]{36}$/.test(token)?token:null;
}
export async function readReview(api,id){
  return (await api.storage.local.get(PREFIX+id))[PREFIX+id];
}
export const saveReview=(api,id,record)=>api.storage.local.set({[PREFIX+id]:record});
export async function removeReview(api,id){
  await api.storage.local.remove(PREFIX+id);
  await api.storage.session?.remove(BINDING+id);
}
const bindingFor=marker=>({tabId:marker.id,groupId:marker.groupId,windowId:marker.windowId});
export const bindReview=(api,id,marker)=>api.storage.session?.set({[BINDING+id]:bindingFor(marker)});

export async function reviewProtection(api,tabs){
  const admitted=new Set(), protectedTabs=new Set(), markerTabs=new Set();
  const anchors=new Map();
  for(const tab of tabs){
    const id=!tab.incognito&&reviewToken(api,tab.pendingUrl||tab.url);
    if(!id)continue;
    if(!anchors.has(id))anchors.set(id,[]);
    anchors.get(id).push(tab);
  }
  if(!anchors.size)return {admitted,protectedTabs,markerTabs};
  const ids=[...anchors.keys()];
  const [records,bindings]=await Promise.all([
    api.storage.local.get(ids.map(id=>PREFIX+id)),
    api.storage.session?.get(ids.map(id=>BINDING+id))||{}
  ]);
  for(const [id,markers] of anchors){
    const record=records[PREFIX+id];
    if(!record?.active||markers.length!==1)continue;
    const marker=markers[0],members=new Set(record.members||[]),binding=bindings[BINDING+id];
    if(binding&&(binding.tabId!==marker.id||binding.windowId!==marker.windowId||binding.groupId!==marker.groupId))continue;
    let confirmed=false;
    markerTabs.add(marker.id);
    admitted.add(marker.id);
    for(const tab of tabs){
      if(tab.incognito||tab.windowId!==marker.windowId||tab.id===marker.id)continue;
      const video=reviewId(tab);
      const grouped=marker.groupId>=0&&tab.groupId===marker.groupId&&members.has(video);
      const pending=record.pending;
      const arriving=pending?.markerId===marker.id&&((pending.tabId===tab.id&&(!video||pending.videoId===video))||
        pending.videoId===video&&pending.create===true&&!pending.before.includes(tab.id));
      if(grouped)confirmed=true;
      if(grouped||arriving){
        admitted.add(tab.id);
        if(record.bypass||arriving)protectedTabs.add(tab.id);
      }
    }
    if(!binding&&confirmed)await bindReview(api,id,marker);
  }
  return {admitted,protectedTabs,markerTabs};
}
