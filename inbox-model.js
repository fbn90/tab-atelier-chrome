import './i18n.js';
import {meaningfulChannel,meaningfulYouTubeTitle} from './youtube-url.js';
export const REVIEW_BATCH_SIZE=10;
export const INBOX_PAGE_SIZE=100;
const orders=['newest','oldest','title'];
const orderInbox=(items,sort)=>items.sort((a,b)=>sort==='title'?a.title.localeCompare(b.title,'de'):
  (sort==='oldest'?a.addedAt-b.addedAt:b.addedAt-a.addedAt)||a.title.localeCompare(b.title,'de'));
const indexText=item=>`${item.title} ${item.channel} ${item.topic} ${item.url} ${item.openUrl}`.toLocaleLowerCase('de');
function matchesInbox(items,{search='',status='open',missing='all'}={}) {
  const query=(typeof search==='string'?search:'').trim().toLocaleLowerCase('de');
  return items.filter(item=>matchesMissing(item,missing)&&(status==='all'||item.status===status)&&
    (!query||(item.searchText??indexText(item)).includes(query)));
}
export function filterInbox(items,options={}) {
  return orderInbox(matchesInbox(items,options),options.sort);
}
export function groupInbox(items,mode) {
  if(mode==='none')return [{key:'all',label:'Alle Videos',items}];
  const groups=new Map();
  for(const item of items) {
    const label=(mode==='topic'?item.topic:item.channel)||'Unbekannt';
    const key=mode==='channel'?(item.channelGroupKey||label):label;
    if(!groups.has(key))groups.set(key,{key,label,items:[]});
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a,b)=>b.items.length-a.items.length||a.label.localeCompare(b.label,'de'));
}
export function inboxMetadata(item) {
  const channel=item.channel||'Unbekannt',topic=item.topic;
  return globalThis.atelierI18n.t("ui_channel_added_48793e", [globalThis.atelierI18n.label(channel), topic&&topic!==channel?globalThis.atelierI18n.t("ui_topic_a191e1", [globalThis.atelierI18n.label(topic)]):'', new Date(item.addedAt).toLocaleDateString(globalThis.atelierI18n.locale)]);
}

export function matchesMissing(item, kind) {
  if(kind==='title')return !meaningfulYouTubeTitle(item.title,item.videoId);
  if(kind==='channel')return !meaningfulChannel(item.channel);
  if(kind==='topic')return !item.topic||item.topic==='Unbekannt'||item.topic==='Sonstiges';
  return true;
}

export function createInboxIndex(store, decorate, classificationVersion) {
  let indexed=null, pending;
  const version=()=>[store.revision,classificationVersion()].join(':');
  async function index() {
    const stamp=version();
    if(indexed?.stamp===stamp)return indexed;
    if(pending?.stamp===stamp)return pending.promise;
    const promise=(async()=>{
      const items=(await decorate(await store.list())).map(item=>({...item,searchText:indexText(item)}));
      const sorted=Object.fromEntries(orders.map(order=>[order,orderInbox([...items],order)]));
      const result={stamp,items,sorted,byId:new Map(items.map(item=>[item.videoId,item]))};
      if(version()===stamp)indexed=result;
      return result;
    })();
    pending={stamp,promise};
    try{return await promise}finally{if(pending?.promise===promise)pending=null}
  }
  function updateStatuses(previousStamp, ids, status) {
    if(indexed?.stamp!==previousStamp||String(classificationVersion())!==previousStamp.split(':')[1])return;
    for(const id of ids){
      const item=indexed.byId.get(id);
      if(item)item.status=status;
    }
    indexed.stamp=version();
  }
  return {
    version,updateStatuses,
    async select(options) {
      const source=await index();
      const filtered=matchesInbox(source.sorted[orders.includes(options.sort)?options.sort:'newest'],options);
      const mode=['none','channel','topic'].includes(options.mode)?options.mode:'channel';
      return {source,filtered,groups:groupInbox(filtered,mode)};
    },
    async page(options) {
      const {source,filtered,groups}=await this.select(options);
      const visibleGroups=40;
      const groupOffset=Math.min(Math.max(0,Math.trunc(Number(options.groupOffset)||0)),
        Math.max(0,Math.ceil(groups.length/visibleGroups)-1)*visibleGroups);
      const pages=new Map(Array.isArray(options.pages)?options.pages.slice(0,4):[]);
      return {total:source.items.length,open:source.items.filter(item=>item.status==='open').length,
        matched:filtered.length,groupCount:groups.length,groupOffset,review:filtered.slice(0,REVIEW_BATCH_SIZE).map(item=>item.videoId),
        groups:groups.slice(groupOffset,groupOffset+visibleGroups).map(({key,label,items})=>{
          const request=pages.get(key);
          const offset=Math.min(Math.max(0,Math.trunc(Number(request)||0)),Math.max(0,Math.ceil(items.length/INBOX_PAGE_SIZE)-1)*INBOX_PAGE_SIZE);
          return {key,label,count:items.length,offset,review:items.slice(0,REVIEW_BATCH_SIZE).map(item=>item.videoId),
            rows:request===undefined?[]:items.slice(offset,offset+INBOX_PAGE_SIZE).map(({searchText,...row})=>row)};
        })};
    }
  };
}
