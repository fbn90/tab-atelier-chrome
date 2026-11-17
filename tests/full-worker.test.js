import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryStorage,event} from './storage-helper.js';
import {taskService} from '../task-runner.js';
import {TAB_PARKER_STORE_ID} from '../youtube-url.js';

test('real worker entry point routes popup messages and completes an export through the shared task service',async()=>{
  const open=[1,2].map(id=>({id,url:`https://youtube.com/watch?v=video${id}`,title:`Video ${id}`,windowId:1,index:id,discarded:true,status:'complete',pinned:false,incognito:false}));
  const saved=[],alarms=new Map();
  const api={
    runtime:{id:'test',getURL:path=>`chrome-extension://test/${path}`,onMessage:event(),onInstalled:event(),onStartup:event(),sendMessage:async()=>{}},
    tabs:{query:async()=>open.map(t=>({...t})),get:async id=>({...open.find(t=>t.id===id)}),onCreated:event(),onUpdated:event(),onRemoved:event(),onReplaced:event(),onAttached:event()},
    storage:{session:memoryStorage({tabManagerSessionV1:{next:1,order:{},autoGraceUntil:0}}),local:memoryStorage(),onChanged:event()},
    alarms:{onAlarm:event(),create:async(name,value)=>alarms.set(name,value),clear:async name=>alarms.delete(name)},
    action:{setBadgeText:async({text})=>api.badge=text,setTitle:async()=>{},setBadgeBackgroundColor:async()=>{}},
    downloads:{download:async options=>{saved.push(options);return saved.length}}
  };
  globalThis.chrome=api;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({title:'Alex Karp',author_name:'Interviews'})});
  const message=(type,payload={},sender={id:"test",url:api.runtime.getURL("popup.html")})=>new Promise(resolve=>{
    for(const fn of api.runtime.onMessage.listeners)fn({type,...payload},sender,resolve);
  });
  try {
    await import('../background.js?complete-worker');
    let unrelatedReply;
    for(const listener of api.runtime.onMessage.listeners)listener({type:'tab-limit-status'}, {id:'test',url:api.runtime.getURL('tab-limit.html'),tab:{id:902}}, value=>unrelatedReply=value);
    assert.equal(unrelatedReply,undefined,'unrelated listeners must not reject the tab-limit module route');
    api.runtime.onInstalled.fire();
    assert.equal((await message('get-domains')).total,2);assert.equal(api.badge,'2');
    assert.equal((await message('get-group-actions',{groupBy:'topic'})).resolvedTabs,2);
    assert.equal((await message('metadata-cache-stats')).entries,2);
    const dashboard={id:'test',url:api.runtime.getURL('dashboard.html'),tab:{id:900}};
    assert.equal((await message('get-dashboard-tabs',{},dashboard)).tabs.length,2);
    assert.equal((await message('get-dashboard-groups',{windowId:1},dashboard)).channels[0].count,2);
    assert.equal((await message('get-dashboard-groups',{windowId:2},dashboard)).topics.length,0);
    assert.equal((await message('get-dashboard-groups',{windowId:'all'},dashboard)).ok,false);
    assert.equal((await message('get-tasks',{},dashboard)).ok,true);
    assert.equal((await message('get-dashboard-tabs',{}, {id:'test',url:'https://youtube.com',tab:{id:1}})).ok,false);
    let created=0,focused;
    api.windows={update:async id=>{focused=id}};
    api.tabs.create=async({url})=>{created++;const tab={id:900,url,windowId:1,title:'Tab Atelier'};open.push(tab);api.tabs.onCreated.fire(tab);return tab};
    api.tabs.update=async(id,patch)=>Object.assign(open.find(tab=>tab.id===id),patch);
    assert.equal((await message('open-dashboard')).ok,true);
    assert.equal((await message('open-dashboard')).ok,true);
    assert.equal(created,1);assert.equal(focused,1);
    assert.equal((await message('focus-dashboard-tab',{tabId:2},dashboard)).ok,true);
    assert.equal(open.find(tab=>tab.id===2).active,true);
    const {taskId}=await message('export-watch-tabs');assert.ok(taskId);
    for(let i=0;i<20;i++) {
      await taskService(api).pump();
      const task=(await message('get-tasks')).tasks.find(t=>t.id===taskId);
      if(task.status==='done')break;
      await new Promise(r=>setImmediate(r));
    }
    const result=await message('download-export',{taskId});
    assert.equal(result.ok,true);assert.equal(result.count,2);assert.equal(saved.length,1);
    assert.equal((await message('set-automatic-duplicates',{enabled:false})).automaticEnabled,false);
    assert.equal((await message('metadata-cache-clear')).ok,true);
    assert.equal((await message('metadata-cache-stats')).entries,0);
    const inboxSender={id:'test',url:api.runtime.getURL('inbox.html'),tab:{id:901}};
    const imported=await message('inbox-capture',{closeTabs:false},inboxSender);assert.ok(imported.taskId);
    for(let i=0;i<20;i++) {
      await taskService(api).pump();
      const task=(await message('get-tasks',{},inboxSender)).tasks.find(t=>t.id===imported.taskId);
      if(task.status==='done')break;
      assert.notEqual(task.status,'failed',task.error);await new Promise(r=>setImmediate(r));
    }
    const inboxItems=(await message('inbox-list',{},inboxSender)).items;
    assert.equal(inboxItems.length,2);assert.equal(inboxItems[0].topic,'Alex Karp');assert.equal(inboxItems[0].channel,'Interviews');
    await message('metadata-cache-clear');
    assert.equal((await message('inbox-list',{},inboxSender)).items.length,2,'cache clearing must never delete the inbox');
    assert.equal((await message('inbox-set-status',{videoId:'video1',status:'keep'},inboxSender)).item.status,'keep');
    api.windows.get=async id=>({id,type:'normal',incognito:false});
    api.tabs.group=async options=>{
      assert.equal(options.groupId??options.createProperties.windowId,options.groupId?55:1);
      for(const id of options.tabIds)open.find(tab=>tab.id===id).groupId=55;return 55;
    };
    let groupTitle;
    api.tabGroups={query:async()=>[],get:async id=>({id,title:groupTitle,windowId:1}),update:async(_id,patch)=>{groupTitle=patch.title}};
    const batch=await message('inbox-open-batch',{videoIds:['video1','video2'],target:'current',windowId:1,title:'Karp'},inboxSender);assert.ok(batch.taskId);
    let batchTask;
    for(let i=0;i<20;i++) {
      await taskService(api).pump();batchTask=(await message('get-tasks')).tasks.find(t=>t.id===batch.taskId);
      if(batchTask.status==='done')break;
      assert.notEqual(batchTask.status,'failed',batchTask.error);await new Promise(r=>setImmediate(r));
    }
    assert.equal(batchTask.status,'done');assert.equal(batchTask.result.reusedTabs,2);assert.equal(batchTask.result.groupedTabs,2);assert.equal(created,1);
    assert.equal((await message('inbox-set-status-batch',{videoIds:['video1','video2'],status:'done'},inboxSender)).count,2);
    assert.equal((await message('inbox-list',{},inboxSender)).items.filter(item=>item.status==='done').length,2);
    const closed=[];
    api.tabs.remove=async id=>{closed.push(id);open.splice(open.findIndex(tab=>tab.id===id),1);api.tabs.onRemoved.fire(id)};
    const capture=await message('inbox-capture',{},inboxSender);assert.ok(capture.taskId);
    for(let i=0;i<20;i++) {
      await taskService(api).pump();const task=(await message('get-tasks')).tasks.find(t=>t.id===capture.taskId);
      if(task.status==='done'){assert.equal(task.result.closedTabs,2);break}
      assert.notEqual(task.status,'failed',task.error);await new Promise(r=>setImmediate(r));
    }
    assert.deepEqual(closed,[1,2]);assert.equal((await message('inbox-list',{},inboxSender)).items.filter(item=>item.status==='done').length,2);

    let parkedFetches=0,injections=0;
    globalThis.fetch=async()=>{parkedFetches++;throw Error('Parked capture must stay local')};
    api.scripting={executeScript:async()=>{injections++;throw Error('Do not wake parked tabs')}};
    const sources=[['parked001','https://youtu.be/parked001?t=90#t=120','michael every on trade'],
      ['video1','https://youtube.com/shorts/video1','Vorhandenes Video']];
    for(const [i,[id,target,title]] of sources.entries()) {
      const tab={id:i+3,url:`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html?title=${encodeURIComponent(title)}#${target}`,
        title,windowId:1,index:i,discarded:true,status:'complete',pinned:true,incognito:false};
      open.push(tab);api.tabs.onCreated.fire(tab);
    }
    const parkedDashboard=await message('get-dashboard-groups',{},dashboard);
    assert.equal(parkedDashboard.isPartial,false);assert.equal(parkedDashboard.resolvedTabs,2);
    assert.ok(parkedDashboard.topics.some(group=>group.label==='Michael Every'&&group.tabIds.includes(3)));
    assert.equal((await message('inbox-preview',{},inboxSender)).videoCount,2);
    const finishInbox=async payload=>{
      const started=await message('inbox-capture',payload,inboxSender);
      for(let i=0;i<20;i++) {
        await taskService(api).pump();
        const task=(await message('get-tasks',{},inboxSender)).tasks.find(t=>t.id===started.taskId);
        if(task.status==='done')return task;
        assert.notEqual(task.status,'failed',task.error);await new Promise(r=>setImmediate(r));
      }
      assert.fail('Parked Inbox capture did not finish');
    };
    const parkedCapture=await finishInbox({closeTabs:false});assert.equal(parkedCapture.result.inboxSaved,2);
    const parkedItems=(await message('inbox-list',{},inboxSender)).items;
    const localItem=parkedItems.find(item=>item.videoId==='parked001');
    assert.equal(localItem.title,'michael every on trade');assert.equal(localItem.topic,'Michael Every');assert.equal(localItem.openUrl,sources[0][1]);
    assert.equal(localItem.channel,'Unbekannt');assert.equal(localItem.metadataComplete,false);
    const cachedItem=parkedItems.find(item=>item.videoId==='video1');
    assert.equal(cachedItem.channel,'Interviews');assert.equal(cachedItem.metadataComplete,true);assert.equal(cachedItem.status,'done');
    assert.equal(parkedFetches,0);assert.equal(injections,0);assert.equal(created,1);
    assert.equal(open.find(tab=>tab.id===3).discarded,true);
    const parkedClose=await finishInbox({closeTabs:true});assert.equal(parkedClose.result.closedTabs,2);
    assert.deepEqual(closed,[1,2,3,4]);assert.equal(parkedFetches,0);assert.equal(injections,0);

    const groupTabs = [
      {id:11,windowId:1,url:'https://example.com/article',groupId:-1},
      {id:12,windowId:1,url:'https://example.com/archive',groupId:40},
      {id:13,windowId:1,url:'https://example.com/pin',groupId:-1,pinned:true},
      {id:14,windowId:2,url:'https://example.com/other',groupId:-1},
      {id:15,windowId:2,url:'https://unrelated.example/',groupId:-1},
      {id:16,windowId:1,url:'https://example.com/shared',groupId:41}
    ];
    open.push(...groupTabs);
    const nativeGroups = [{id:40,windowId:1,title:'Reading'},{id:41,windowId:1,title:'Shared',shared:true}];
    api.tabGroups = {
      query:async ({windowId})=>nativeGroups.filter(group=>windowId===undefined||group.windowId===windowId),
      update:async (id,patch)=>Object.assign(nativeGroups.find(group=>group.id===id),patch)
    };
    api.tabs.group = async ({tabIds,groupId,createProperties})=>{
      if(groupId===undefined){
        groupId=50;
        nativeGroups.push({id:groupId,windowId:createProperties.windowId});
      }
      for(const id of tabIds){
        const tab=open.find(tab=>tab.id===id);
        assert.equal(tab.windowId,nativeGroups.find(group=>group.id===groupId).windowId);
        tab.groupId=groupId;
      }
      return groupId;
    };
    const grouped = await message('domain-group',{domain:'example.com',title:'Reading'},dashboard);
    assert.deepEqual(grouped,{ok:true,title:'Reading',count:3,skipped:2});
    assert.deepEqual(groupTabs.map(tab=>tab.groupId),[40,40,-1,50,-1,41]);
    assert.equal(nativeGroups.find(group=>group.id===50).title,'Reading');

    const extra={id:17,windowId:3,url:'https://example.com/extra',groupId:-1};
    open.push(extra);
    const rename=api.tabGroups.update;
    api.tabs.group=async ({tabIds,groupId,createProperties})=>{
      if(groupId===undefined){groupId=60;nativeGroups.push({id:groupId,windowId:createProperties.windowId})}
      for(const id of tabIds)open.find(tab=>tab.id===id).groupId=groupId;
      return groupId;
    };
    api.tabGroups.update=async()=>{throw Error('Chrome rename failed')};
    const partial=await message('domain-group',{domain:'example.com',title:'Reading'},dashboard);
    assert.equal(partial.count,4);
    assert.deepEqual(partial.windows.find(result=>result.windowId===3),{windowId:3,count:1,error:'Chrome rename failed'});
    api.tabGroups.update=rename;
    const retried=await message('domain-group',{domain:'example.com',title:'Reading'},dashboard);
    assert.equal(retried.windows,undefined);
    assert.equal(extra.groupId,60);
    assert.equal(nativeGroups.find(group=>group.id===60).title,'Reading');
  } finally {globalThis.fetch=previousFetch;}
});
