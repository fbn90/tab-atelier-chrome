import {channelIdentity,channelIdentityKeys,hasCardDuration,preferredVideoTitle} from '../youtube-metadata.js';
import { installYouTubeAutoGroups } from '../youtube-auto-groups.js';
import { parkedVideoTitle, canCloseYouTubeSource } from '../youtube-url.js';
import './i18n-helper.js';
import {installParkerUpdate} from "../parker-update.js";
import { installInbox } from "../inbox-service.js";
import { transferStep } from "../tab-transfer.js";
import { isTrustedPage, validateWindowId } from "../extension-pages.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parseYouTubeVideo as parseWatchVideo,parseYouTubeTab,discoverTabParkers,meaningfulYouTubeTitle,meaningfulChannel} from '../youtube-url.js';
import {createMetadataCache} from '../metadata-cache.js';
import {createAliasStore,ALIAS_STORAGE_KEY} from '../topic-alias-store.js';
import {recognizeTopic,resolveTopicOverride} from '../topic-aliases.js';
import {createTaskService} from '../task-runner.js';
import {runExclusive} from '../action-coordinator.js';
import {memoryStorage,event} from './storage-helper.js';

const video=(id,extra={})=>({id,url:`https://www.youtube.com/watch?v=video${id}`,title:`Video ${id}`,windowId:1,index:id,status:'complete',discarded:false,pinned:false,incognito:false,...extra});
function fixture({tabs=[video(1)],api,fetcher}={}) {
  if(!api) {
    const live=new Map(tabs.map(t=>[t.id,{...t}])),groupTitles=new Map();let nextWindow=10,nextGroup=20;
    api={live,removed:[],moved:[],downloadsSeen:[],injections:0,fetches:[],
      runtime:{id:'test',onMessage:event(),getURL:p=>`chrome-extension://test/${p}`,sendMessage:async()=>{}},
      alarms:{onAlarm:event(),create:async()=>{},clear:async()=>{}},
      storage:{local:memoryStorage(),session:memoryStorage(),onChanged:event()},
      tabs:{query:async(query={})=>[...live.values()].filter(t=>(query.windowId===undefined || t.windowId===query.windowId)&&(query.groupId===undefined||t.groupId===query.groupId)).map(t=>({...t})),get:async id=>{if(!live.has(id))throw Error('No tab');return {...live.get(id)}},
        remove:async id=>{live.delete(id);api.removed.push(id);api.tabs.onRemoved.fire(id)},
        move:async(id,options)=>{api.moved.push(id);Object.assign(live.get(id),{windowId:options.windowId});return {...live.get(id)}},
        update:async(id,options)=>Object.assign(live.get(id),options),group:async({tabIds,groupId})=>{const group=groupId??nextGroup++;for(const id of tabIds)live.get(id).groupId=group;return group},
        onCreated:event(),onUpdated:event(),onRemoved:event(),onReplaced:event()},
      windows:{get:async id=>{const tab=[...live.values()].find(t=>t.windowId===id);if(!tab)throw Error('No window');return {id,type:'normal',incognito:!!tab.incognito}},create:async({tabId,incognito})=>{assert.equal(!!live.get(tabId).incognito,incognito);const id=nextWindow++;live.get(tabId).windowId=id;return {id}}},
      tabGroups:{query:async()=>[...groupTitles].map(([id,title])=>({id,title,windowId:[...live.values()].find(tab=>tab.groupId===id)?.windowId})),get:async id=>{const tab=[...live.values()].find(t=>t.groupId===id);if(!tab)throw Error('No group');return {id,title:groupTitles.get(id),windowId:tab.windowId}},update:async(id,patch)=>{groupTitles.set(id,patch.title)}},
      scripting:{executeScript:async({target})=>{api.injections++;return [{result:{title:`DOM ${parseWatchVideo(live.get(target.tabId).url).videoId}`,channel:'DOM channel'}}]}},
      downloads:{download:async options=>{api.downloadsSeen.push(options);return api.downloadsSeen.length}}
    };
  }
  const service=createTaskService(api,{schedule:()=>{}});
  const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8').replace(/^(?:import|export) .*;\n/gm,'');
  const app=vm.runInNewContext(source+`\n({handleDashboardGroups,handleGetGroupActions,resetGroupScanState,getMetadataPromise,readMetadataFromDom,resolveAutomaticGroupLabels,metadataCache,finishExport,createGroupScanState,
    ageScan(){channelScanState.createdAt=Date.now()-120000;},
    seed(records){channelScanState={generation:scanGeneration,matchedTabs:records.length,records,pendingEntries:[],nextIndex:0,groupsCache:new Map()};}
  })`,{atelierI18n:globalThis.atelierI18n,chrome:api,installYouTubeAutoGroups,parkedVideoTitle,canCloseYouTubeSource,channelIdentity,channelIdentityKeys,hasCardDuration,preferredVideoTitle,installAutomaticMetadata:()=>({}),installParkerUpdate,installParkerPairing:()=>{},installInbox,transferStep,isTrustedPage,validateWindowId,parseWatchVideo,parseYouTubeTab,discoverTabParkers,meaningfulYouTubeTitle,meaningfulChannel,createMetadataCache,createAliasStore,ALIAS_STORAGE_KEY,recognizeTopic,resolveTopicOverride,
    taskService:()=>service,runExclusive:fn=>runExclusive(fn,api),URL,AbortSignal,setTimeout,clearTimeout,console,
    fetch:async url=>{const id=parseWatchVideo(new URL(url).searchParams.get('url')).videoId;api.fetches.push(id);if(fetcher)return fetcher(id);return {ok:true,json:async()=>({title:`API ${id}`,author_name:'API channel'})}}
  });
  return {api,app,service};
}
const entry=tab=>({tabId:tab.id,tabTitle:tab.title,status:tab.status,discarded:tab.discarded,...parseWatchVideo(tab.url),url:parseWatchVideo(tab.url).canonicalUrl});
async function finish(service,id) {
  for(let i=0;i<100;i++) {
    await service.pump();const task=(await service.list()).tasks.find(t=>t.id===id);
    if(['done','failed','interrupted','cancelled'].includes(task.status))return task;
  }
  throw Error('Task did not finish');
}

test('regression: navigation during a pending group scan returns a fresh snapshot, not a null-state error',async()=>{
  let ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
  const f=fixture({tabs:[video(1,{discarded:true})],fetcher:async id=>{if(id==='video1'){ready();await gate}return {ok:true,json:async()=>({title:`Title ${id}`,author_name:id})}}});
  const loading=f.app.handleGetGroupActions('channel');await started;
  f.api.live.get(1).url='https://www.youtube.com/watch?v=changed';
  f.api.tabs.onUpdated.fire(1,{url:f.api.live.get(1).url},f.api.live.get(1));release();
  const first=await loading;assert.equal(first.ok,true);assert.equal(first.isPartial,true);assert.equal(first.groups.length,0);
  await f.app.handleGetGroupActions('channel');
  const cache=await f.app.metadataCache.get('changed');assert.equal(cache.channel,'changed');
});

test('concurrent channel and topic requests never share the wrong grouping mode or duplicate scan records',async()=>{
  const f=fixture({tabs:[1,2,3,4,5].map(i=>video(i,{discarded:true})),fetcher:async()=>({ok:true,json:async()=>({title:'Alex Karp interview',author_name:'Interviews'})})});
  const [channel,topic]=await Promise.all([f.app.handleGetGroupActions('channel'),f.app.handleGetGroupActions('topic')]);
  assert.equal(channel.groupBy,'channel');assert.equal(topic.groupBy,'topic');
  assert.equal(topic.resolvedTabs,5);assert.equal(topic.groups[0].label,'Alex Karp');assert.equal(topic.groups[0].count,5);assert.equal(f.api.fetches.length,5);
});

test('already resolved scan metadata survives worker replacement',async()=>{
  const f=fixture({tabs:Array.from({length:9},(_,i)=>video(i+1,{discarded:true}))});
  assert.equal((await f.app.handleGetGroupActions('channel')).resolvedTabs,4);
  const restarted=fixture({api:f.api});assert.equal((await restarted.app.handleGetGroupActions('channel')).resolvedTabs,8);
  assert.equal(f.api.fetches.length,8);
});

test('DOM metadata is rejected when the tab navigates during collection',async()=>{
  const f=fixture();
  f.api.scripting.executeScript=async()=>{f.api.live.get(1).url='https://youtube.com/watch?v=other';return [{result:{title:'WRONG VIDEO',channel:'WRONG'}}]};
  const resolved=await f.app.getMetadataPromise(entry(video(1)));await f.app.metadataCache.flush();
  assert.equal(resolved.title,'API video1');assert.equal((await f.app.metadataCache.get('video1')).channel,'API channel');
});

test('the injected reader rejects stale SPA metadata even while the URL already shows the new video',async()=>{
  const f=fixture();
  f.api.scripting.executeScript=async({func,args})=>{
    const document={querySelector:selector=>selector==='meta[itemprop="videoId"]'?{content:'oldvideo'}:null};
    const result=vm.runInNewContext(`(${func.toString()})(...args)`,{args,URL,location:{href:video(1).url},document});
    return [{result}];
  };
  assert.equal(Object.keys(await f.app.readMetadataFromDom(1,'video1')).length,2);
  const resolved=await f.app.getMetadataPromise(entry(video(1)));assert.equal(resolved.title,'API video1');
});

test('group moves skip a navigated-away tab, retain pins and separate private windows',async()=>{
  const tabs=[video(1,{pinned:true}),video(2),video(3,{incognito:true}),video(4)];
  const f=fixture({tabs});
  f.app.seed(tabs.map(t=>({tabId:t.id,url:t.url,channel:'Interviews',title:'Alex Karp',incognito:t.incognito})));
  f.api.live.get(4).url='https://other.example/';
  const {taskId}=await f.service.start('move-group-to-window',{groupBy:'channel',groupKey:'interviews'});
  const done=await finish(f.service,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.movedTabs,3);assert.equal(done.result.skipped,1);assert.equal(done.result.windowsCreated,2);
  assert.equal(f.api.live.get(1).pinned,true);assert.equal(f.api.live.get(1).windowId,f.api.live.get(2).windowId);assert.notEqual(f.api.live.get(1).windowId,f.api.live.get(3).windowId);assert.equal(f.api.live.get(4).windowId,1);
});

test('YouTube close job revalidates after the mutation intent has been saved',async()=>{
  const f=fixture();f.app.seed([{tabId:1,url:video(1).url,channel:'Interviews',title:'Alex Karp'}]);
  const save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))f.api.live.get(1).url='https://other.example/'};
  const {taskId}=await f.service.start('close-group-tabs',{groupBy:'channel',groupKey:'interviews'});
  const done=await finish(f.service,taskId);assert.equal(done.status,'done');assert.equal(done.result.closedTabs,0);assert.equal(f.api.removed.length,0);
});

test('large export resumes from its checkpoint; repeated save does not duplicate the download',async()=>{
  const f=fixture({tabs:Array.from({length:9},(_,i)=>video(i+1,{discarded:true}))});
  const {taskId}=await f.service.start('export-watch-tabs',{},'Export');await f.service.pump();
  assert.equal((await f.service.list()).tasks[0].processed,4);
  const restarted=fixture({api:f.api});const done=await finish(restarted.service,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.count,9);assert.equal(f.api.fetches.length,9);
  const first=await restarted.app.finishExport(taskId),second=await restarted.app.finishExport(taskId);
  assert.equal(first.filename,second.filename);assert.equal(f.api.downloadsSeen.length,1);
  const payload=JSON.parse(decodeURIComponent(f.api.downloadsSeen[0].url.split(',')[1]));assert.equal(payload.items.length,9);assert.equal(payload.totalOpenTabs,9);
});

test('collection and export include watch, Shorts, live and short links, with one record per video',async()=>{
  const f=fixture({tabs:[video(1,{url:'https://youtube.com/shorts/first'}),video(2,{url:'https://youtube.com/live/second'}),video(3,{url:'https://youtu.be/third?t=20'}),video(4,{url:'https://youtube.com/watch?v=third&t=40'}),video(5,{url:'https://example.com/'})]});
  const {taskId}=await f.service.start('export-watch-tabs');const done=await finish(f.service,taskId);
  assert.equal(done.result.count,3);assert.equal(done.result.matchedTabs,4);
});

test('unverified tab titles are not cached as verified video metadata for topic actions',async()=>{
  const tab=video(1,{discarded:true,title:'Alex Karp – stale tab title'});
  const f=fixture({tabs:[tab],fetcher:async()=>{throw Error('Offline')}});
  const metadata=await f.app.getMetadataPromise(entry(tab));await f.app.metadataCache.flush();
  assert.equal(metadata.title,null);assert.equal(metadata.channel,'Unbekannt');
  assert.equal((await f.app.metadataCache.get('video1')).title,'');
});

test('dashboard columns share person recognition and restrict membership to the selected window',async()=>{
  const tabs=[video(1),video(2,{windowId:2}),video(3)];
  const f=fixture({tabs});
  f.app.seed(tabs.map((tab,i)=>({tabId:tab.id,windowId:tab.windowId,url:tab.url,title:['Palantir CEO','Alexander C. Karp','Alex Karp'][i],channel:'Interviews'})));
  const all=await f.app.handleDashboardGroups();
  const scoped=await f.app.handleDashboardGroups(1);
  assert.equal(all.topics[0].label,'Alex Karp');assert.equal(all.topics[0].count,3);
  assert.equal(scoped.topics[0].count,2);assert.deepEqual([...scoped.topics[0].tabIds],[1,3]);
  assert.equal(scoped.channels[0].count,2);assert.equal(scoped.isPartial,false);
  const empty=await f.app.handleDashboardGroups(99);assert.equal(empty.channels.length,0);assert.equal(empty.topics.length,0);
  await assert.rejects(f.app.handleDashboardGroups('1'),/Ungültiges Fenster/);
});

test('dashboard close is scoped and skips a tab moved out of that window after planning',async()=>{
  const tabs=[video(1),video(2,{windowId:2}),video(3)];
  const f=fixture({tabs});
  f.app.seed(tabs.map(tab=>({tabId:tab.id,windowId:tab.windowId,url:tab.url,title:'Alex Karp',channel:'Interviews'})));
  const save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))f.api.live.get(3).windowId=2;};
  const {taskId}=await f.service.start('close-group-tabs',{groupBy:'topic',groupKey:'alex karp',windowId:1});
  const done=await finish(f.service,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.closedTabs,1);assert.equal(done.result.skipped,1);
  assert.deepEqual(f.api.removed,[1]);assert.ok(f.api.live.has(2));assert.ok(f.api.live.has(3));
});

test('dashboard window action leaves matching YouTube tabs in other windows alone',async()=>{
  const tabs=[video(1),video(2,{windowId:2})];
  const f=fixture({tabs});
  f.app.seed(tabs.map(tab=>({tabId:tab.id,windowId:tab.windowId,url:tab.url,title:'Alex Karp',channel:'Interviews'})));
  const {taskId}=await f.service.start('move-group-to-window',{groupBy:'channel',groupKey:'interviews',windowId:1});
  const done=await finish(f.service,taskId);
  assert.equal(done.status,'done');assert.equal(done.result.movedTabs,1);
  assert.notEqual(f.api.live.get(1).windowId,1);assert.equal(f.api.live.get(2).windowId,2);
});

test('a long-running dashboard analysis does not restart after sixty seconds',async()=>{
  const f=fixture({tabs:Array.from({length:12},(_,i)=>video(i+1,{discarded:true}))});
  const first=await f.app.handleDashboardGroups();assert.equal(first.resolvedTabs,4);
  f.app.ageScan();
  const second=await f.app.handleDashboardGroups();assert.equal(second.resolvedTabs,8);
  assert.equal(second.matchedTabs,12);assert.equal(second.isPartial,true);
  assert.equal((await f.app.handleDashboardGroups()).isPartial,false);
});

test('parked titles supply local topics even when cached metadata contains no title',async()=>{
  const raw='chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Omarchy%20Linux%20installation#https://www.youtube.com/watch?v=ZdeoJrfxvQ8&pp=ugUEEgJlbg%3D%3D';
  const f=fixture({tabs:[video(1,{url:raw,title:'Omarchy Linux installation'})]});
  await f.app.metadataCache.set('ZdeoJrfxvQ8',{title:null,channel:'Unbekannt'});await f.app.metadataCache.flush();
  const groups=await f.app.handleDashboardGroups();
  assert.equal(groups.matchedTabs,1);assert.equal(groups.topics[0].label,'Omarchy');
  assert.equal(f.api.fetches.length,0);assert.equal(f.api.injections,0);
});


test('all parked titles are available in the first scan without network or four-tab chunking',async()=>{
  const tabs=Array.from({length:80},(_,i)=>video(i+1,{
    url:`chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=${encodeURIComponent(`michael every interview ${i}`)}#https://youtu.be/parked${i}`,
    title:'YouTube-Video geparkt',discarded:true
  }));
  const f=fixture({tabs});
  const groups=await f.app.handleDashboardGroups();
  assert.equal(groups.resolvedTabs,80);assert.equal(groups.isPartial,false);
  assert.equal(groups.topics.length,1);assert.equal(groups.topics[0].label,'Michael Every');assert.equal(groups.topics[0].count,80);
  assert.equal(f.api.fetches.length,0);assert.equal(f.api.injections,0);
});

test('parked records resolve before earlier network-backed tabs in a mixed inventory',async()=>{
  const raw='chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Michael%20Every%20interview#https://youtu.be/parkedLast';
  const f=fixture({tabs:[...Array.from({length:20},(_,i)=>video(i+1,{discarded:true})),video(30,{url:raw,title:'YouTube-Video geparkt',discarded:true})]});
  const scan=await f.app.createGroupScanState();
  assert.equal(scan.records.length,1);assert.equal(scan.records[0].title,'Michael Every interview');
  assert.equal(scan.records[0].tabId,30);assert.equal(scan.pendingEntries.length,20);
  assert.equal(f.api.fetches.length,0);assert.equal(f.api.injections,0);
});

test('a meaningful parked title outranks stale cache while generic parked text preserves a good cached title',async()=>{
  for(const [local,cached,expected] of [
    ['Michael Every on trade','YouTube-Video geparkt','Michael Every on trade'],
    ['Michael Every on trade','Older interview','Michael Every on trade'],
    ['YouTube-Video geparkt','Michael Every on trade','Michael Every on trade']
  ]) {
    const raw=`chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=${encodeURIComponent(local)}#https://youtu.be/localTitle`;
    const f=fixture({tabs:[video(1,{url:raw,title:local,discarded:true})]});
    await f.app.metadataCache.set('localTitle',{title:cached,channel:'Interviews'});await f.app.metadataCache.flush();
    const metadata=await f.app.getMetadataPromise({parked:true,videoId:'localTitle',tabTitle:local});
    assert.equal(metadata.title,expected);assert.equal(metadata.channel,'Interviews');
    const groups=await f.app.handleDashboardGroups();assert.equal(groups.topics[0].label,'Michael Every');
    assert.equal(f.api.fetches.length,0);assert.equal(f.api.injections,0);
  }
});


test('mixed scans return parked topics before any network request and advance on later polls',async()=>{
  for(const request of ['dashboard','actions']) {
    const parked=[30,31,32].map(id=>video(id,{
      url:`chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Michael%20Every%20interview#https://youtu.be/parked${id}`,
      title:'YouTube-Video geparkt',discarded:true
    }));
    const f=fixture({tabs:[...Array.from({length:12},(_,i)=>video(i+1,{discarded:true})),...parked]});
    const get=()=>request==='dashboard'?f.app.handleDashboardGroups():f.app.handleGetGroupActions('topic');
    const first=await get();
    assert.equal(first.resolvedTabs,3);assert.equal(first.isPartial,true);
    const topics=request==='dashboard'?first.topics:first.groups;
    assert.ok(topics.some(group=>group.label==='Michael Every'&&group.count===3));
    assert.equal(f.api.fetches.length,0);assert.equal(f.api.injections,0);
    const second=await get();assert.equal(second.resolvedTabs,7);assert.equal(second.isPartial,true);
    assert.equal(f.api.fetches.length,4);
    const third=await get();assert.equal(third.resolvedTabs,11);assert.equal(third.isPartial,true);
    const final=await get();assert.equal(final.resolvedTabs,15);assert.equal(final.isPartial,false);
    assert.equal(f.api.fetches.length,12);
  }
});


test('parked channel survives grouping without network or an Atelier metadata cache',async()=>{
 const url='chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Michael+Every+on+trade&channel=Reinvent+Money#https://youtube.com/watch?v=channelOne';
 const f=fixture({tabs:[video(1,{url,discarded:true})]});
 const groups=await f.app.handleDashboardGroups();assert.equal(groups.channels[0].label,'Reinvent Money');assert.equal(groups.topics[0].label,'Michael Every');
 assert.equal(f.api.fetches.length,0);assert.equal(f.api.injections,0);
});

test('automatic grouping uses local metadata only and keeps parked titles separate', async () => {
  const loaded = video(1, { title: 'Alex Karp on trade - YouTube' });
  const discarded = video(2, { discarded: true, title: 'Alex Karp interview - YouTube' });
  const parked = video(3, {
    url: 'chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Alex+Karp+on+trade&channel=Reinvent+Money#https://youtube.com/watch?v=video3',
    title: 'Reinvent Money – Alex Karp on trade'
  });
  const f = fixture({tabs:[loaded, discarded, parked]});
  const entries = [loaded, discarded, parked].map(tab => ({ tab, video: parseYouTubeTab(tab.url) }));
  const channel = await f.app.resolveAutomaticGroupLabels(entries, 'channel');
  assert.equal(channel.get(1)?.title, 'DOM channel');
  assert.equal(channel.has(2), false);
  assert.equal(channel.get(3)?.title, 'Reinvent Money');
  const topic = await f.app.resolveAutomaticGroupLabels(entries, 'topic');
  assert.equal(topic.get(2)?.title, 'Alex Karp');
  assert.equal(topic.get(3)?.title, 'Alex Karp');
  assert.equal(f.api.injections, 1);
  assert.deepEqual(f.api.fetches, []);
});
