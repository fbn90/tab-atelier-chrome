import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryStorage,event} from './storage-helper.js';
import {createInboxStore,compactInboxItem,parseInboxBackup} from '../inbox-store.js';
import {installTabAutomation} from '../tab-automation.js';
import {AUTOMATION_SETTINGS} from '../tab-settings.js';
import {archiveOverflowTab} from '../youtube-overflow.js';
import {createInboxIndex} from '../inbox-model.js';
import {channelIdentity,channelIdentityKeys} from '../youtube-metadata.js';
import {installAutomaticMetadata} from '../automatic-metadata.js';

const video=(id,extra={})=>({id,index:id,windowId:1,groupId:-1,status:'complete',url:`https://www.youtube.com/watch?v=video${id}&t=15`,title:`Video ${id}`,...extra});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,timeout=4000){
  const end=performance.now()+timeout;
  while(performance.now()<end){if(await condition())return;await delay(10)}
  assert.fail('Expected automation did not finish');
}
function fixture(tabs,settings={}) {
  const local=memoryStorage({[AUTOMATION_SETTINGS]:settings}),session=memoryStorage();
  const inbox=createInboxStore(local);
  const live=new Map(tabs.map(tab=>[tab.id,{...tab}])),closed=[],alarms=new Map();
  const api={storage:{local,session,onChanged:event()},tabs:{
    onCreated:event(),onRemoved:event(),onUpdated:event(),onActivated:event(),onReplaced:event(),
    async query(){return [...live.values()].map(tab=>({...tab}))},
    async get(id){if(!live.has(id))throw Error('Tab missing');return {...live.get(id)}},
    async remove(id){assert.ok(live.has(id));live.delete(id);closed.push(id);this.onRemoved.fire(id)},
    async update(id,patch){Object.assign(live.get(id),patch);return this.get(id)}
  },runtime:{getURL:name=>`chrome-extension://fixture/${name}`,sendMessage:async()=>{},onMessage:event(),onStartup:event()},
  alarms:{onAlarm:event(),async create(name,options){alarms.set(name,{name,scheduledTime:Date.now()+(options.delayInMinutes||0.5)*60000})},
    async get(name){return alarms.get(name)},async clear(name){return alarms.delete(name)}},
  windows:{async update(){}}};
  return {api,inbox,closed,live,alarms};
}

test('the 21st video preserves the new tab and archives the oldest eligible source',async()=>{
  const f=fixture(Array.from({length:20},(_,i)=>video(i+1,{pinned:i===0,active:i===1,audible:i===2})),
    {youtubeLimitEnabled:true,youtubeLimit:20,totalLimitEnabled:true,totalLimit:20});
  await f.inbox.merge([{videoId:'video4',status:'keep',addedAt:123}]);
  const automation=installTabAutomation(f.api,{inbox:f.inbox});
  try{
    await until(async()=>!!(await f.api.storage.session.get('tabAutomationSessionV1')).tabAutomationSessionV1?.ages?.length);
    const next=video(21,{index:0});f.live.set(next.id,next);f.api.tabs.onCreated.fire(next);
    await until(()=>f.closed.length===1);
    assert.deepEqual(f.closed,[4]);assert.ok(f.live.has(21));
    const saved=await f.inbox.get('video4');
    assert.equal(saved.status,'keep');assert.equal(saved.addedAt,123);assert.ok(saved.sourceUrls.includes(video(4).url));
  }finally{automation.dispose()}
});

test('startup with 2,000 tabs archives the video excess and leaves non-video tabs alone',async()=>{
  const videoTabs=Array.from({length:42},(_,i)=>video(i+1));
  const rest=Array.from({length:1958},(_,i)=>video(i+43,{url:'https://example.test/'+i}));
  const f=fixture([...videoTabs,...rest],{youtubeLimitEnabled:true,youtubeLimit:20,totalLimitEnabled:true,totalLimit:60});
  const automation=installTabAutomation(f.api,{inbox:f.inbox});
  try{
    await until(()=>f.closed.length>=22,8000);
    assert.deepEqual(f.closed,Array.from({length:22},(_,i)=>i+1));
    assert.equal((await f.inbox.list()).length,22);
    assert.equal(f.live.size,1978);
  }finally{automation.dispose()}
});

test('storage failure, changed tabs and a resolved overflow do not close a source',async()=>{
  const original=video(1),f=fixture([original]);
  await assert.rejects(archiveOverflowTab(f.api,{async merge(){throw Error('storage quota')}},original),/quota/);
  const editing={merge:async(...args)=>{await f.inbox.merge(...args);f.live.get(1).url='https://example.test/'},get:id=>f.inbox.get(id)};
  assert.equal(await archiveOverflowTab(f.api,editing,original),false);
  f.live.set(1,original);
  assert.equal(await archiveOverflowTab(f.api,f.inbox,original,async()=>false),false);
  assert.deepEqual(f.closed,[]);
});

test('a collection of 5,000 returns bounded review groups and pages without rebuilding on status change',async()=>{
  const storage=memoryStorage(),store=createInboxStore(storage);
  for(let i=0;i<5000;i+=100)await store.merge(Array.from({length:100},(_,j)=>{
    const n=i+j;return {videoId:'video'+n,title:'Test title '+n,channel:n%2?'Metatron':"Metatron’s Academy",addedAt:n+1};
  }));
  let builds=0;
  const index=createInboxIndex(store,items=>{builds++;return items},()=>0);
  const view=await index.page({mode:'channel',pages:[['Metatron',2400]],search:'Test',status:'open'});
  assert.equal(view.matched,5000);assert.equal(view.groupCount,2);assert.equal(view.review.length,10);
  assert.equal(view.groups.find(group=>group.key==='Metatron').rows.length,100);
  assert.equal(view.groups.find(group=>group.key==='Metatron’s Academy').rows.length,0);
  const id=view.review[0],stamp=index.version();
  await store.setStatus(id,'done');index.updateStatuses(stamp,[id],'done');
  assert.equal((await index.page({mode:'none',status:'open'})).matched,4999);assert.equal(builds,1);
  await store.setTopic(id,'Eigene Zuordnung');
  const backup=parseInboxBackup({format:'tab-atelier-inbox',version:2,items:[compactInboxItem(await store.get(id))]});
  assert.equal(backup[0].topicOverride,'Eigene Zuordnung');
});

test('verified channel IDs and handles join only with corresponding identity evidence',()=>{
  const id='UC'+'a'.repeat(22),other='UC'+'b'.repeat(22);
  assert.equal(channelIdentity('https://www.youtube.com/channel/'+id),id);
  assert.equal(channelIdentity('https://example.test/@metatron'),'');
  const key=channelIdentityKeys([{channelKey:id,channelHandle:'@metatron'}]);
  assert.equal(key({channelKey:'@metatron'}),id);
  assert.equal(key({channelKey:'@metatronsacademy'}),'@metatronsacademy');
  assert.equal(key({channelKey:other,channelHandle:'@metatron'}),other);
});

test('automatic metadata respects opt-in, shares progress and preserves parked tabs and saved status',async()=>{
  const f=fixture([]);
  await f.inbox.merge([{videoId:'sample',title:'Scott Bessent at The Forum 37 Minuten',channel:'',status:'keep',addedAt:321},
    {videoId:'private',title:'Private clip',metadataPrivate:true}]);
  const requests=[];
  const service=installAutomaticMetadata({api:f.api,store:f.inbox,
    getLocalMetadata:async()=>new Map(),readLoadedMetadata:async()=>({}),
    fetchMetadata:async url=>{requests.push(url);return {title:'Scott Bessent at The Forum',channel:'The Daily Signal'}},
    onMetadataChanged(){}});
  await delay(10);
  f.api.alarms.onAlarm.fire({name:'atelier-inbox-metadata'});
  await delay(10);
  assert.deepEqual(requests,[]);
  await f.api.storage.local.set({[AUTOMATION_SETTINGS]:{autoMetadata:true}});
  f.api.storage.onChanged.fire({[AUTOMATION_SETTINGS]:{oldValue:{},newValue:{autoMetadata:true}}},'local');
  await until(()=>f.alarms.has('atelier-inbox-metadata'));
  f.api.alarms.onAlarm.fire({name:'atelier-inbox-metadata'});
  await until(async()=> (await service.status()).filled===1);
  const saved=await f.inbox.get('sample');
  assert.equal(saved.title,'Scott Bessent at The Forum');assert.equal(saved.channel,'The Daily Signal');
  assert.equal(saved.status,'keep');assert.equal(saved.addedAt,321);
  assert.deepEqual(requests,['https://www.youtube.com/watch?v=sample']);assert.deepEqual(f.closed,[]);
});

test('simultaneous opens only archive as many old tabs as needed',async()=>{
  const f=fixture([video(1),video(2),video(3)],{youtubeLimitEnabled:true,youtubeLimit:3});
  const automation=installTabAutomation(f.api,{inbox:f.inbox});
  try {
    await until(async()=>!!(await f.api.storage.session.get('tabAutomationSessionV1')).tabAutomationSessionV1?.ages?.length);
    for(const id of [4,5]){
      const tab=video(id,{index:0});
      f.live.set(id,tab);f.api.tabs.onCreated.fire(tab);
    }
    await until(()=>f.closed.length===2);
    assert.deepEqual(f.closed,[1,2]);
    assert.deepEqual([...f.live.keys()],[3,4,5]);
  }finally{automation.dispose()}
});

test('metadata rate limits are retained across worker restarts',async()=>{
  const f=fixture([],{autoMetadata:true});
  await f.inbox.merge([{videoId:'rate1'},{videoId:'rate2'},{videoId:'rate3'}]);
  let calls=0;
  const config={api:f.api,store:f.inbox,getLocalMetadata:async()=>new Map(),readLoadedMetadata:async()=>({}),
    fetchMetadata:async()=>{calls++;throw Object.assign(Error('Rate limit'),{status:429,retryAfter:300000})},onMetadataChanged(){}};
  const service=installAutomaticMetadata(config);
  await until(()=>f.alarms.has('atelier-inbox-metadata'));
  f.api.alarms.onAlarm.fire({name:'atelier-inbox-metadata'});
  await until(async()=> (await service.status()).waiting);
  assert.equal(calls,2);
  const restarted=installAutomaticMetadata(config);
  await until(async()=> (await restarted.status()).waiting);
  f.api.alarms.onAlarm.fire({name:'atelier-inbox-metadata'});
  await delay(20);
  assert.equal(calls,2);
  assert.ok((await f.api.alarms.get('atelier-inbox-metadata')).scheduledTime>Date.now()+60000);
});
