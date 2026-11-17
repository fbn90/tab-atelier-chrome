import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installInbox} from '../inbox-service.js';
import {registerInboxBatch} from '../inbox-batch.js';
import {createTaskService} from '../task-runner.js';
import {filterInbox,inboxMetadata} from '../inbox-model.js';
import {memoryStorage,event} from './storage-helper.js';
import {TAB_PARKER_STORE_ID} from '../youtube-url.js';

const entry=(i,extra={})=>({url:`https://youtube.com/watch?v=video${i}&t=20`,title:`Polyglot ${i}`,channel:'A channel',status:'open',metadataComplete:true,addedAt:1700000000000,...extra});
const video=(i,extra={})=>({id:i,url:`https://youtu.be/video${i}?t=99`,windowId:1,incognito:false,pinned:false,groupId:-1,...extra});
function fixture(tabs=[]) {
  const live=new Map(tabs.map(t=>[t.id,{...t}])),windows=new Map([[1,{id:1,type:'normal',incognito:false}]]),groups=new Map();
  for(const tab of tabs)windows.set(tab.windowId,{id:tab.windowId,type:'normal',incognito:tab.incognito});
  const calls={created:[],moved:[],grouped:[],closed:[],windows:[],queries:0};let nextTab=10000,nextWindow=100,nextGroup=1000;
  const api={storage:{local:memoryStorage(),session:memoryStorage(),onChanged:event()},
    runtime:{id:'test',getURL:p=>`chrome-extension://test/${p}`,onMessage:event(),sendMessage:async()=>{}},
    alarms:{onAlarm:event(),create:async()=>{},clear:async()=>{}},
    tabs:{
      query:async options=>{calls.queries++;return [...live.values()].filter(t=>(options.windowId===undefined||t.windowId===options.windowId)&&(options.groupId===undefined||t.groupId===options.groupId)&&(!options.windowType||windows.get(t.windowId)?.type===options.windowType)).map(t=>({...t}))},
      get:async id=>{if(!live.has(id))throw Error('No tab');return {...live.get(id)}},
      create:async options=>{assert.ok(windows.has(options.windowId));const tab={...video(nextTab++),url:options.url,windowId:options.windowId,active:options.active};live.set(tab.id,tab);calls.created.push({...tab});return {...tab}},
      move:async(id,options)=>{assert.ok(windows.has(options.windowId));assert.ok(live.has(id));Object.assign(live.get(id),{windowId:options.windowId,groupId:-1});calls.moved.push(id);return {...live.get(id)}},
      update:async(id,patch)=>{assert.ok(live.has(id));Object.assign(live.get(id),patch);return {...live.get(id)}},
      remove:async id=>{calls.closed.push(id);live.delete(id)},
      group:async options=>{
        const id=options.groupId??nextGroup++;
        if(options.groupId===undefined){assert.ok(windows.has(options.createProperties?.windowId));groups.set(id,{id,windowId:options.createProperties.windowId})}
        assert.ok(groups.has(id));
        for(const tabId of options.tabIds){const tab=live.get(tabId);assert.equal(tab.windowId,groups.get(id).windowId);assert.equal(tab.pinned,false);tab.groupId=id;calls.grouped.push(tabId)}
        return id;
      }
    },
    windows:{get:async id=>{if(!windows.has(id))throw Error('No window');return {...windows.get(id)}},
      create:async options=>{
        const window={id:nextWindow++,type:options.type,incognito:options.incognito};windows.set(window.id,window);calls.windows.push(options);
        const tab=options.tabId!==undefined?await api.tabs.move(options.tabId,{windowId:window.id,index:-1}):await api.tabs.create({windowId:window.id,url:options.url,active:true});
        return {...window,tabs:[tab]};
      },update:async id=>{assert.ok(windows.has(id));return {...windows.get(id)}}},
    tabGroups:{query:async()=>[...groups.values()].filter(group=>[...live.values()].some(tab=>tab.groupId===group.id)).map(group=>({...group})),get:async id=>{if(!groups.has(id))throw Error('No group');return {...groups.get(id)}},update:async(id,patch)=>{assert.ok(groups.has(id));Object.assign(groups.get(id),patch);return {...groups.get(id)}}}
  };
  const tasks=createTaskService(api,{schedule:()=>{}}),store=installInbox({api,tasks,getMetadata:async()=>({}),selectGroup:async()=>[],decorate:async items=>items});
  const sender={id:'test',url:api.runtime.getURL('inbox.html'),tab:{id:999,windowId:1,incognito:false}};
  const request=(type,payload={},source=sender)=>new Promise(resolve=>{for(const listener of api.runtime.onMessage.listeners)listener({type,...payload},source,resolve)});
  return {api,tasks,store,request,sender,live,windows,groups,calls};
}
async function finish(tasks,taskId) {
  for(let i=0;i<2000;i++){
    await tasks.pump();const task=(await tasks.list()).tasks.find(t=>t.id===taskId);
    if(['done','failed','interrupted','cancelled'].includes(task.status))return task;
  }
  throw Error('Job did not finish');
}
async function start(f,ids,extra={}){const response=await f.request('inbox-open-batch',{videoIds:ids,target:'new',title:'Polyglot',...extra});assert.equal(response.ok,true);return response.taskId}

test('opening a saved batch reuses parked video tabs without reopening their URLs',async()=>{
  const url=`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html?title=Sp%C3%A4ter#https://youtu.be/video1?t=99`;
  const f=fixture([video(1,{url,discarded:true})]);await f.store.merge([entry(1)]);
  const task=await finish(f.tasks,await start(f,['video1'],{target:'current',windowId:1}));
  assert.equal(task.status,'done');assert.equal(task.result.reusedTabs,1);assert.equal(task.result.createdTabs,0);
  assert.equal(f.live.get(1).url,url);assert.equal(f.calls.created.length,0);assert.equal(f.calls.closed.length,0);
});

test('repeated batches from one channel reuse the same group and window without reopening videos',async()=>{
  const f=fixture();await f.store.merge([entry(1,{channel:'Asmongold TV'}),entry(2,{channel:'Asmongold TV'}),entry(3,{channel:'Asmongold TV'})]);
  const first=await finish(f.tasks,await start(f,['video1','video2'],{title:'asmongold'}));
  assert.equal(await f.store.get('video2'),null);
  await f.store.merge([entry(2,{channel:'Asmongold TV'})]);
  const second=await finish(f.tasks,await start(f,['video2','video3'],{title:'a different search'}));
  assert.equal(second.status,'done');assert.equal(second.result.windowId,first.result.windowId);assert.equal(second.result.groupId,first.result.groupId);
  assert.equal(second.result.groupReused,true);assert.equal(second.result.createdTabs,1);assert.equal(second.result.reusedTabs,1);assert.equal(f.calls.windows.length,1);assert.equal(f.calls.created.length,3);assert.equal(f.live.size,3);
});

test('matching channel groups merge across windows and duplicate videos are discarded before opening new ones',async()=>{
  const f=fixture([video(1,{windowId:2,groupId:10}),video(2,{windowId:2,groupId:10}),video(3,{windowId:3,groupId:11,url:'https://youtube.com/watch?v=video1&t=200'}),video(4,{windowId:3,groupId:11})]);
  f.groups.set(10,{id:10,windowId:2,title:'Asmongold TV',color:'purple',collapsed:true});f.groups.set(11,{id:11,windowId:3,title:'asmongoldTV',color:'blue'});
  await f.store.merge([entry(1,{channel:'Asmongold TV'}),entry(5,{channel:'Asmongold TV'})]);
  const task=await finish(f.tasks,await start(f,['video1','video5']));
  assert.equal(task.status,'done');assert.equal(task.result.groupId,10);assert.equal(task.result.windowId,2);assert.equal(task.result.duplicatesClosed,1);
  assert.deepEqual(f.calls.closed,[3]);assert.equal(f.calls.created.length,1);assert.equal(f.calls.windows.length,0);assert.equal(f.live.get(4).groupId,10);
  assert.equal(f.groups.get(10).color,'purple');assert.equal(f.groups.get(10).collapsed,true);assert.equal((await f.api.tabGroups.query({})).filter(group=>group.title.toLowerCase().replaceAll(' ','')==='asmongoldtv').length,1);
});

test('single-video opening also appends to an existing channel group',async()=>{
  const f=fixture([video(1,{windowId:2,groupId:10})]);f.groups.set(10,{id:10,windowId:2,title:'AsmongoldTV'});
  await f.store.merge([entry(2,{channel:'Asmongold TV'})]);
  const response=await f.request('inbox-open',{videoId:'video2'});assert.ok(response.taskId);
  const task=await finish(f.tasks,response.taskId);assert.equal(task.status,'done');assert.equal(task.result.groupId,10);assert.equal(f.calls.windows.length,0);assert.equal(f.calls.created.length,1);
});

test('a target group video wins over an ungrouped copy and the copy is not globally cleaned up',async()=>{
  const f=fixture([video(1,{windowId:1}),video(100,{windowId:2,groupId:10,url:'https://youtube.com/watch?v=video1'})]);
  f.groups.set(10,{id:10,windowId:2,title:'Asmongold TV'});await f.store.merge([entry(1,{channel:'AsmongoldTV'})]);
  const task=await finish(f.tasks,await start(f,['video1']));assert.equal(task.status,'done');assert.equal(task.result.createdTabs,0);assert.equal(f.live.get(1).windowId,1);assert.equal(f.live.get(1).groupId,-1);assert.equal(f.calls.closed.length,0);
});

test('mixed-channel batches keep their chosen subject group rather than using one channel name',async()=>{
  const f=fixture();await f.store.merge([entry(1,{channel:'Channel A'}),entry(2,{channel:'Channel B'})]);
  const first=await finish(f.tasks,await start(f,['video1','video2'],{title:'Polyglot'}));
  await f.store.merge([entry(1,{channel:'Channel A'}),entry(2,{channel:'Channel B'})]);
  const second=await finish(f.tasks,await start(f,['video1','video2'],{title:'Polyglot'}));
  assert.equal(second.status,'done');assert.equal(first.result.groupId,second.result.groupId);assert.equal(f.groups.get(first.result.groupId).title,'Polyglot');assert.equal(f.calls.windows.length,1);
});

test('private groups and similarly named channel groups are not merged',async()=>{
  const f=fixture([video(1,{windowId:2,groupId:10,incognito:true}),video(2,{windowId:3,groupId:11})]);
  f.groups.set(10,{id:10,windowId:2,title:'Asmongold TV'});f.groups.set(11,{id:11,windowId:3,title:'Asmongold TV Clips'});
  await f.store.merge([entry(3,{channel:'Asmongold TV'})]);const task=await finish(f.tasks,await start(f,['video3']));
  assert.equal(task.status,'done');assert.equal(f.calls.windows.length,1);assert.equal(f.live.get(1).windowId,2);assert.equal(f.live.get(2).windowId,3);assert.equal(f.calls.closed.length,0);
});

test('50 filtered videos open only the first ten and preserve the rest of the Inbox',async()=>{
  const f=fixture([...Array.from({length:25},(_,i)=>video(i+1)),video(999)]);
  await f.store.merge(Array.from({length:60},(_,i)=>entry(i+1,{title:i<50?`Polyglot ${i}`:'Other video',status:i===0?'keep':'open'})));
  const before=structuredClone(await f.store.list()),selection=filterInbox(before,{search:'Polyglot',status:'all'});
  const task=await finish(f.tasks,await start(f,selection.map(v=>v.videoId)));
  assert.equal(task.status,'done');assert.equal(task.result.groupedTabs,10);assert.equal(task.result.createdTabs,0);assert.equal(task.result.reusedTabs,10);
  assert.equal(f.calls.windows.length,1);assert.equal(f.groups.size,1);assert.equal(f.calls.closed.length,0);assert.equal(f.live.size,26);assert.equal(f.live.get(999).windowId,1);
  assert.equal([...f.groups.values()][0].title,'A channel');assert.equal([...f.live.values()].filter(t=>t.groupId===task.result.groupId).length,10);
  const opened=new Set(selection.slice(0,10).map(item=>item.videoId));
  assert.deepEqual(await f.store.list(),before.filter(item=>!opened.has(item.videoId)));assert.ok(f.calls.queries<=12);
});

test('rerunning open reuses videos, pending loads and duplicate selected IDs without creating duplicates',async()=>{
  const f=fixture([video(1,{url:'about:blank',pendingUrl:'https://youtube.com/watch?v=video1'})]);await f.store.merge([entry(1),entry(2)]);
  assert.equal((await finish(f.tasks,await start(f,['video1','video2','video1']))).status,'done');
  assert.deepEqual(await f.store.list(),[]);await f.store.merge([entry(1),entry(2)]);
  assert.equal((await finish(f.tasks,await start(f,['video1','video2']))).result.createdTabs,0);assert.equal(f.calls.created.length,1);assert.equal(f.live.size,2);
});

test('existing duplicate tabs are not closed and private matching tabs remain separate',async()=>{
  const f=fixture([video(1),video(101,{url:'https://youtube.com/watch?v=video1'}),video(2,{windowId:2,incognito:true})]);
  await f.store.merge([entry(1),entry(2)]);const task=await finish(f.tasks,await start(f,['video1','video2']));
  assert.equal(task.status,'done');assert.equal(task.result.createdTabs,1);assert.equal(task.result.reusedTabs,1);assert.equal(f.live.get(2).windowId,2);assert.equal(f.live.get(101).windowId,1);assert.equal(f.calls.closed.length,0);
});

test('current-window group uses sender window rather than arbitrary client window and unpins reused tabs for the group',async()=>{
  const f=fixture([video(1,{pinned:true,windowId:3})]);await f.store.merge([entry(1),entry(2)]);
  const task=await finish(f.tasks,await start(f,['video1','video2'],{target:'current',windowId:999}));
  assert.equal(task.status,'done');assert.equal(f.calls.windows.length,0);assert.equal(task.result.windowId,1);assert.equal(f.live.get(1).pinned,false);assert.equal(f.live.get(1).groupId,task.result.groupId);
});

test('extension pages without sender.tab can explicitly target their own current normal window',async()=>{
  const f=fixture();await f.store.merge([entry(1)]);
  const response=await f.request('inbox-open-batch',{videoIds:['video1'],target:'current',windowId:1},{id:'test',url:f.api.runtime.getURL('inbox.html')});
  assert.equal(response.ok,true);const task=await finish(f.tasks,response.taskId);assert.equal(task.status,'done');assert.equal(task.result.windowId,1);assert.equal(f.calls.windows.length,0);
});

test('unknown saved IDs and invalid selections fail before any tab mutation',async()=>{
  const f=fixture();await f.store.merge([entry(1)]);
  for(const videoIds of [[],['javascript:foo'],['video1',3],new Array(10001).fill('video1')])assert.equal((await f.request('inbox-open-batch',{videoIds})).ok,false);
  const task=await finish(f.tasks,await start(f,['video1','missing']));assert.equal(task.status,'failed');assert.equal(f.calls.windows.length,0);assert.equal(f.calls.created.length,0);
  assert.equal((await f.request('inbox-open-batch',{videoIds:['video1'],target:'arbitrary'})).ok,false);
});

test('bulk routes reject untrusted pages and an incognito current-window target',async()=>{
  const f=fixture();await f.store.merge([entry(1)]);
  const payload={videoIds:['video1'],status:'done',target:'current'};
  for(const type of ['inbox-open-batch','inbox-set-status-batch'])assert.equal((await f.request(type,payload,{...f.sender,url:'https://youtube.com/'})).ok,false);
  assert.equal((await f.request('inbox-open-batch',payload,{...f.sender,tab:{...f.sender.tab,incognito:true}})).ok,false);
  assert.equal((await f.store.get('video1')).status,'open');
});

test('a disappeared destination stops remaining opens, retaining already opened tabs',async()=>{
  const f=fixture();await f.store.merge(Array.from({length:12},(_,i)=>entry(i+1)));
  const id=await start(f,Array.from({length:12},(_,i)=>`video${i+1}`));await f.tasks.pump();await f.tasks.pump();
  assert.equal(f.calls.created.length,5);f.windows.delete(100);
  const task=await finish(f.tasks,id);assert.equal(task.status,'failed');assert.equal((await f.store.list()).length,7);assert.match(task.error,/Zielfenster/);assert.equal(f.calls.created.length,5);assert.equal(f.calls.windows.length,1);
});

test('grouping errors retain opened videos with separate creation counts',async()=>{
  const f=fixture();await f.store.merge([entry(1),entry(2)]);f.api.tabs.group=async()=>{throw Error('Group failure')};
  const task=await finish(f.tasks,await start(f,['video1','video2']));assert.equal(task.status,'failed');assert.equal(task.result.createdTabs,1);assert.equal(task.result.groupedTabs,0);assert.equal(f.calls.created.length,1);assert.equal(f.calls.closed.length,0);
});

test('removing the tab group stops the next batch before additional tabs open',async()=>{
  const f=fixture();await f.store.merge(Array.from({length:8},(_,i)=>entry(i+1)));
  const id=await start(f,Array.from({length:8},(_,i)=>`video${i+1}`));await f.tasks.pump();await f.tasks.pump();f.groups.clear();
  const task=await finish(f.tasks,id);assert.equal(task.status,'failed');assert.equal(f.calls.created.length,5);assert.match(task.error,/Tabgruppe/);
});

test('navigation during intent persistence skips the changed tab without moving it or creating a replacement',async()=>{
  const f=fixture([video(1)]);await f.store.merge([entry(1),entry(2)]);const save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))f.live.get(1).url='https://other.example/'};
  const task=await finish(f.tasks,await start(f,['video1','video2']));assert.equal(task.status,'done');assert.equal(task.result.skipped,1);assert.equal(f.live.get(1).windowId,1);assert.deepEqual(f.calls.moved,[]);assert.equal(f.calls.created.length,1);
});

test('cancellation stops subsequent batches and never undoes already opened tabs',async()=>{
  const f=fixture();await f.store.merge(Array.from({length:20},(_,i)=>entry(i+1)));
  const id=await start(f,Array.from({length:20},(_,i)=>`video${i+1}`));await f.tasks.pump();await f.tasks.pump();await f.tasks.cancel(id);
  const task=await finish(f.tasks,id);assert.equal(task.status,'cancelled');assert.equal(f.calls.created.length,5);assert.equal(f.calls.closed.length,0);
});

test('cancellation during intent persistence prevents the first browser mutation',async()=>{
  const f=fixture();await f.store.merge([entry(1)]);const id=await start(f,['video1']),save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))await f.tasks.cancel(id)};
  const task=await finish(f.tasks,id);assert.equal(task.status,'cancelled');assert.equal(f.calls.created.length,0);assert.equal(f.calls.windows.length,0);
});

test('worker restart resumes completed checkpoints into the same group without reopening earlier videos',async()=>{
  const f=fixture();await f.store.merge(Array.from({length:12},(_,i)=>entry(i+1)));
  const id=await start(f,Array.from({length:12},(_,i)=>`video${i+1}`));await f.tasks.pump();await f.tasks.pump();
  const tasks=createTaskService(f.api,{schedule:()=>{}});registerInboxBatch({api:f.api,tasks,store:f.store});
  const task=await finish(tasks,id);assert.equal(task.status,'done');assert.equal(task.result.groupedTabs,10);assert.equal(f.calls.created.length,10);assert.equal(f.calls.windows.length,1);assert.equal(f.groups.size,1);
});

test('uncertain in-flight interruption is never replayed automatically',async()=>{
  const f=fixture();await f.store.merge([entry(1),entry(2)]);const id=await start(f,['video1','video2']);await f.tasks.pump();
  const stored=await f.api.storage.session.get('atelierTasksV1');stored.atelierTasksV1.tasks[0].inFlight=true;await f.api.storage.session.set(stored);
  const tasks=createTaskService(f.api,{schedule:()=>{}});registerInboxBatch({api:f.api,tasks,store:f.store});
  assert.equal((await finish(tasks,id)).status,'interrupted');assert.equal(f.calls.created.length,0);
});

test('bulk done covers 150 filtered videos beyond rendered pages and preserves all other fields and unselected videos',async()=>{
  const f=fixture();await f.store.merge(Array.from({length:160},(_,i)=>entry(i+1,{title:i<150?'Polyglot':'Other',status:i===155?'keep':'open'})));
  const before=structuredClone(await f.store.list()),ids=filterInbox(before,{search:'polyglot'}).map(v=>v.videoId);
  const result=await f.request('inbox-set-status-batch',{videoIds:ids,status:'done'});assert.equal(result.ok,true);assert.equal(result.count,150);
  for(const item of await f.store.list()){
    const old=before.find(v=>v.videoId===item.videoId);assert.equal(item.status,ids.includes(item.videoId)?'done':old.status);
    assert.deepEqual({...item,status:old.status,updatedAt:old.updatedAt},old);
  }
  await f.request('inbox-set-status-batch',{videoIds:ids,status:'open'});assert.equal((await f.store.list()).filter(v=>v.status==='done').length,0);assert.equal(f.calls.created.length,0);assert.equal(f.calls.closed.length,0);
});

test('bulk status validates the whole selection first and reports write failures',async()=>{
  const f=fixture();await f.store.merge([entry(1),entry(2)]);
  assert.equal((await f.request('inbox-set-status-batch',{videoIds:['video1','missing'],status:'done'})).ok,false);assert.equal((await f.store.get('video1')).status,'open');
  assert.equal((await f.request('inbox-set-status-batch',{videoIds:['video1'],status:'bad'})).ok,false);
  f.api.storage.local.set=async()=>{throw Error('Quota exceeded')};assert.equal((await f.request('inbox-set-status-batch',{videoIds:['video1','video2'],status:'done'})).ok,false);assert.equal((await f.store.get('video2')).status,'open');
});

test('compact metadata keeps channel/date labels and suppresses duplicate channel fallback topics',()=>{
  const item={channel:'Asmongold',topic:'Asmongold',addedAt:1700000000000};
  assert.equal(inboxMetadata(item).match(/Asmongold/g).length,1);assert.match(inboxMetadata(item),/Kanal: Asmongold · Hinzugefügt:/);
  assert.match(inboxMetadata({...item,topic:'Alex Karp'}),/Thema: Alex Karp/);
});


test('merging channel groups recognizes a parked and a loaded copy as the same video',async()=>{
  const parked=`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html#https://youtu.be/video1`;
  const f=fixture([video(1,{url:parked,windowId:2,groupId:10}),video(2,{url:'https://youtube.com/watch?v=video1',windowId:3,groupId:11})]);
  f.groups.set(10,{id:10,windowId:2,title:'A channel'});f.groups.set(11,{id:11,windowId:3,title:'A channel'});
  await f.store.merge([entry(1)]);
  const task=await finish(f.tasks,await start(f,['video1']));
  assert.equal(task.status,'done',task.error);assert.equal(task.result.duplicatesClosed,1);
  assert.equal(f.calls.created.length,0);assert.equal(f.live.size,1);
});

test('a new batch sends saved titles to Parker and repairs reused placeholder titles without creating duplicates',async()=>{
  const f=fixture();f.api.runtime.sendMessage=async(id,message)=>message?.type==='tab-parker-identify'&&id===TAB_PARKER_STORE_ID?
    {app:'youtube-tab-parker',protocol:1,id,version:'1.3.4'}:undefined;
  await f.store.merge([entry(1,{title:'Is France First? – David Betz 🎬'}),entry(2,{title:'A second title & more'})]);
  const task=await finish(f.tasks,await start(f,['video1','video2'],{target:'current',windowId:1}));
  assert.equal(task.status,'done',task.error);assert.equal(task.result.createdTabs,2);
  assert.deepEqual(await f.store.list(),[]);
  for(const tab of f.calls.created){const url=new URL(tab.url);assert.equal(url.protocol,'chrome-extension:');assert.equal(url.searchParams.get('title'),tab.url.includes('video1')?'Is France First? – David Betz 🎬':'A second title & more');}
  const first=[...f.live.values()].find(tab=>tab.url.includes('video1'));
  first.url=`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html#https://youtu.be/video1?t=99`;
  const count=f.calls.created.length;
  await f.store.merge([entry(1,{title:'Is France First? – David Betz 🎬'}),entry(2,{title:'A second title & more'})]);
  const reopened=await finish(f.tasks,await start(f,['video1','video2'],{target:'current',windowId:1}));
  assert.equal(reopened.status,'done',reopened.error);assert.equal(reopened.result.createdTabs,0);assert.equal(reopened.result.reusedTabs,2);
  assert.equal(f.calls.created.length,count);assert.equal(new URL(f.live.get(first.id).url).searchParams.get('title'),'Is France First? – David Betz 🎬');
});

test('a new-window batch seeds Parker with the saved title before consuming the Inbox entry',async()=>{
  const f=fixture();f.api.runtime.sendMessage=async(id,message)=>message?.type==='tab-parker-identify'&&id===TAB_PARKER_STORE_ID?
    {app:'youtube-tab-parker',protocol:1,id,version:'1.3.4'}:undefined;
  await f.store.merge([entry(1,{title:'Saved title',status:'keep'})]);const before=await f.store.get('video1');
  const task=await finish(f.tasks,await start(f,['video1']));
  assert.equal(task.status,'done',task.error);assert.equal(task.result.createdTabs,1);
  assert.equal(new URL(f.calls.windows[0].url).searchParams.get('title'),before.title);
  assert.equal(new URL(f.calls.windows[0].url).hash.slice(1),before.openUrl);
  assert.equal(await f.store.get('video1'),null);
});

test('navigation during Parker verification skips batch title repair and preserves the new page',async()=>{
  const url=`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html#https://youtu.be/video1`;
  const f=fixture([video(1,{url})]);let probes=0;
  f.api.runtime.sendMessage=async(id,message)=>{
    if(message?.type!=='tab-parker-identify'||id!==TAB_PARKER_STORE_ID)return;
    if(++probes===2)f.live.get(1).url='https://example.org/new-page';
    return {app:'youtube-tab-parker',protocol:1,id,version:'1.3.4'};
  };
  await f.store.merge([entry(1)]);const task=await finish(f.tasks,await start(f,['video1'],{target:'current',windowId:1}));
  assert.equal(task.status,'done',task.error);assert.equal(task.result.skipped,1);assert.equal(f.live.get(1).url,'https://example.org/new-page');assert.equal(f.calls.created.length,0);
});

test('resuming an older prepared batch without record titles recovers titles from the Inbox',async()=>{
  const f=fixture();f.api.runtime.sendMessage=async(id,message)=>message?.type==='tab-parker-identify'&&id===TAB_PARKER_STORE_ID?
    {app:'youtube-tab-parker',protocol:1,id,version:'1.3.4'}:undefined;
  await f.store.merge([entry(1,{title:'Saved before update 🎬'})]);const id=await start(f,['video1']);await f.tasks.pump();
  const key=`atelierTasksV1:${id}:data`,records=(await f.api.storage.session.get(key))[key];
  for(const record of records)delete record.title;
  await f.api.storage.session.set({[key]:records});
  const resumed=createTaskService(f.api,{schedule:()=>{}});registerInboxBatch({api:f.api,tasks:resumed,store:f.store});
  const task=await finish(resumed,id);assert.equal(task.status,'done',task.error);assert.equal(task.result.createdTabs,1);
  assert.equal(new URL(f.calls.created[0].url).searchParams.get('title'),'Saved before update 🎬');
});

test('a review batch opens only the available slots and leaves every remaining entry in the Inbox',async()=>{
  const f=fixture([video(99)]);
  await f.api.storage.local.set({tabAutomationSettingsV1:{youtubeLimitEnabled:true,youtubeLimit:3}});
  await f.store.merge(Array.from({length:10},(_,i)=>entry(i+1)));
  const task=await finish(f.tasks,await start(f,Array.from({length:10},(_,i)=>'video'+(i+1)),{target:'current'}));
  assert.equal(task.status,'done');assert.equal(task.result.createdTabs,2);assert.equal(task.result.limitSkipped,8);
  assert.deepEqual((await f.store.list()).map(item=>item.videoId),Array.from({length:8},(_,i)=>'video'+(i+3)));assert.equal(f.calls.closed.length,0);
});

test('a cancelled review resumes in its exact existing group without opening more copies',async()=>{
  const f=fixture([video(99,{pinned:true,url:'https://www.youtube.com/watch?v=video11'})]);
  await f.api.storage.local.set({tabAutomationSettingsV1:{totalLimitEnabled:true,totalLimit:1,youtubeLimitEnabled:true,youtubeLimit:2}});
  await f.store.merge(Array.from({length:12},(_,i)=>entry(i+1)));
  const params={filters:{search:'Polyglot',mode:'channel',status:'open'},groupKey:'A channel',amount:20};
  const preview=await f.request('inbox-review-preview',params);
  assert.equal(preview.count,12);assert.equal(preview.needsException,true);
  const result=await f.request('inbox-review-start',{...params,...preview,bypass:true,target:'new'});
  assert.equal(result.ok,true,result.error);
  await f.tasks.pump();
  await f.tasks.cancel(result.taskId);
  await f.tasks.pump();
  assert.equal((await f.tasks.list()).tasks.find(t=>t.id===result.taskId).status,'cancelled');
  assert.equal(f.calls.windows.length,1);
  await f.tasks.retry(result.taskId);
  const finished=await finish(f.tasks,result.taskId);
  assert.equal(finished.status,'done',finished.error);
  assert.equal(finished.result.groupedTabs,11);assert.equal(finished.result.skipped,1);
  assert.equal(f.calls.windows.length,1);assert.equal(f.calls.created.length,12); // 11 fresh videos and the protection tab.
  assert.equal(f.calls.closed.length,0);assert.deepEqual((await f.store.list()).map(item=>item.videoId),['video11']);
});
