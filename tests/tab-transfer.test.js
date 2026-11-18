import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskService} from '../task-runner.js';
import {transferStep} from '../tab-transfer.js';
import {discoverTabParkers} from '../youtube-url.js';
import {memoryStorage,event} from './storage-helper.js';

function fixture({count=25,snapshot,group=true,reuse=false,sourceWindowId,title='Asmongold'}={}) {
  const tabs=new Map((snapshot?.tabs||Array.from({length:count},(_,i)=>({id:i+1,url:`https://example.com/${i+1}`,windowId:1,index:i,pinned:false,incognito:false,groupId:-1}))).map(t=>[t.id,{...t}]));
  const windows=new Map((snapshot?.windows||[{id:1,type:'normal',incognito:false}]).map(w=>[w.id,{...w}]));
  const groups=new Map((snapshot?.groups||[]).map(g=>[g.id,{...g}]));
  let nextWindow=Math.max(10,...windows.keys())+1,nextGroup=Math.max(100,...groups.keys())+1;
  const calls={create:[],move:[],group:[],pin:[],close:[]};
  const storage=memoryStorage(snapshot?.storage);
  const api={storage:{session:storage},runtime:{sendMessage:async()=>{}},alarms:{onAlarm:event(),create:async()=>{},clear:async()=>{}},
    tabs:{
      get:async id=>{if(!tabs.has(id))throw Error('No tab');return {...tabs.get(id)}},
      query:async query=>[...tabs.values()].filter(t=>(query.windowId===undefined||t.windowId===query.windowId)&&(query.groupId===undefined||t.groupId===query.groupId)).map(t=>({...t})),
      remove:async id=>{calls.close.push(id);tabs.delete(id)},
      move:async(id,{windowId})=>{calls.move.push(id);if(!windows.has(windowId))throw Error(`No window with id: ${windowId}`);Object.assign(tabs.get(id),{windowId,groupId:-1});return {...tabs.get(id)}},
      update:async(id,patch)=>{calls.pin.push(id);return Object.assign(tabs.get(id),patch)},
      group:async({tabIds,groupId,createProperties})=>{
        calls.group.push([...tabIds]);
        if(groupId===undefined) {assert.ok(windows.has(createProperties?.windowId),'group must target an explicit existing window');groupId=nextGroup++;groups.set(groupId,{id:groupId,windowId:createProperties.windowId})}
        const target=groups.get(groupId);if(!target)throw Error('No group');
        for(const id of tabIds){assert.equal(tabs.get(id).windowId,target.windowId);tabs.get(id).groupId=groupId}
        return groupId;
      }
    },
    windows:{
      get:async id=>{if(!windows.has(id))throw Error('No window');return {...windows.get(id)}},
      create:async options=>{
        assert.ok(options.tabId);assert.equal(options.url,undefined,'must never recreate a video by URL');
        const id=nextWindow++;calls.create.push(options.tabId);windows.set(id,{id,type:'normal',incognito:options.incognito});
        Object.assign(tabs.get(options.tabId),{windowId:id,groupId:-1});return {...windows.get(id)};
      }
    },
    tabGroups:{query:async()=>[...groups.values()].filter(group=>[...tabs.values()].some(tab=>tab.groupId===group.id)).map(group=>({...group})),get:async id=>{if(!groups.has(id))throw Error('No group');return {...groups.get(id)}},update:async(id,patch)=>Object.assign(groups.get(id),patch)}
  };
  const service=createTaskService(api,{schedule:()=>{}});
  const handler=async(job,ctx)=>{
    if(!job.prepared) {await ctx.write([...tabs.values()].filter(tab=>sourceWindowId===undefined||tab.windowId===sourceWindowId).map(t=>({...t})));job.prepared=true;job.total=tabs.size;}
    return transferStep(job,ctx,await ctx.read(),{api,groupTitle:group?title:null,reuseGroups:reuse,sourceWindowId,matches:(tab,record)=>tab.url===record.url&&!!tab.incognito===!!record.incognito});
  };
  service.register('move-group-to-window',handler);service.register('domain-window',handler);
  return {api,tabs,windows,groups,calls,storage,service,
    capture:()=>structuredClone({tabs:[...tabs.values()],windows:[...windows.values()],groups:[...groups.values()],storage:storage.data}),
    closeWindow(id){windows.delete(id);for(const tab of tabs.values())if(tab.windowId===id)tabs.delete(tab.id);for(const g of groups.values())if(g.windowId===id)groups.delete(g.id)}
  };
}
async function finish(f) {
  for(let i=0;i<100;i++) {
    await f.service.pump();const task=(await f.service.list()).tasks[0];
    if(['done','failed','cancelled','interrupted'].includes(task.status))return task;
  }
  throw Error('Task did not finish');
}

function namedFixture({tabs,groups,sourceWindowId,storage}={}) {
  const all=tabs.map(tab=>({url:`https://youtube.com/watch?v=video${tab.id}`,status:'complete',incognito:false,pinned:false,groupId:-1,index:tab.id,...tab}));
  return fixture({reuse:true,title:'Asmongold TV',sourceWindowId,snapshot:{tabs:all,groups,
    windows:[...new Map(all.map(tab=>[tab.windowId,{id:tab.windowId,type:'normal',incognito:!!tab.incognito}])).values()],storage}});
}

test('channel move reuses a named group, merges another group and closes only confirmed duplicate videos',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1},{id:2,windowId:2,groupId:10},{id:3,windowId:2,groupId:10},
    {id:4,windowId:3,groupId:11,url:'https://youtu.be/video2?t=100'},{id:5,windowId:3,groupId:11,url:'https://notes.example'}],
    groups:[{id:10,windowId:2,title:'Asmongold TV',color:'purple',collapsed:true},{id:11,windowId:3,title:'asmongoldTV'}]});
  await f.service.start('move-group-to-window');const task=await finish(f);
  assert.equal(task.status,'done');assert.equal(f.calls.create.length,0);assert.deepEqual(f.calls.close,[4]);assert.equal(task.result.duplicatesClosed,1);
  for(const tab of f.tabs.values()){assert.equal(tab.windowId,2);assert.equal(tab.groupId,10)}
  assert.equal(f.groups.get(10).color,'purple');assert.equal(f.groups.get(10).collapsed,true);
});

test('window filter limits additional source groups while reusing a destination in another window',async()=>{
  const f=namedFixture({sourceWindowId:1,tabs:[{id:1,windowId:1},{id:2,windowId:2,groupId:10},{id:3,windowId:2,groupId:10},{id:4,windowId:3,groupId:11}],
    groups:[{id:10,windowId:2,title:'Asmongold TV'},{id:11,windowId:3,title:'AsmongoldTV'}]});
  await f.service.start('move-group-to-window');const task=await finish(f);assert.equal(task.status,'done');assert.equal(f.tabs.get(1).groupId,10);assert.equal(f.tabs.get(4).groupId,11);assert.equal(f.tabs.get(4).windowId,3);
});

test('pinned source videos are preserved even if the destination already contains the video',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1,pinned:true,url:'https://youtube.com/watch?v=shared'},{id:2,windowId:2,groupId:10,url:'https://youtube.com/watch?v=shared'}],groups:[{id:10,windowId:2,title:'Asmongold TV'}]});
  await f.service.start('move-group-to-window');const task=await finish(f);assert.equal(task.status,'done');assert.equal(f.tabs.size,2);assert.equal(f.tabs.get(1).pinned,true);assert.equal(f.calls.close.length,0);
});

test('changing the keeper before duplicate removal preserves both tabs',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1,url:'https://youtube.com/watch?v=shared'},{id:2,windowId:2,groupId:10,url:'https://youtube.com/watch?v=shared'}],groups:[{id:10,windowId:2,title:'Asmongold TV'}]});
  const save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(task=>task.inFlight&&task.transfer?.stage==='group'))f.tabs.get(2).url='https://other.example'};
  await f.service.start('move-group-to-window');await finish(f);assert.equal(f.calls.close.length,0);assert.equal(f.tabs.size,2);
});

test('navigation during the final group check cannot close the only remaining copy of a video',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1,url:'https://youtube.com/watch?v=shared'},{id:2,windowId:2,groupId:10,url:'https://youtube.com/watch?v=shared'}],groups:[{id:10,windowId:2,title:'Asmongold TV'}]});
  const get=f.api.tabGroups.get;let changed=false;
  f.api.tabGroups.get=async id=>{
    const group=await get(id);
    if(f.storage.data.atelierTasksV1?.tasks.some(task=>task.inFlight&&task.transfer?.stage==='group'&&task.transfer.groupPending?.tabId===1)){changed=true;f.tabs.get(2).url='https://other.example'}
    return group;
  };
  await f.service.start('move-group-to-window');await finish(f);assert.ok(changed);assert.equal(f.calls.close.length,0);assert.equal(f.tabs.get(1).url,'https://youtube.com/watch?v=shared');
});

test('worker interruption after duplicate removal never removes the keeper on resume',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1,url:'https://youtube.com/watch?v=shared'},{id:2,windowId:2,groupId:10,url:'https://youtube.com/watch?v=shared'}],groups:[{id:10,windowId:2,title:'Asmongold TV'}]});
  let snapshot;const remove=f.api.tabs.remove;f.api.tabs.remove=async id=>{await remove(id);snapshot=f.capture()};
  await f.service.start('move-group-to-window');await finish(f);assert.ok(snapshot);
  const resumed=fixture({snapshot,reuse:true,title:'Asmongold TV'}),task=await finish(resumed);
  assert.equal(task.status,'done');assert.equal(resumed.tabs.size,1);assert.ok(resumed.tabs.has(2));assert.equal(resumed.calls.close.length,0);assert.equal(resumed.calls.create.length,0);
});

test('existing duplicates inside a single destination group reduce to one confirmed video tab',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:2,groupId:10,url:'https://youtube.com/watch?v=shared&t=10'},
    {id:2,windowId:2,groupId:10,url:'https://youtu.be/shared?t=30'}],groups:[{id:10,windowId:2,title:'Asmongold TV'}]});
  await f.service.start('move-group-to-window');const task=await finish(f);assert.equal(task.status,'done');assert.equal(f.calls.create.length,0);assert.deepEqual(f.calls.move,[]);assert.deepEqual(f.calls.close,[2]);assert.ok(f.tabs.has(1));
});

test('normal and private channel groups remain separate and each keeps its existing duplicate',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1,url:'https://youtube.com/watch?v=shared'},{id:2,windowId:2,groupId:10,url:'https://youtube.com/watch?v=shared'},
    {id:3,windowId:3,incognito:true,url:'https://youtube.com/watch?v=shared'},{id:4,windowId:4,incognito:true,groupId:11,url:'https://youtube.com/watch?v=shared'}],
    groups:[{id:10,windowId:2,title:'Asmongold TV'},{id:11,windowId:4,title:'AsmongoldTV'}]});
  await f.service.start('move-group-to-window');const task=await finish(f);assert.equal(task.status,'done');assert.equal(task.result.duplicatesClosed,2);assert.ok(f.tabs.has(2));assert.ok(f.tabs.has(4));assert.equal(f.tabs.size,2);assert.equal(f.tabs.get(4).windowId,4);
});

test('a source regrouped by the user during intent persistence stays in that group',async()=>{
  const f=namedFixture({tabs:[{id:1,windowId:1,groupId:11},{id:2,windowId:2,groupId:10},{id:3,windowId:2,groupId:10}],
    groups:[{id:10,windowId:2,title:'Asmongold TV'},{id:11,windowId:1,title:'AsmongoldTV'},{id:12,windowId:1,title:'Manual group'}]});
  const save=f.api.storage.session.set;
  f.api.storage.session.set=async value=>{await save(value);if(value.atelierTasksV1?.tasks.some(task=>task.inFlight&&task.transfer?.pending?.tabId===1))f.tabs.get(1).groupId=12};
  await f.service.start('move-group-to-window');const task=await finish(f);assert.equal(task.status,'done');assert.equal(f.tabs.get(1).groupId,12);assert.equal(f.tabs.get(1).windowId,1);assert.equal(f.calls.close.length,0);
});

test('50 existing tabs move once without reopening or closing any URL; grouping follows all moves',async()=>{
  const f=fixture({count:50});let groupsStarted=false;
  const group=f.api.tabs.group;
  f.api.tabs.group=async options=>{groupsStarted=true;assert.equal(f.calls.move.length,49);return group(options)};
  await f.service.start('move-group-to-window');const done=await finish(f);
  assert.equal(done.status,'done');assert.equal(done.result.movedTabs,50);assert.equal(done.result.groupedTabs,50);
  assert.equal(f.tabs.size,50);assert.equal(f.calls.create.length,1);assert.equal(new Set(f.calls.move).size,49);assert.ok(groupsStarted);
});

test('a closed destination between chunks is replaced only for the remaining tabs',async()=>{
  const f=fixture();await f.service.start('move-group-to-window');await f.service.pump();
  const destination=f.tabs.get(1).windowId;f.closeWindow(destination);
  const done=await finish(f);assert.equal(done.status,'done');assert.equal(f.tabs.size,15);
  for(let id=1;id<=10;id++)assert.equal(f.tabs.has(id),false);
  assert.equal(new Set([...f.tabs.values()].map(t=>t.windowId)).size,1);
  assert.equal(done.result.windowsCreated,2);assert.ok(done.result.warningCount>0);
});

test('a destination disappearing during move leaves the source tab intact and retries safely',async()=>{
  const f=fixture({count:3});const move=f.api.tabs.move;let once=true;
  f.api.tabs.move=async(id,options)=>{if(once){once=false;f.closeWindow(options.windowId);throw Error('No window with id: 11')}return move(id,options)};
  await f.service.start('move-group-to-window');const done=await finish(f);
  assert.equal(done.status,'done');assert.equal(f.tabs.has(1),false);assert.ok(f.tabs.has(2));assert.ok(f.tabs.has(3));assert.equal(f.calls.create.length,2);
});

for(const operation of ['create-before','create-after','move-after','pin-after','group-after']) {
  test(`worker interruption at ${operation} reconciles actual Chrome state without duplicate moves/groups`,async()=>{
    const f=fixture({count:3});let snapshot;
    if(operation==='pin-after') {
      f.tabs.get(1).pinned=true;
      const create=f.api.windows.create;f.api.windows.create=async options=>{const win=await create(options);f.tabs.get(options.tabId).pinned=false;return win};
    }
    const [method,timing]=operation.split('-');
    const owner=method==='create'?f.api.windows:f.api.tabs;
    const key=method==='pin'?'update':method;
    const original=owner[key];
    owner[key]=async(...args)=>{
      if(timing==='before'&&!snapshot)snapshot=f.capture();
      const value=await original(...args);
      if(timing==='after'&&!snapshot)snapshot=f.capture();
      return value;
    };
    await f.service.start('move-group-to-window');await finish(f);assert.ok(snapshot);
    const resumed=fixture({snapshot});const done=await finish(resumed);
    assert.equal(done.status,'done');assert.equal(done.result.movedTabs,3);assert.equal(resumed.tabs.size,3);
    if(operation==='create-after')assert.equal(resumed.calls.create.length,0);
    if(operation==='move-after')assert.equal(resumed.calls.move.includes(2),false);
    if(operation==='group-after')assert.equal(resumed.calls.group.some(ids=>ids.includes(1)),false);
    if(operation==='pin-after')assert.equal(resumed.calls.pin.includes(1),false);
  });
}

test('a grouping failure reports a warning and does not invalidate or repeat successful moves',async()=>{
  const f=fixture({count:4});f.api.tabs.group=async()=>{throw Error('Group failed')};
  await f.service.start('move-group-to-window');const done=await finish(f);
  assert.equal(done.status,'done');assert.equal(done.result.movedTabs,4);assert.equal(done.result.groupedTabs,0);assert.equal(done.result.warningCount,4);
  assert.equal(f.calls.create.length,1);assert.equal(f.calls.move.length,3);assert.equal(done.errors[0].stage,'group');
});

test('a genuine move error retains its snapshot and Fortsetzen continues only outstanding tabs',async()=>{
  const f=fixture({count:5});const move=f.api.tabs.move;
  f.api.tabs.move=async()=>{throw Error('Tabs cannot be edited right now')};
  const {taskId}=await f.service.start('domain-window');let task=await finish(f);
  assert.equal(task.status,'failed');assert.equal(task.canResume,true);assert.equal(task.result.movedTabs,1);
  assert.equal((await f.service.data(taskId)).value.length,5);
  f.api.tabs.move=move;await f.service.retry(taskId);task=await finish(f);
  assert.equal(task.status,'done');assert.equal(task.result.movedTabs,5);assert.equal(f.calls.create.length,1);assert.equal(f.calls.move.includes(1),false);
  assert.equal((await f.service.data(taskId)).value,undefined);
});

test('a manually relocated pending tab is never pulled back into the operation on resume',async()=>{
  const f=fixture({count:3});let snapshot;
  const move=f.api.tabs.move;f.api.tabs.move=async(...args)=>{snapshot??=f.capture();return move(...args)};
  await f.service.start('move-group-to-window');await finish(f);
  snapshot.windows.push({id:99,type:'normal',incognito:false});snapshot.tabs.find(t=>t.id===2).windowId=99;
  const resumed=fixture({snapshot});const done=await finish(resumed);
  assert.equal(done.status,'done');assert.equal(resumed.tabs.get(2).windowId,99);assert.equal(resumed.calls.move.includes(2),false);assert.equal(done.result.skipped,1);
});

test('cancellation after the move checkpoint prevents subsequent pin/group mutations',async()=>{
  const f=fixture({count:3});const {taskId}=await f.service.start('move-group-to-window');
  await f.service.pump();assert.equal(f.calls.move.length,2);
  await f.service.cancel(taskId);const done=await finish(f);
  assert.equal(done.status,'cancelled');assert.equal(f.calls.group.length,0);assert.equal(f.tabs.size,3);
});

test('a URL changed during persisted move intent is skipped before touching Chrome windows',async()=>{
  const f=fixture({count:2});const save=f.storage.set;let once=true;
  f.storage.set=async value=>{await save(value);if(once&&value.atelierTasksV1?.tasks.some(t=>t.inFlight)){once=false;f.tabs.get(1).url='https://different.example'}};
  await f.service.start('domain-window');const done=await finish(f);
  assert.equal(done.status,'done');assert.equal(done.result.movedTabs,1);assert.equal(done.result.skipped,1);
  assert.equal(f.tabs.get(1).windowId,1);assert.deepEqual(f.calls.create,[2]);
});

test('an ambiguous create interruption never adopts an unrelated multi-tab window',async()=>{
  const f=fixture({count:3});let snapshot;const create=f.api.windows.create;
  f.api.windows.create=async options=>{snapshot??=f.capture();return create(options)};
  await f.service.start('move-group-to-window');await finish(f);
  snapshot.windows.push({id:99,type:'normal',incognito:false});
  snapshot.tabs.find(t=>t.id===1).windowId=99;
  snapshot.tabs.push({id:999,url:'https://unrelated.example',windowId:99,incognito:false,pinned:false});
  const resumed=fixture({snapshot});const done=await finish(resumed);
  assert.equal(done.status,'done');assert.equal(resumed.tabs.get(1).windowId,99);assert.equal(resumed.tabs.get(999).windowId,99);
  assert.equal(done.result.movedTabs,2);assert.equal(done.result.skipped,1);
});

test('an unverified Parker page in the target group cannot get a real video closed as its duplicate',async()=>{
  // Discovery (display only) registers the impostor; it must still not act as a duplicate keeper.
  const fake='dddddddddddddddddddddddddddddddd';
  const parked=`chrome-extension://${fake}/parked.html#https://www.youtube.com/watch?v=video2`;
  assert.ok(await discoverTabParkers({runtime:{sendMessage:async id=>({app:'youtube-tab-parker',protocol:1,id,version:'1.0.0'})}},[{url:parked}]));
  const f=namedFixture({tabs:[{id:2,windowId:2,groupId:10,url:parked},{id:4,windowId:3,groupId:11,url:'https://youtu.be/video2?t=100'}],
    groups:[{id:10,windowId:2,title:'Asmongold TV'},{id:11,windowId:3,title:'asmongoldTV'}]});
  await f.service.start('move-group-to-window');const task=await finish(f);
  assert.equal(task.status,'done');assert.deepEqual(f.calls.close,[]);assert.equal(task.result.duplicatesClosed,0);assert.ok(f.tabs.has(4));
});
