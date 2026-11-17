import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createInboxStore,normalizeInboxItem,parseInboxBackup,INBOX_PREFIX} from '../inbox-store.js';
import {installInbox} from '../inbox-service.js';
import {createTaskService} from '../task-runner.js';
import {filterInbox,groupInbox} from '../inbox-model.js';
import {memoryStorage,event} from './storage-helper.js';
import {TAB_PARKER_STORE_ID} from '../youtube-url.js';
const video=(id,extra={})=>({id,url:`https://www.youtube.com/watch?v=video${id}`,title:`Video ${id} · Asmongold`,windowId:1,status:'complete',discarded:true,incognito:false,pinned:false,...extra});
const entry=(id,extra={})=>({url:`https://youtube.com/watch?v=video${id}`,title:`Video ${id}`,channel:'Asmongold',metadataComplete:true,...extra});
function fixture(tabs=[video(1)],{local=memoryStorage(),session=memoryStorage(),metadata,enrichMetadata}={}) {
  const live=new Map(tabs.map(t=>[t.id,{...t}])),removed=[],created=[],focus=[];let fetches=0;
  const api={
    storage:{local,session,onChanged:event()},
    runtime:{id:'test',getURL:p=>`chrome-extension://test/${p}`,onMessage:event(),sendMessage:async()=>{}},
    alarms:{onAlarm:event(),create:async()=>{},clear:async()=>{}},
    tabs:{query:async()=>[...live.values()].map(t=>({...t})),get:async id=>{if(!live.has(id))throw Error('Missing');return {...live.get(id)}},
      remove:async id=>{removed.push(id);live.delete(id)},
      update:async(id,patch)=>{Object.assign(live.get(id),patch);return {...live.get(id)}},
      create:async options=>{const tab={...video(9999+created.length),url:options.url};created.push(tab);live.set(tab.id,tab);return tab}
    },
    windows:{update:async id=>focus.push(id)},tabGroups:{query:async()=>[]}
  };
  const tasks=createTaskService(api,{schedule:()=>{}});
  const store=installInbox({api,tasks,enrichMetadata,getMetadata:async record=>{fetches++;return metadata?metadata(record):{title:`Alex Karp ${record.videoId}`,channel:'Asmongold'}},
    selectGroup:async()=>[1,3],decorate:async items=>items.map(item=>({...item,topic:'Alex Karp'}))});
  function request(type,payload={},sender={id:'test',url:api.runtime.getURL('inbox.html'),tab:{id:900}}) {
    return new Promise(resolve=>{for(const fn of api.runtime.onMessage.listeners)fn({type,...payload},sender,resolve)});
  }
  return {api,tasks,store,request,live,removed,created,focus,get fetches(){return fetches}};
}
async function finish(f,id) {
  for(let i=0;i<1000;i++) {
    await f.tasks.pump();const task=(await f.tasks.list()).tasks.find(t=>t.id===id);
    if(['done','failed','interrupted','cancelled'].includes(task.status))return task;
  }
  throw Error('Task did not finish');
}

test('inbox normalizes alternate YouTube URLs and rejects unsafe/inconsistent backups',()=>{
  assert.equal(normalizeInboxItem({url:'https://youtu.be/video1?t=99'}).videoId,'video1');
  for(const item of [{url:'javascript:alert(1)'},{url:'https://evil.example/watch?v=video1'},entry(1,{videoId:'video2'}),entry(1,{openUrl:'https://youtu.be/video2'}),entry(1,{status:'anything'})])assert.throws(()=>normalizeInboxItem(item));
  assert.throws(()=>parseInboxBackup({format:'tab-atelier-inbox',version:3,items:[]}));
  assert.throws(()=>parseInboxBackup({format:'tab-atelier-inbox',version:1,items:[entry(1),{url:'javascript:alert(1)'}]}));
});

test('compact storage migrates legacy records and preserves which sources were actually saved',async()=>{
  const standard=normalizeInboxItem(entry(1,{url:'https://www.youtube.com/watch?v=video1'}));
  const alternate=normalizeInboxItem(entry(2,{url:'https://youtu.be/video2?t=30'}));
  const storage=memoryStorage({'videoInboxV1:video1':standard,'videoInboxV1:video2':alternate});
  const store=createInboxStore(storage);
  await store.compactStored();
  assert.equal(storage.data['videoInboxV1:video1'].url,undefined);
  assert.equal(storage.data['videoInboxV1:video1'].openUrl,undefined);
  assert.equal(storage.data['videoInboxV1:video1'].sourceUrls,undefined);
  assert.equal(storage.data['videoInboxV1:video2'].canonicalSource,false);
  assert.deepEqual(await store.get('video1'),standard);
  assert.deepEqual(await store.get('video2'),alternate);
  const parsed=parseInboxBackup({format:'tab-atelier-inbox',version:2,items:[
    storage.data['videoInboxV1:video1'],storage.data['videoInboxV1:video2']
  ]});
  assert.deepEqual(parsed,[standard,alternate]);
  await store.merge([{...alternate,openUrl:alternate.url,sourceUrls:[alternate.url]}]);
  assert.equal((await store.get('video2')).sourceUrls.includes(alternate.url),true);
  assert.equal((await store.get('video2')).openUrl,'https://youtu.be/video2?t=30');
  await store.setStatuses(['video1','video2'],'keep');
  assert.ok((await store.list()).every(item=>item.status==='keep'));
});

test('repeat capture deduplicates by video ID and preserves user status, title quality and original links',async()=>{
  const storage=memoryStorage(),store=createInboxStore(storage);
  await store.merge([entry(1,{url:'https://youtu.be/video1?t=30'})]);await store.setStatus('video1','keep');
  const before=await store.get('video1');
  await store.merge([entry(1,{title:'Poor tab title',channel:'Unbekannt',metadataComplete:false,url:'https://youtube.com/watch?v=video1&t=80'})]);
  const item=await store.get('video1');assert.equal(item.status,'keep');assert.equal(item.title,'Video 1');assert.equal(item.addedAt,before.addedAt);assert.equal(item.sourceUrls.length,2);
  assert.equal((await createInboxStore(storage).list()).length,1);
});

test('1000 tabs are persisted, enriched and verified before closing; collection survives a new worker/session',async()=>{
  const f=fixture(Array.from({length:1000},(_,i)=>video(i+1)));
  // Every removal inspects the actual persistent store, never a metadata cache.
  const remove=f.api.tabs.remove;
  f.api.tabs.remove=async id=>{
    const all=await f.store.list();assert.equal(all.length,1000);
    const saved=await f.store.get(`video${id}`);assert.ok(saved.sourceUrls.includes(f.live.get(id).url));assert.equal(saved.channel,'Asmongold');await remove(id);
  };
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.inboxSaved,1000);assert.equal(done.result.closedTabs,1000);
  assert.equal(f.fetches,1000);assert.equal(f.created.length,0);assert.equal(f.live.size,0);
  const restarted=fixture([],{local:f.api.storage.local});const result=await restarted.request('inbox-list');
  assert.equal(result.items.length,1000);assert.equal(result.items[0].channel,'Asmongold');assert.equal(result.items[0].status,'open');
});

test('capture closes associated tabs by default only after verified storage, including pinned copies',async()=>{
  const f=fixture([video(1),video(2,{url:'https://youtu.be/video1?t=90',pinned:true}),video(3,{windowId:2}),video(4,{incognito:true})]);
  const remove=f.api.tabs.remove;
  f.api.tabs.remove=async id=>{
    const saved=await f.store.get('video1');assert.equal(saved.metadataComplete,true);assert.ok(saved.sourceUrls.includes(f.live.get(id).url));await remove(id);
  };
  const {taskId}=await f.request('inbox-capture',{windowId:1});const task=await finish(f,taskId);
  assert.equal(task.status,'done');assert.equal(task.result.inboxSaved,1);assert.equal(task.result.closedTabs,2);assert.deepEqual(f.removed,[1,2]);assert.ok(f.live.has(3));assert.ok(f.live.has(4));
});

test('quota failure during initial persistence keeps every original tab open',async()=>{
  const f=fixture([video(1),video(2)]);f.api.storage.local.set=async()=>{throw Error('QUOTA_BYTES exceeded')};
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const result=await finish(f,taskId);
  assert.equal(result.status,'failed');assert.equal(f.removed.length,0);assert.equal(f.live.size,2);
});

test('a falsely acknowledged write cannot permit closing',async()=>{
  const f=fixture();f.api.storage.local.set=async()=>{};
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'failed');assert.match(done.error,/bestätigt/);assert.equal(f.removed.length,0);
});

test('timestamps/short links consolidate once, retain both original URLs and can close both originals',async()=>{
  const f=fixture([video(1,{url:'https://youtu.be/shared?t=30'}),video(2,{url:'https://www.youtube.com/watch?v=shared&t=90'})]);
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.inboxSaved,1);assert.equal(done.result.closedTabs,2);assert.equal(f.fetches,1);
  assert.equal((await f.store.get('shared')).sourceUrls.length,2);
});

test('navigation after saving and after the close intent prevents removing a different page',async()=>{
  const f=fixture([video(1),video(2)]),save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))f.live.get(1).url='https://other.example'};
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.deepEqual(f.removed,[2]);assert.equal(done.result.skipped,1);assert.ok(await f.store.get('video1'));
});

test('missing durable record immediately before closing aborts rather than trusting prior storage success',async()=>{
  const f=fixture(),save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))await f.api.storage.local.remove(INBOX_PREFIX+'video1')};
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'failed');assert.equal(f.removed.length,0);
});

test('capture scope and private-tab opt-in are honored; explicit keep-open capture closes nothing',async()=>{
  const f=fixture([video(1),video(2,{windowId:2}),video(3,{incognito:true}),video(4,{pendingUrl:'https://youtube.com/watch?v=new'})]);
  const preview=await f.request('inbox-preview',{windowId:1});assert.equal(preview.videoCount,1);
  const {taskId}=await f.request('inbox-capture',{windowId:1,closeTabs:false});const done=await finish(f,taskId);
  assert.equal(done.result.inboxSaved,1);assert.equal(f.removed.length,0);assert.equal(f.live.size,4);
  assert.equal((await f.request('inbox-preview',{includePrivate:true})).videoCount,3);
});

test('group capture combines the exact group membership with the window filter',async()=>{
  const f=fixture([video(1),video(2),video(3,{windowId:2})]);
  const {taskId}=await f.request('inbox-capture',{groupBy:'channel',groupKey:'asmongold',windowId:1});
  const done=await finish(f,taskId);assert.equal(done.result.inboxSaved,1);assert.equal((await f.store.list())[0].videoId,'video1');
  assert.equal(done.result.closedTabs,1);assert.deepEqual(f.removed,[1]);assert.ok(f.live.has(3));
});

test('cancel after initial save retains durable links without closing or enriching more tabs',async()=>{
  const f=fixture([video(1),video(2)]);const {taskId}=await f.request('inbox-capture',{closeTabs:true});
  await f.tasks.pump();await f.tasks.cancel(taskId);const done=await finish(f,taskId);
  assert.equal(done.status,'cancelled');assert.equal((await f.store.list()).length,2);assert.equal(f.removed.length,0);assert.equal(f.fetches,0);
});

test('backup round trip and repeated restore retain entries and existing user choices',async()=>{
  const f=fixture();await f.store.merge([entry(1,{status:'done'}),entry(2)]);
  const backup=(await f.request('inbox-export')).backup;
  const fresh=fixture([]);await fresh.store.merge([entry(1,{status:'keep'})]);
  for(let i=0;i<2;i++){const {taskId}=await fresh.request('inbox-restore',{backup});assert.equal((await finish(fresh,taskId)).status,'done')}
  assert.equal((await fresh.store.list()).length,2);assert.equal((await fresh.store.get('video1')).status,'keep');assert.equal(fresh.created.length,0);assert.equal(fresh.removed.length,0);
});

test('opening an inbox video reuses a matching tab, consumes its entry, and never opens arbitrary URLs',async()=>{
  const f=fixture([video(1,{url:'https://youtu.be/video1?t=88'})]);await f.store.merge([entry(1),entry(2)]);await f.store.setStatus('video1','keep');
  assert.equal((await f.request('inbox-open',{videoId:'video1'})).ok,true);assert.equal(f.created.length,0);assert.equal(await f.store.get('video1'),null);
  await f.request('inbox-open',{videoId:'video2'});assert.equal(f.created.length,1);
  assert.equal((await f.request('inbox-open',{videoId:'javascript:alert(1)'})).ok,false);
  const rejected=await f.request('inbox-capture',{closeTabs:true},{id:'test',url:'https://youtube.com',tab:{id:1}});assert.equal(rejected.ok,false);assert.equal((await f.tasks.list()).tasks.length,0);
});

test('filtering and grouping keep titles visible across channel/topic/status views',()=>{
  const items=[{...normalizeInboxItem(entry(1)),topic:'Alex Karp'},{...normalizeInboxItem(entry(2,{status:'keep'})),topic:'Joachim Steinhöfel'}];
  assert.equal(filterInbox(items,{status:'all',search:'steinhöfel'}).length,1);
  assert.equal(filterInbox(items,{status:'open'}).length,1);
  assert.equal(groupInbox(items,'channel')[0].items.length,2);assert.equal(groupInbox(items,'topic').length,2);
});

test('Chrome storage object-key reordering does not falsely fail receipt verification',async()=>{
  const f=fixture(),set=f.api.storage.local.set;
  f.api.storage.local.set=async values=>set(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)))])));
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.closedTabs,1);
});

test('a worker restart resumes enrichment from its checkpoint and keeps stored entries',async()=>{
  const f=fixture(Array.from({length:9},(_,i)=>video(i+1)));
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});await f.tasks.pump();await f.tasks.pump();
  assert.equal(f.fetches,4);assert.equal((await f.store.list()).length,9);
  const resumed=fixture([...f.live.values()],{local:f.api.storage.local,session:f.api.storage.session});
  const done=await finish(resumed,taskId);assert.equal(done.status,'done');assert.equal(resumed.fetches,5);assert.equal(resumed.removed.length,9);
});

test('incomplete metadata keeps the original title and still preserves a reopenable link',async()=>{
  const storage=memoryStorage(),store=createInboxStore(storage);
  await store.merge([entry(1,{title:'Original title',channel:'Unbekannt',metadataComplete:false})]);
  await store.merge([entry(1,{title:'Original title',channel:'Newly resolved channel',metadataComplete:false})],{metadata:true});
  const item=await store.get('video1');assert.equal(item.title,'Original title');assert.equal(item.channel,'Newly resolved channel');assert.equal(item.metadataComplete,true);
});

test('extra URL variants beyond the retention bound remain open without stopping other saved videos',async()=>{
  const f=fixture([...Array.from({length:18},(_,i)=>video(i+1,{url:`https://youtube.com/watch?v=shared&t=${i}`})),video(99)]);
  const {taskId}=await f.request('inbox-capture',{closeTabs:true});const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.inboxSaved,2);assert.equal(done.result.closedTabs,17);assert.equal(done.result.skipped,2);assert.equal(f.live.size,2);
});

const parked=(id,target=`https://youtu.be/parked${id}?t=90`,title=`Gespeichertes Video ${id}`,extra={})=>video(id,{
  url:`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html?title=${encodeURIComponent(title)}#${target}`,
  title:'Alter Tabtitel',...extra
});

test('parked capture saves portable source URLs and the local title before closing without creating or navigating tabs',async()=>{
  const target='https://www.youtube.com/shorts/parked001?t=90&x=a%26b%23c#t=120';
  const f=fixture([parked(1,target,'Ein Video & 🎬',{discarded:true,pinned:true})],{metadata:async()=>({})});
  f.api.tabs.update=async()=>{throw Error('Capture must not activate or load a tab')};
  const remove=f.api.tabs.remove;
  f.api.tabs.remove=async id=>{
    const saved=await f.store.get('parked001');
    assert.equal(saved.openUrl,target);assert.deepEqual(saved.sourceUrls,[target]);assert.equal(saved.title,'Ein Video & 🎬');
    assert.ok(f.live.get(id).discarded);await remove(id);
  };
  assert.deepEqual(await f.request('inbox-preview'),{ok:true,tabCount:1,videoCount:1,
    videos:[{videoId:'parked001',title:'Ein Video & 🎬',parked:true}]});
  const {taskId}=await f.request('inbox-capture');const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.closedTabs,1);assert.equal(done.result.metadataIncomplete,1);
  assert.equal(f.created.length,0);
  const backup=(await f.request('inbox-export')).backup;
  const fresh=fixture([]);const restored=await fresh.request('inbox-restore',{backup});
  assert.equal((await finish(fresh,restored.taskId)).status,'done');
  assert.equal((await fresh.store.get('parked001')).openUrl,target);
});

test('live and parked duplicates consolidate while every matching original can close after verified saving',async()=>{
  const a='https://www.youtube.com/watch?v=shared&t=90';
  const b='https://youtu.be/shared?t=120';
  const f=fixture([parked(1,a),video(2,{url:b}),parked(3,a,'Ein anderer Titel')]);
  const {taskId}=await f.request('inbox-capture');const done=await finish(f,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.inboxSaved,1);assert.equal(done.result.closedTabs,3);
  assert.equal(f.fetches,1);assert.equal((await f.store.get('shared')).openUrl,b);
  assert.deepEqual(new Set((await f.store.get('shared')).sourceUrls),new Set([a,b]));
});

test('parked preview honors window/private scope and rejects unrelated extensions, playlists and pending navigation',async()=>{
  const foreign=parked(6);foreign.url=foreign.url.replace(TAB_PARKER_STORE_ID,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const f=fixture([parked(1),parked(2,undefined,undefined,{windowId:2}),parked(3,undefined,undefined,{incognito:true}),
    parked(4,'https://youtube.com/playlist?list=PLtest'),parked(5,undefined,undefined,{pendingUrl:'https://example.com'}),foreign]);
  assert.equal((await f.request('inbox-preview',{windowId:1})).tabCount,1);
  assert.equal((await f.request('inbox-preview',{includePrivate:true})).tabCount,3);
  const {taskId}=await f.request('inbox-capture',{windowId:1,closeTabs:false});const done=await finish(f,taskId);
  assert.equal(done.result.inboxSaved,1);assert.equal(f.removed.length,0);assert.equal(f.live.size,6);
});

test('a parked tab that changes target or title during capture remains open',async()=>{
  for(const kind of ['target','title']) {
    const f=fixture([parked(1)],{metadata:async()=>({})});const save=f.api.storage.session.set;
    f.api.storage.session.set=async value=>{
      await save(value);
      if(value.atelierTasksV1?.tasks.some(t=>t.inFlight)) {
        f.live.get(1).url=kind==='target'?parked(1,'https://youtu.be/different').url:parked(1,undefined,'Aktualisierter Titel').url;
      }
    };
    const {taskId}=await f.request('inbox-capture');const done=await finish(f,taskId);
    assert.equal(done.status,'done');assert.equal(done.result.skipped,1);assert.equal(f.removed.length,0);
    assert.equal((await f.store.get('parked1')).openUrl,'https://youtu.be/parked1?t=90');
  }
});

test('failed or unverified storage keeps every parked original open',async()=>{
  for(const throws of [true,false]) {
    const f=fixture([parked(1),parked(2)]);
    f.api.storage.local.set=async()=>{if(throws)throw Error('QUOTA_BYTES exceeded')};
    const {taskId}=await f.request('inbox-capture');const done=await finish(f,taskId);
    assert.equal(done.status,'failed');assert.equal(f.removed.length,0);assert.equal(f.live.size,2);
  }
});

test('saving again preserves Inbox status and opening reuses a retained parked tab',async()=>{
  const f=fixture([parked(1,'https://youtu.be/video1?t=90')],{metadata:async()=>({})});
  await f.store.merge([entry(1,{channel:'Unbekannt',status:'keep',metadataComplete:false})]);
  const {taskId}=await f.request('inbox-capture',{closeTabs:false});assert.equal((await finish(f,taskId)).status,'done');
  assert.equal((await f.store.get('video1')).status,'keep');
  assert.equal((await f.request('inbox-open',{videoId:'video1'})).ok,true);
  assert.equal(f.created.length,0);assert.equal(f.live.get(1).active,true);assert.equal(f.removed.length,0);
});

test('single open carries its Inbox title to Parker and repairs a generic existing parked tab',async()=>{
  const f=fixture([]);f.api.runtime.sendMessage=async(id,message)=>message?.type==='tab-parker-identify'&&id===TAB_PARKER_STORE_ID?
    {app:'youtube-tab-parker',protocol:1,id,version:'1.3.4'}:undefined;
  const title='Is France First? – David Betz 🎬';
  await f.store.merge([entry(1,{title,channel:'Unbekannt'})]);
  assert.equal((await f.request('inbox-open',{videoId:'video1'})).ok,true);
  assert.equal(new URL(f.created[0].url).searchParams.get('title'),title);
  assert.equal(await f.store.get('video1'),null);await f.store.merge([entry(1,{title,channel:'Unbekannt'})]);
  const tab=f.live.get(f.created[0].id);tab.url=`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html#https://youtu.be/video1?t=90`;
  assert.equal((await f.request('inbox-open',{videoId:'video1'})).ok,true);
  assert.equal(f.created.length,1);assert.equal(new URL(f.live.get(tab.id).url).searchParams.get('title'),title);
});

test('single title repair leaves a tab alone after navigation during identity verification',async()=>{
  const url=`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html#https://youtu.be/video1`;
  const f=fixture([video(1,{url})]);let probes=0;
  f.api.runtime.sendMessage=async(id,message)=>{
    if(message?.type!=='tab-parker-identify'||id!==TAB_PARKER_STORE_ID)return;
    if(++probes===2)f.live.get(1).url='https://example.org/new-page';
    return {app:'youtube-tab-parker',protocol:1,id,version:'1.3.4'};
  };
  await f.store.merge([entry(1,{channel:'Unbekannt'})]);const opened=await f.request('inbox-open',{videoId:'video1'});
  assert.equal(opened.ok,true);assert.equal(opened.skipped,1);assert.equal(f.live.get(1).url,'https://example.org/new-page');assert.equal(f.created.length,0);assert.equal(f.focus.length,0);
});


test('explicit parked-info enrichment is scoped, excludes private tabs and never closes tabs',async()=>{
 const base='chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Michael+Every#https://youtube.com/watch?v=';
 const calls=[];const f=fixture([video(1,{url:base+'video1'}),video(2,{url:base+'video2',incognito:true}),video(3,{title:'Normal'})],{enrichMetadata:async item=>{calls.push(item.videoId);return {title:'Michael Every',channel:'Reinvent Money'}}});
 await f.store.merge([entry(1,{title:'Michael Every',channel:'Unbekannt',metadataComplete:false})]);await f.store.setStatus('video1','keep');
 const response=await f.request('parked-info-enrich',{titleSearch:'Michael Every'});const done=await finish(f,response.taskId);
 assert.equal(done.status,'done');assert.deepEqual(calls,['video1']);assert.equal(f.removed.length,0);
 const saved=await f.store.get('video1');assert.equal(saved.channel,'Reinvent Money');assert.equal(saved.status,'keep');
 assert.equal((await f.request('parked-info-enrich',{includePrivate:true})).ok,false);
});


test('legacy parked title placeholders become searchable using known Inbox metadata before capture',async()=>{
 const url='chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html#https://youtube.com/watch?v=video1';
 const f=fixture([video(1,{url,title:'YouTube-Video geparkt'})]);await f.store.merge([entry(1,{title:'Michael Every on trade',channel:'Reinvent Money'})]);
 const preview=await f.request('inbox-preview',{titleSearch:'Michael Every',parkedOnly:true});assert.equal(preview.tabCount,1);assert.equal(preview.videos[0].title,'Michael Every on trade');
 const job=await f.request('inbox-capture',{titleSearch:'Michael Every',parkedOnly:true});assert.equal((await finish(f,job.taskId)).result.closedTabs,1);
});

test('late metadata cannot reinsert an opened video; repeated imports still merge by ID',async()=>{
  const f=fixture();await f.store.merge([entry(1)]);
  await f.request('inbox-open',{videoId:'video1'});
  await f.store.merge([entry(1)],{metadata:true,existingOnly:true});
  assert.deepEqual(await f.store.list(),[]);
  const items=[entry(1),entry(1,{url:'https://youtu.be/video1?t=80'}),entry(1,{url:'https://youtube.com/shorts/video1'})];
  for(let attempt=0;attempt<2;attempt++){
    const result=await f.request('inbox-restore',{backup:{format:'tab-atelier-inbox',version:2,items}});
    assert.equal((await finish(f,result.taskId)).status,'done');
  }
  assert.deepEqual((await f.store.list()).map(item=>item.videoId),['video1']);
});
