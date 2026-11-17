import './i18n.js';
import {readTabSettings,AUTOMATION_SETTINGS} from './tab-settings.js';
import {discoverTabParkers,meaningfulChannel,meaningfulYouTubeTitle,parseYouTubeTab,parkedVideoTitle} from './youtube-url.js';
import {hasCardDuration} from './youtube-metadata.js';

const KEY='inboxMetadataProgressV1', ALARM='atelier-inbox-metadata';
const HOUR=60*60*1000;

export function installAutomaticMetadata({api,store,getLocalMetadata,fetchMetadata,onMetadataChanged,readLoadedMetadata}) {
  let running=null, enabled=false, optionsRevision=0;
  const read=async()=> (await api.storage.local.get(KEY))[KEY]||{};
  const notify=()=> api.runtime.sendMessage({type:'inbox-metadata-progress'}).catch(()=>{});
  function schedule(delayInMinutes=0.5) {
    return api.alarms?.create(ALARM,{delayInMinutes});
  }
  async function wake() {
    if(!enabled||running||!api.alarms?.get)return;
    const alarm=await api.alarms.get(ALARM);
    if(!alarm||alarm.scheduledTime>Date.now()+60000){
      const {backoffUntil}=await read();
      if(enabled&&!(backoffUntil>Date.now()))await schedule();
    }
  }
  async function settings() {
    const revision=++optionsRevision;
    const active=(await readTabSettings(api)).autoMetadata;
    if(revision!==optionsRevision)return;
    enabled=active;
    if(enabled){
      const current=await api.alarms?.get?.(ALARM);
      if(!current)await schedule();
    }
    else {await api.alarms?.clear(ALARM);notify()}
  }
  async function run() {
    if(running)return running;
    running=(async()=>{
      enabled=(await readTabSettings(api)).autoMetadata;
      if(!enabled)return;
      const state=await read(), retry=state.retry||{};
      if(state.backoffUntil>Date.now()){await schedule((state.backoffUntil-Date.now())/60000);return}
      const [stored,tabs]=await Promise.all([store.list(),api.tabs.query({windowType:'normal'})]);
      await discoverTabParkers(api,tabs.filter(tab=>!tab.incognito));
      const candidates=new Map(), loaded=new Map(), privateIds=new Set(stored.filter(item=>item.metadataPrivate).map(item=>item.videoId));
      for(const item of stored){
        if(!item.metadataPrivate&&(!item.metadataComplete||hasCardDuration(item.title)))candidates.set(item.videoId,item);
      }
      for(const tab of tabs){
        if(tab.incognito||tab.pendingUrl)continue;
        const video=parseYouTubeTab(tab.url);
        if(!video||privateIds.has(video.videoId))continue;
        if(!video.parked){
          if(!tab.discarded&&tab.status==='complete')loaded.set(video.videoId,tab);
          continue;
        }
        const current=candidates.get(video.videoId);
        if(!current)candidates.set(video.videoId,{...video,url:video.canonicalUrl,
          title:parkedVideoTitle(video,tab.title),channel:video.channel});
        else candidates.set(video.videoId,{...current,parkedTitle:parkedVideoTitle(video,tab.title),parkedChannel:video.channel});
      }
      const pending=[...candidates.values()].filter(item=>!meaningfulYouTubeTitle(item.title,item.videoId)||retry[item.videoId]?.verifiedTitle!==item.title||!meaningfulChannel(item.channel));
      const total=pending.length;
      let filled=state.filled||0;
      let pauseUntil=0, changed=false;
      const chunk=pending.filter(item=>(retry[item.videoId]?.at||0)<=Date.now()).slice(0,12);
      const local=await getLocalMetadata(chunk.map(item=>item.videoId));
      const updates=[];
      for(let i=0;i<chunk.length&&enabled&&!pauseUntil;i+=2){
        const results=await Promise.all(chunk.slice(i,i+2).map(async item=>{
          const id=item.videoId, cached=local.get(id), source=loaded.get(id);
          let title=meaningfulYouTubeTitle(item.parkedTitle||item.title,id);
          let channel=meaningfulChannel(item.parkedChannel||item.channel);
          let channelKey=item.channelKey, channelHandle=item.channelHandle, verifiedTitle='';
          const use=info=>{
            const next=meaningfulYouTubeTitle(info?.title,id);
            if(next&&(!title||hasCardDuration(title)&&!hasCardDuration(next)))title=next;
            channel ||= meaningfulChannel(info?.channel);
            if(meaningfulChannel(info?.channel)&&(!channelKey||channel===info.channel)){
              channelKey=info.channelKey||channelKey;
              channelHandle=info.channelHandle||channelHandle;
            }
          };
          use(cached);
          if(source&&(!title||!channel||hasCardDuration(title)))use(await readLoadedMetadata(source,id).catch(()=>({})));
          if((!title||!channel||hasCardDuration(title))&&enabled){
            const latest=await store.get(id);
            if(latest?.metadataPrivate||!enabled)return null;
            try{
              const info=await fetchMetadata(item.url);
              verifiedTitle=meaningfulYouTubeTitle(info?.title,id);
              use(info);
            }catch(error){
              if(error.status===429||error.status===503){
                pauseUntil=Math.max(pauseUntil,Date.now()+Math.max(5*60000,error.retryAfter||0));
              }
            }
          }
          const complete=!!title&&!!channel&&(!hasCardDuration(title)||verifiedTitle===title);
          const attempts=(retry[id]?.attempts||0)+1;
          retry[id]={at:Date.now()+(complete?24*HOUR:Math.min(7*24*HOUR,HOUR*2**Math.min(8,attempts-1))),attempts,...(verifiedTitle&&verifiedTitle===title?{verifiedTitle}:{})};
          if(complete)filled++;
          return {videoId:id,title,channel,channelKey,channelHandle,complete};
        }));
        updates.push(...results.filter(Boolean));
      }
      for(const info of updates){
        const old=await store.get(info.videoId);
        if(!old||old.metadataPrivate)continue;
        if(info.title&&info.title!==old.title||info.channel&&info.channel!==old.channel||info.channelKey&&info.channelKey!==old.channelKey||info.channelHandle&&info.channelHandle!==old.channelHandle){
          await store.merge([{...old,...info}],{fillMissing:true,repairTitle:true});changed=true;
        }
      }
      // Keep recent attempts for still relevant records to resume without repeating successful lookups.
      for(const id of Object.keys(retry))if(!candidates.has(id)||retry[id].at<Date.now()-24*HOUR)delete retry[id];
      const waiting=Object.values(retry).filter(value=>value.at>Date.now());
      const due=chunk.length===12 ? Date.now()+30000 : Math.min(Date.now()+12*HOUR,...waiting.map(value=>value.at));
      await api.storage.local.set({[KEY]:{retry,filled,total:Math.max(0,total-updates.filter(item=>item.complete).length),backoffUntil:pauseUntil}});
      if(changed)onMetadataChanged();
      notify();
      if(enabled)await schedule(Math.max(0.5,((pauseUntil||due)-Date.now())/60000));
    })().catch(async error=>{
      console.warn('Video Inbox metadata:',error);
      if(enabled)await schedule(5);
    }).finally(()=>{running=null});
    return running;
  }
  api.alarms?.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void run()});
  api.runtime.onStartup?.addListener(()=>void settings().catch(console.warn));
  api.storage.onChanged.addListener((changes,area)=>{
    if(area==='local'&&changes[AUTOMATION_SETTINGS]&&
      changes[AUTOMATION_SETTINGS].oldValue?.autoMetadata!==changes[AUTOMATION_SETTINGS].newValue?.autoMetadata)void settings().catch(console.warn);
    else if(area==='local'&&Object.entries(changes).some(([key,value])=>key.startsWith('videoInboxV1:')&&!value.oldValue))void wake().catch(console.warn);
  });
  api.tabs.onUpdated?.addListener((_id,change,tab)=>{
    if(!tab.incognito&&change.url&&parseYouTubeTab(change.url)?.parked)void wake().catch(console.warn);
  });
  void settings().catch(console.warn);
  return {status:async()=>{
    const state=await read();
    return {enabled:(await readTabSettings(api)).autoMetadata,filled:state.filled||0,total:state.total||0,
      waiting:!!state.backoffUntil&&state.backoffUntil>Date.now()};
  }};
}
