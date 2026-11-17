import './i18n-helper.js';
import test from 'node:test';
import { taskService } from '../task-runner.js';
import assert from 'node:assert/strict';
import { duplicatePairs, domainSummary, domainOf, windowSortPlan } from '../tab-rules.js';
import { TAB_PARKER_STORE_ID } from '../youtube-url.js';

const tab = (id, extras = {}) => ({ id, url: 'https://youtube.com/watch?v=one', status:'complete', discarded:false, pinned: false, incognito: false, windowId: 1, index: id, groupId: -1, ...extras });
const parked = (target, title = 'Ein Titel') => `chrome-extension://${TAB_PARKER_STORE_ID}/parked.html?title=${encodeURIComponent(title)}#${target}`;

test('newer tab wins even if tab strip order changes', () => {
  const pairs = duplicatePairs([tab(2), tab(1)], {1: 1, 2: 2});
  assert.equal(pairs[0].keeper.id, 2);
  assert.equal(pairs[0].loser.id, 1);
});
test('pinned wins; multiple pinned copies retain the newest pinned', () => {
  const pairs = duplicatePairs([tab(1), tab(2, {pinned:true}), tab(3, {pinned:true})], {1:1,2:2,3:3});
  assert.deepEqual(pairs.map(p => p.loser.id), [2,1]);
  assert.ok(pairs.every(p => p.keeper.id === 3));
});
test('non-time parameters and fragments are preserved; private context is independent', () => {
  const tabs = [tab(1), tab(2,{url:'https://youtube.com/watch?v=two'}), tab(3,{url:'https://youtube.com/watch?v=one&list=playlist'}), tab(4,{url:'https://youtube.com/watch?v=one#x'}),tab(5,{incognito:true}),tab(6,{url:'chrome://newtab/'}),tab(7,{url:'chrome://newtab/'})];
  assert.equal(duplicatePairs(tabs, {}).length, 0);
});
test('pending, loading and discarded tabs cannot establish a duplicate', () => {
  for (const extras of [{url:'chrome://newtab/',pendingUrl:tab(1).url},{pendingUrl:'https://other.example/'},{status:'loading'},{discarded:true}]) {
    assert.equal(duplicatePairs([tab(1),tab(2,extras)], {1:1,2:2}).length, 0);
    assert.equal(duplicatePairs([tab(1,extras),tab(2)], {1:1,2:2}).length, 0);
  }
});
test('domain counts cover every tab, merge www only and sort by count', () => {
  const summary = domainSummary([tab(1),tab(2,{url:'https://www.youtube.com/a'}),tab(3,{url:'https://studio.youtube.com/a'}),tab(4,{url:'chrome://newtab/'}),tab(5,{url:''})]);
  assert.deepEqual(summary[0], {domain:'youtube.com',count:2});
  assert.equal(summary.reduce((n,row)=>n+row.count,0),5);
  assert.equal(domainOf(tab(6,{url:'https://a.example.co.uk/'})), 'a.example.co.uk');
});

function event() {
  const listeners=[];
  return {addListener(fn){listeners.push(fn)},fire(...args){for(const fn of listeners) fn(...args)},listeners};
}
function mockChrome(initial) {
  const tabs = new Map(initial.map(t => [t.id,{...t}]));
  // Most fixtures represent an already running browser outside its startup grace.
  const session = {tabManagerSessionV1:{next:1,order:{},openedAt:{},autoGraceUntil:0}};
  const local = {};
  const moves = [];
  const api = {
    tabs: {
      query: async(query={})=>[...tabs.values()].filter(t=>query.windowId===undefined || t.windowId===query.windowId).map(t=>({...t})),
      get: async id=>{if(!tabs.has(id)) throw Error('No tab'); return {...tabs.get(id)}},
      remove:async id=>{if(!tabs.delete(id)) throw Error('No tab');api.tabs.onRemoved.fire(id)},
      move:async(id, options)=>{
        const current=tabs.get(id);
        const source=current.windowId;
        const destination=options.windowId ?? source;
        const remaining=[...tabs.values()].filter(t=>t.windowId===destination && t.id!==id).sort((a,b)=>a.index-b.index);
        const index=options.index<0 ? remaining.length : options.index;
        Object.assign(current,{windowId:destination});
        remaining.splice(index,0,current);
        remaining.forEach((t,i)=>t.index=i);
        if(source!==destination) [...tabs.values()].filter(t=>t.windowId===source).sort((a,b)=>a.index-b.index).forEach((t,i)=>t.index=i);
        moves.push({id,...options}); return {...current};
      },
      ungroup:async ids=>{for(const id of ids) tabs.get(id).groupId=-1},
      update:async(id, options)=>Object.assign(tabs.get(id), options),
      onCreated:event(),onUpdated:event(),onRemoved:event(),onReplaced:event(),onAttached:event()
    },
    tabGroups:{move:async(groupId,{index})=>{
      const members=[...tabs.values()].filter(t=>t.groupId===groupId).sort((a,b)=>a.index-b.index);
      const others=[...tabs.values()].filter(t=>t.windowId===members[0].windowId && t.groupId!==groupId).sort((a,b)=>a.index-b.index);
      others.splice(index,0,...members);others.forEach((t,i)=>t.index=i);
    }},
    windows:{get:async id=>{const tab=[...tabs.values()].find(t=>t.windowId===id);if(!tab)throw Error('No window');return {id,type:'normal',incognito:!!tab.incognito}},create:async options=>{const id=100+moves.length; moves.push({create:true,...options,id}); tabs.get(options.tabId).windowId=id; return {id}},update:async()=>{}},
    alarms:{onAlarm:event(),create:async()=>{},clear:async()=>{}},
    runtime:{id:'test',getURL:p=>`chrome-extension://test/${p}`,sendMessage:async()=>{},onInstalled:event(),onStartup:event(),onMessage:event()},
    storage:{session:{get:async()=>structuredClone(session),set:async value=>Object.assign(session,structuredClone(value)),remove:async keys=>{for(const key of [keys].flat())delete session[key]}},
      local:{get:async()=>structuredClone(local),set:async value=>Object.assign(local,structuredClone(value))}},
    action:{setBadgeBackgroundColor:async()=>{},setBadgeText:async({text})=>{api.badge=text},setTitle:async()=>{}}
  };
  const fireUpdated=api.tabs.onUpdated.fire;
  api.tabs.onUpdated.fire=(id,change,current)=>fireUpdated(id,change,current||{...tabs.get(id),...change});
  async function rawRequest(type,payload={},sender={id:'test',url:api.runtime.getURL('popup.html')}) {
    return new Promise(resolve=>{for(const fn of api.runtime.onMessage.listeners)fn({type,...payload},sender,resolve)});
  }
  async function request(type,payload={}) {
    const first=await rawRequest(type,payload);
    if(!first.taskId)return first;
    const service=taskService(api);
    for(let i=0;i<1000;i++) {
      await service.pump();
      const task=(await service.list()).tasks.find(t=>t.id===first.taskId);
      if(task.status==='done'){await rawRequest('get-domains');return task.result;}
      if(['failed','cancelled','interrupted'].includes(task.status))return {ok:false,error:task.error};
      await new Promise(resolve=>setImmediate(resolve));
    }
    throw Error('Task did not finish');
  }
  return {api,tabs,moves,request,rawRequest,session,local};
}

test('worker integration: explicit cleanup, creation, suspension, domain actions and badge', async()=>{
  const mock=mockChrome([tab(1),tab(2,{pinned:true}),tab(3,{url:'https://example.org/'})]);
  globalThis.chrome=mock.api;
  await import('../tab-manager.js?first');
  mock.api.runtime.onInstalled.fire();
  let result=await mock.request('get-domains');
  assert.equal(result.total,3);
  assert.equal(mock.api.badge,'3');
  assert.equal((await mock.request('deduplicate-tabs')).closed,1);
  result=await mock.request('get-domains');
  assert.equal(result.total,2);
  assert.ok(mock.tabs.has(2)); assert.ok(!mock.tabs.has(1));
  assert.equal(mock.api.badge,'2');
  mock.tabs.set(4,tab(4)); mock.api.tabs.onCreated.fire(tab(4));
  await mock.request('get-domains'); assert.ok(!mock.tabs.has(4));
  mock.tabs.set(5,tab(5,{url:'https://www.youtube.com/watch?v=other',windowId:2}));
  mock.api.tabs.onCreated.fire(mock.tabs.get(5)); await mock.request('get-domains');
  // Simulate a fresh worker with the persisted session but no in-memory state.
  for(const name of ['onCreated','onUpdated','onRemoved','onReplaced']) mock.api.tabs[name].listeners.length=0;
  for(const name of ['onInstalled','onStartup','onMessage']) mock.api.runtime[name].listeners.length=0;
  await import('../tab-manager.js?restart');
  mock.tabs.set(6,tab(6,{url:mock.tabs.get(5).url})); mock.api.tabs.onCreated.fire(mock.tabs.get(6));
  await mock.request('get-domains'); assert.ok(!mock.tabs.has(5)); assert.ok(mock.tabs.has(6));
  result=await mock.request('domain-window',{domain:'youtube.com'});
  assert.equal(result.count,2); assert.equal(result.windowsCreated,1);
  assert.equal(mock.tabs.get(2).windowId,mock.tabs.get(6).windowId);
  assert.equal(mock.tabs.get(2).pinned,true);
  result=await mock.request('domain-close',{domain:'youtube.com'});
  assert.equal(result.count,2); assert.ok(mock.tabs.has(3));
  await mock.request('get-domains'); assert.equal(mock.api.badge,'1');
});

test('reject page-originated destructive messages', async()=>{
  const mock=mockChrome([tab(1)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?security');
  const result=await mock.rawRequest('domain-close',{domain:'youtube.com'},{id:'test',url:'https://youtube.com',tab:{id:1}});
  assert.equal(result.ok,false);assert.equal(mock.tabs.size,1);
});

test('concurrent new tabs leave exactly one survivor', async()=>{
  const mock=mockChrome([tab(1)]); globalThis.chrome=mock.api;
  await import('../tab-manager.js?concurrent');
  mock.api.runtime.onInstalled.fire(); await mock.request('get-domains');
  for(let id=2;id<25;id++) {mock.tabs.set(id,tab(id));mock.api.tabs.onCreated.fire(tab(id))}
  await mock.request('get-domains');
  assert.deepEqual([...mock.tabs.keys()],[24]);
});

test('navigation during cleanup prevents closing a now-different tab', async()=>{
  const mock=mockChrome([tab(1),tab(2)]); globalThis.chrome=mock.api;
  const get=mock.api.tabs.get;
  mock.api.tabs.get=async id=>{if(id===2) mock.tabs.get(id).url='https://other.example/';return get(id)};
  await import('../tab-manager.js?navigation');
  await mock.request('deduplicate-tabs');
  assert.equal(mock.tabs.size,2);
});

test('normal and incognito domains move into separate windows', async()=>{
  const mock=mockChrome([tab(1),tab(2,{incognito:true,windowId:2})]); globalThis.chrome=mock.api;
  await import('../tab-manager.js?incognito');
  const result=await mock.request('domain-window',{domain:'youtube.com'});
  assert.equal(result.windowsCreated,2);
  assert.equal(result.count,2);
  assert.notEqual(mock.tabs.get(1).windowId,mock.tabs.get(2).windowId);
  assert.deepEqual(mock.moves.filter(m=>m.create).map(m=>m.incognito),[false,true]);
});

const orderOf = (mock, windowId=1) => [...mock.tabs.values()].filter(t=>t.windowId===windowId).sort((a,b)=>a.index-b.index).map(t=>t.id);
const sort = (mock, dissolveGroups=false) => mock.request('sort-window-oldest',{windowId:1,dissolveGroups});

test('window sorting uses recorded age, preserves pins and affects only the requested window',async()=>{
  const mock=mockChrome([tab(30,{index:0,pinned:true}),tab(20,{index:1,pinned:true}),tab(3,{index:2}),tab(2,{index:3}),tab(1,{index:4}),tab(8,{windowId:2,index:0})]);
  globalThis.chrome=mock.api;
  mock.session.tabManagerSessionV1={next:7,order:{30:6,20:5,3:3,2:2,1:1,8:4}};
  await import('../tab-manager.js?sort');
  const result=await sort(mock);
  assert.equal(result.ok,true);
  assert.deepEqual(orderOf(mock),[20,30,1,2,3]);
  assert.deepEqual(orderOf(mock,2),[8]);
  assert.equal(result.estimated,5);
  assert.ok(mock.tabs.get(20).pinned && mock.tabs.get(30).pinned);
});

test('groups stay contiguous, sort by oldest member and sort internally',async()=>{
  const mock=mockChrome([tab(5,{index:0,groupId:7}),tab(1,{index:1,groupId:7}),tab(4,{index:2,groupId:8}),tab(3,{index:3,groupId:8}),tab(2,{index:4})]);
  globalThis.chrome=mock.api;
  await import('../tab-manager.js?sort-groups');
  const result=await sort(mock);
  assert.equal(result.ok,true);assert.equal(result.grouped,true);
  assert.deepEqual(orderOf(mock),[1,5,2,3,4]);
  assert.equal(mock.tabs.get(5).groupId,7);assert.equal(mock.tabs.get(3).groupId,8);
});

test('optional ungrouping provides continuous oldest-to-newest order',async()=>{
  const mock=mockChrome([tab(5,{index:0,groupId:7}),tab(1,{index:1,groupId:7}),tab(4,{index:2,groupId:8}),tab(3,{index:3,groupId:8}),tab(2,{index:4})]);
  globalThis.chrome=mock.api;
  await import('../tab-manager.js?sort-ungroup');
  const result=await sort(mock,true);
  assert.equal(result.ok,true);assert.equal(result.grouped,false);
  assert.deepEqual(orderOf(mock),[1,2,3,4,5]);
  assert.ok([...mock.tabs.values()].every(t=>t.groupId===-1));
});

test('observed opening order outranks IDs and survives navigation and worker restart',async()=>{
  const mock=mockChrome([tab(100,{url:'https://existing.example/'})]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?age-first');
  await sort(mock);
  mock.tabs.set(90,tab(90,{url:'https://first.example/'}));mock.api.tabs.onCreated.fire(mock.tabs.get(90));
  mock.tabs.set(80,tab(80,{url:'https://second.example/'}));mock.api.tabs.onCreated.fire(mock.tabs.get(80));
  await mock.request('get-domains');
  const saved=structuredClone(mock.session.tabManagerSessionV1);
  assert.ok(saved.openedAt[90]>0);assert.ok(saved.openedAt[80]>0);assert.equal(saved.openedAt[100],null);
  for(const name of ['onCreated','onUpdated','onRemoved','onReplaced']) mock.api.tabs[name].listeners.length=0;
  for(const name of ['onInstalled','onStartup','onMessage']) mock.api.runtime[name].listeners.length=0;
  await import('../tab-manager.js?age-restart');
  mock.tabs.get(90).url='https://changed.example/';mock.api.tabs.onUpdated.fire(90,{url:mock.tabs.get(90).url});
  const result=await sort(mock);
  assert.equal(result.ok,true);assert.deepEqual(orderOf(mock),[100,90,80]);
  assert.equal(mock.session.tabManagerSessionV1.openedAt[90],saved.openedAt[90]);
});

test('newest event wins during a burst even with descending tab IDs',async()=>{
  const mock=mockChrome([tab(100)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?burst-age');
  await mock.request('deduplicate-tabs');
  for(const id of [90,80,70]) {mock.tabs.set(id,tab(id));mock.api.tabs.onCreated.fire(mock.tabs.get(id))}
  await mock.request('get-domains');
  assert.deepEqual([...mock.tabs.keys()],[70]);
});

test('tab replacement inherits creation age rather than becoming newest',async()=>{
  const mock=mockChrome([tab(1,{url:'https://one.example/'}),tab(2,{url:'https://two.example/'})]);
  globalThis.chrome=mock.api;
  mock.session.tabManagerSessionV1={next:3,order:{1:1,2:2},openedAt:{1:1000,2:2000}};
  await import('../tab-manager.js?replacement-age');
  mock.tabs.delete(1);mock.tabs.set(9,tab(9,{url:'https://one.example/'}));mock.api.tabs.onReplaced.fire(9,1);
  await mock.request('get-domains');
  const result=await sort(mock);
  assert.equal(result.ok,true);assert.deepEqual(orderOf(mock),[9,2]);
  assert.equal(mock.session.tabManagerSessionV1.openedAt[9],1000);
});

test('sort rejects invalid window and moved tabs without pulling tabs back',async()=>{
  const mock=mockChrome([tab(2),tab(1)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?sort-race');
  assert.equal((await mock.request('sort-window-oldest',{windowId:-1,dissolveGroups:false})).ok,false);
  const get=mock.api.tabs.get;
  mock.api.tabs.get=async id=>{if(id===1) mock.tabs.get(id).windowId=2;return get(id)};
  assert.equal((await sort(mock)).ok,false);
  assert.equal(mock.tabs.get(1).windowId,2);assert.equal(mock.moves.length,0);
});

test('regression: unrelated page completion must not purge duplicate tabs in other windows',async()=>{
  const mock=mockChrome([tab(1),tab(2),tab(3,{url:'https://unrelated.example/',windowId:2})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?unrelated-completion');
  mock.api.tabs.onUpdated.fire(3,{status:'complete'},mock.tabs.get(3));
  await mock.request('get-domains');assert.equal(mock.tabs.size,3);
});

test('regression: pending navigation cannot sacrifice a loaded original',async()=>{
  const mock=mockChrome([tab(1),tab(2,{url:'chrome://newtab/',pendingUrl:tab(1).url,status:'loading'})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?pending-target');
  mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  await mock.request('get-domains');assert.ok(mock.tabs.has(1));
  mock.tabs.get(2).url='https://redirected.example/';delete mock.tabs.get(2).pendingUrl;mock.tabs.get(2).status='complete';
  mock.api.tabs.onUpdated.fire(2,{url:'https://redirected.example/',status:'complete'},mock.tabs.get(2));
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
});

test('regression: extension reload and browser startup never close existing tabs',async()=>{
  const mock=mockChrome([tab(1),tab(2)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?lifecycle-safe');
  mock.api.runtime.onInstalled.fire();await mock.request('get-domains');assert.equal(mock.tabs.size,2);
  mock.api.runtime.onStartup.fire();await mock.request('get-domains');assert.equal(mock.tabs.size,2);
});

test('regression: pinning or moving a tab cannot trigger global cleanup',async()=>{
  const mock=mockChrome([tab(1),tab(2),tab(3,{url:'https://other.example/'})]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?pin-no-purge');
  mock.api.tabs.onUpdated.fire(3,{pinned:true},mock.tabs.get(3));
  await mock.request('get-domains');assert.equal(mock.tabs.size,3);
});

async function restartWorker(mock, name) {
  for(const event of ['onCreated','onUpdated','onRemoved','onReplaced']) mock.api.tabs[event].listeners.length=0;
  for(const event of ['onInstalled','onStartup','onMessage']) mock.api.runtime[event].listeners.length=0;
  await import(`../tab-manager.js?${name}`);
}

test('only the newly opened URL is deduplicated and every removal is logged',async()=>{
  const mock=mockChrome([tab(1),tab(2,{url:'https://other.example/'}),tab(3,{url:'https://other.example/'})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?scoped-automatic');
  mock.tabs.set(4,tab(4));mock.api.tabs.onCreated.fire(mock.tabs.get(4));
  const result=await mock.request('get-domains');
  assert.deepEqual([...mock.tabs.keys()],[2,3,4]);
  assert.equal(result.closeLog.length,1);
  assert.equal(result.closeLog[0].url,tab(1).url);
  assert.equal(result.closeLog[0].keptTabId,4);
  assert.equal(result.closeLog[0].outcome,'geschlossen');
});

test('a new unpinned duplicate cannot purge older unpinned copies of a pinned tab',async()=>{
  const mock=mockChrome([tab(1,{pinned:true}),tab(2)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?pinned-scope');
  mock.tabs.set(3,tab(3));mock.api.tabs.onCreated.fire(mock.tabs.get(3));
  await mock.request('get-domains');assert.deepEqual([...mock.tabs.keys()],[1,2]);
});

test('later navigation in a completed new tab never sacrifices existing pages',async()=>{
  const mock=mockChrome([tab(1)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?one-navigation');
  mock.tabs.set(2,tab(2,{url:'https://initial.example/'}));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  await mock.request('get-domains');
  mock.tabs.get(2).url=tab(1).url;
  mock.api.tabs.onUpdated.fire(2,{url:tab(1).url,status:'complete'});
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
});

test('redirecting a new tab to an existing landing page keeps both tabs',async()=>{
  const mock=mockChrome([tab(1)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?redirect-landing');
  mock.tabs.set(2,tab(2,{url:'https://initial.example/',status:'loading'}));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  await mock.request('get-domains');
  Object.assign(mock.tabs.get(2),{url:tab(1).url,status:'complete'});
  mock.api.tabs.onUpdated.fire(2,{url:tab(1).url,status:'complete'});
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
});

test('a pending new tab remains eligible after worker restart but only after loading',async()=>{
  const mock=mockChrome([tab(1)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?pending-before-restart');
  mock.tabs.set(2,tab(2,{url:'chrome://newtab/',pendingUrl:tab(1).url,status:'loading'}));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
  await restartWorker(mock,'pending-after-restart');
  Object.assign(mock.tabs.get(2),{url:tab(1).url,status:'complete'});delete mock.tabs.get(2).pendingUrl;
  mock.api.tabs.onUpdated.fire(2,{url:tab(1).url,status:'complete'});
  await mock.request('get-domains');assert.deepEqual([...mock.tabs.keys()],[2]);
});

test('pause persists across worker restart; re-enabling never cleans existing copies',async()=>{
  const mock=mockChrome([tab(1)]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?pause-before-restart');
  assert.equal((await mock.request('set-automatic-duplicates',{enabled:false})).automaticEnabled,false);
  await restartWorker(mock,'pause-after-restart');
  mock.tabs.set(2,tab(2));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  let result=await mock.request('get-domains');assert.equal(result.automaticEnabled,false);assert.equal(mock.tabs.size,2);
  await mock.request('set-automatic-duplicates',{enabled:true});
  mock.api.tabs.onUpdated.fire(2,{status:'complete'});
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
  mock.tabs.set(3,tab(3));mock.api.tabs.onCreated.fire(mock.tabs.get(3));
  result=await mock.request('get-domains');assert.deepEqual([...mock.tabs.keys()],[3]);assert.equal(result.closeLog.length,2);
});

test('startup grace prevents restored tab creation from triggering cleanup',async()=>{
  const mock=mockChrome([tab(1)]);delete mock.session.tabManagerSessionV1;globalThis.chrome=mock.api;
  await import('../tab-manager.js?restore-grace');
  mock.api.runtime.onStartup.fire();await mock.request('get-domains');
  mock.tabs.set(2,tab(2));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  mock.api.tabs.onUpdated.fire(2,{status:'complete'});
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
});

test('expired or discarded creation candidates never cause delayed cleanup',async()=>{
  const mock=mockChrome([tab(1),tab(2,{status:'loading'})]);globalThis.chrome=mock.api;
  mock.session.tabManagerSessionV1.pendingChecks={2:{at:Date.now()-121_000,requestedUrl:tab(1).url}};
  await import('../tab-manager.js?expired-candidate');
  mock.tabs.get(2).status='complete';mock.api.tabs.onUpdated.fire(2,{status:'complete'});
  mock.tabs.set(3,tab(3,{discarded:true}));mock.api.tabs.onCreated.fire(mock.tabs.get(3));
  await mock.request('get-domains');
  mock.tabs.get(3).discarded=false;mock.api.tabs.onUpdated.fire(3,{status:'complete'});
  await mock.request('get-domains');assert.equal(mock.tabs.size,3);
});

test('navigation while recording the close intent cancels the removal',async()=>{
  const mock=mockChrome([tab(1),tab(2)]);globalThis.chrome=mock.api;
  const save=mock.api.storage.session.set;
  mock.api.storage.session.set=async value=>{
    await save(value);
    if(value.tabManagerSessionV1?.closeLog.some(entry=>entry.outcome==='angefordert')) mock.tabs.get(1).url='https://changed.example/';
  };
  await import('../tab-manager.js?log-race');
  assert.equal((await mock.request('deduplicate-tabs')).closed,0);
  assert.equal(mock.tabs.size,2);
  assert.equal((await mock.request('get-domains')).closeLog[0].outcome,'übersprungen');
});

test('2000-tab load burst uses the existing index without full queries or unchanged writes',async()=>{
  const mock=mockChrome(Array.from({length:2000},(_,i)=>tab(i+1,{url:`https://example.org/${i}`})));
  globalThis.chrome=mock.api;await import('../tab-manager.js?indexed-performance');await mock.request('get-domains');
  let queries=0,writes=0;const query=mock.api.tabs.query,save=mock.api.storage.session.set;
  mock.api.tabs.query=async(...args)=>{queries++;return query(...args)};
  mock.api.storage.session.set=async(value)=>{if(value.tabManagerSessionV1)writes++;return save(value)};
  for(let i=1;i<=100;i++)mock.api.tabs.onUpdated.fire(i,{status:'complete'});
  assert.equal((await mock.request('get-domains')).total,2000);
  assert.equal(queries,0);assert.equal(writes,0);
});

test('new YouTube tab with another timestamp replaces the older one without modifying its URL',async()=>{
  const mock=mockChrome([tab(1,{url:'https://www.youtube.com/watch?v=abcdefghijk&t=50'}),tab(3,{url:'https://www.youtube.com/watch?v=abcdefghijk&list=playlist'})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?timestamp-ignore');await mock.request('get-domains');
  const url='https://youtu.be/abcdefghijk?t=200&si=share';mock.tabs.set(2,tab(2,{url}));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  await mock.request('get-domains');assert.deepEqual([...mock.tabs.keys()],[3,2]);assert.equal(mock.tabs.get(2).url,url);
});

test('domain filters and subdomain counts agree with the tabs affected by the action',async()=>{
  const mock=mockChrome([tab(1,{url:'https://example.com/'}),tab(2,{url:'https://a.example.com/'}),tab(3,{url:'https://example.com/',windowId:2}),tab(4,{url:'https://notexample.com/'})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?domain-scope');
  const summary=await mock.request('get-domains',{windowId:1,includeSubdomains:true});assert.equal(summary.total,4);assert.equal(summary.domains.find(d=>d.domain==='example.com').count,2);
  const result=await mock.request('domain-close',{domain:'example.com',windowId:1,includeSubdomains:true});
  assert.equal(result.count,2);assert.deepEqual([...mock.tabs.keys()],[3,4]);
});

test('domain action rechecks navigation after persisting its mutation intent',async()=>{
  const mock=mockChrome([tab(1,{url:'https://example.com/'})]);globalThis.chrome=mock.api;
  const save=mock.api.storage.session.set;
  mock.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))mock.tabs.get(1).url='https://changed.example/';};
  await import('../tab-manager.js?domain-intent-race');
  const result=await mock.request('domain-close',{domain:'example.com'});assert.equal(result.count,0);assert.equal(result.skipped,1);assert.equal(mock.tabs.size,1);
});

test('manual cleanup closes parked and loaded copies of the same video', async () => {
  const video = 'https://www.youtube.com/watch?v=x5IBwQhYUR0';
  const mock = mockChrome([tab(1,{url:video}),tab(2,{url:parked(video)}),tab(3,{url:parked('https://www.youtube.com/shorts/x5IBwQhYUR0?feature=share','Neuer Titel')})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?parked-manual');
  assert.equal((await mock.request('deduplicate-tabs')).closed,2);
  assert.deepEqual([...mock.tabs.keys()],[3]);
});

test('automatic cleanup accepts a normal YouTube navigation redirected to Tab Parker', async () => {
  const video = 'https://www.youtube.com/watch?v=x5IBwQhYUR0';
  const mock = mockChrome([tab(1,{url:parked(video)})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?parked-redirect');await mock.request('get-domains');
  mock.tabs.set(2,tab(2,{url:'chrome://newtab/',pendingUrl:'https://youtu.be/x5IBwQhYUR0?t=30',status:'loading'}));
  mock.api.tabs.onCreated.fire(mock.tabs.get(2));await mock.request('get-domains');
  assert.equal(mock.tabs.size,2);
  Object.assign(mock.tabs.get(2),{url:parked('https://youtu.be/x5IBwQhYUR0?t=30'),status:'complete'});
  delete mock.tabs.get(2).pendingUrl;
  mock.api.tabs.onUpdated.fire(2,{url:mock.tabs.get(2).url,status:'complete'});
  const result=await mock.request('get-domains');
  assert.deepEqual([...mock.tabs.keys()],[2]);
  assert.equal(result.closeLog[0].url,parked(video));
  assert.equal(result.closeLog[0].keptTabId,2);
});

test('concurrent direct parked tabs leave the newest copy and preserve unrelated duplicates', async () => {
  const video = 'https://www.youtube.com/watch?v=x5IBwQhYUR0';
  const mock=mockChrome([tab(1,{url:parked(video)}),tab(2,{url:'https://example.org/'}),tab(3,{url:'https://example.org/'})]);
  globalThis.chrome=mock.api;await import('../tab-manager.js?parked-burst');await mock.request('get-domains');
  for(const id of [90,80,70]) {mock.tabs.set(id,tab(id,{url:parked(video,`Titel ${id}`)}));mock.api.tabs.onCreated.fire(mock.tabs.get(id));}
  await mock.request('get-domains');assert.deepEqual([...mock.tabs.keys()],[2,3,70]);
});

test('a parked tab changed to another video while saving its close log is retained', async () => {
  const video='https://www.youtube.com/watch?v=x5IBwQhYUR0';
  const mock=mockChrome([tab(1,{url:parked(video)}),tab(2,{url:parked(video)})]);globalThis.chrome=mock.api;
  const save=mock.api.storage.session.set;
  mock.api.storage.session.set=async value=>{
    await save(value);
    if(value.tabManagerSessionV1?.closeLog.some(entry=>entry.outcome==='angefordert')) mock.tabs.get(1).url=parked('https://www.youtube.com/watch?v=anotherclip');
  };
  await import('../tab-manager.js?parked-log-race');
  assert.equal((await mock.request('deduplicate-tabs')).closed,0);assert.equal(mock.tabs.size,2);
});

test('a direct parked tab redirected to another video is not eligible for automatic cleanup', async () => {
  const video='https://www.youtube.com/watch?v=x5IBwQhYUR0';
  const mock=mockChrome([tab(1,{url:parked(video)})]);globalThis.chrome=mock.api;
  await import('../tab-manager.js?parked-unrelated-redirect');await mock.request('get-domains');
  mock.tabs.set(2,tab(2,{url:parked('https://www.youtube.com/watch?v=anotherclip'),status:'loading'}));mock.api.tabs.onCreated.fire(mock.tabs.get(2));
  await mock.request('get-domains');
  Object.assign(mock.tabs.get(2),{url:parked(video),status:'complete'});
  mock.api.tabs.onUpdated.fire(2,{url:mock.tabs.get(2).url,status:'complete'});
  await mock.request('get-domains');assert.equal(mock.tabs.size,2);
});
