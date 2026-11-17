import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installInbox} from '../inbox-service.js';
import {inboxCapturePlan} from '../inbox-jobs.js';
import {createTaskService} from '../task-runner.js';
import {memoryStorage,event} from './storage-helper.js';
import {TAB_PARKER_STORE_ID} from '../youtube-url.js';

const video=(id,title='Michael Every interview',extra={})=>({id,url:`https://www.youtube.com/watch?v=video${id}`,
  title,windowId:1,status:'complete',incognito:false,pinned:false,...extra});
const parked=(id,title='Michael Every interview',extra={})=>{
  const tab=video(id,title,extra);
  return {...tab,url:`chrome-extension://${TAB_PARKER_STORE_ID}/parked.html?title=${encodeURIComponent(title)}#${tab.url}`};
};
function fixture(tabs,{metadata=async()=>({title:'YouTube-Video geparkt',channel:'Channel'})}={}) {
  const live=new Map(tabs.map(tab=>[tab.id,{...tab}])),removed=[];
  let metadataCalls=0;
  const api={
    storage:{local:memoryStorage(),session:memoryStorage(),onChanged:event()},
    runtime:{id:'test',getURL:path=>`chrome-extension://test/${path}`,onMessage:event(),sendMessage:async()=>{}},
    alarms:{onAlarm:event(),create:async()=>{},clear:async()=>{}},
    tabs:{query:async()=>[...live.values()].map(tab=>({...tab})),get:async id=>({...live.get(id)}),
      remove:async id=>{removed.push(id);live.delete(id)}},
    windows:{update:async()=>{}},tabGroups:{query:async()=>[]}
  };
  const tasks=createTaskService(api,{schedule:()=>{}});
  const store=installInbox({api,tasks,getMetadata:async record=>{metadataCalls++;return metadata(record,live)},
    selectGroup:async()=>{throw Error('Title capture must not need channel/topic analysis')},decorate:async items=>items});
  const request=(type,payload={})=>new Promise(resolve=>{
    const sender={id:'test',url:api.runtime.getURL('inbox.html'),tab:{id:999}};
    for(const handler of api.runtime.onMessage.listeners)handler({type,...payload},sender,resolve);
  });
  async function finish(taskId) {
    for(let i=0;i<100;i++) {
      await tasks.pump();const task=(await tasks.list()).tasks.find(item=>item.id===taskId);
      if(['done','failed','interrupted','cancelled'].includes(task.status))return task;
    }
    throw Error('Task did not finish');
  }
  return {api,tasks,store,request,finish,live,removed,get metadataCalls(){return metadataCalls}};
}

test('parked title search filters source tabs before deduplication and does not capture unrelated copies',async()=>{
  const f=fixture([
    parked(1,'MICHAËL   Every — outlook',{url:'https://youtu.be/shared'}),
    parked(2,'Different interview',{url:'https://youtu.be/shared'}),
    video(3,'Michael Every live'),parked(4,'Someone else'),
    parked(5,'Michael Every second interview'),
    video(6,'No matching title',{url:'https://youtube.com/watch?v=other&tracking=michael%20every'})
  ]);
  const filters={titleSearch:'  michael every  ',parkedOnly:true};
  const preview=await f.request('inbox-preview',filters);
  assert.equal(preview.ok,true);assert.equal(preview.tabCount,2);assert.equal(preview.videoCount,2);
  assert.deepEqual(preview.videos.map(item=>item.videoId),['shared','video5']);
  assert.ok(preview.videos.every(item=>item.parked&&Object.keys(item).sort().join(',')==='parked,title,videoId'));
  assert.equal(f.metadataCalls,0,'preview reads local titles without metadata analysis');
  const started=await f.request('inbox-capture',{...filters,closeTabs:true});
  const done=await f.finish(started.taskId);
  assert.equal(done.status,'done');assert.equal(done.result.inboxSaved,preview.videoCount);
  assert.deepEqual(f.removed,[1,5]);
  assert.deepEqual([...f.live.keys()],[2,3,4,6]);
  assert.equal((await f.store.get('shared')).title,'MICHAËL Every — outlook','cached generic metadata cannot replace the local title');
  assert.equal((await f.store.get('shared')).channel,'Channel');
});

test('all title matches can include loaded videos while parkedOnly narrows the same selection',async()=>{
  const f=fixture([video(1),parked(2),parked(3,'Another title')]);
  assert.equal((await f.request('inbox-preview',{titleSearch:'MICHAEL every'})).tabCount,2);
  assert.equal((await f.request('inbox-preview',{titleSearch:'MICHAEL every',parkedOnly:true})).tabCount,1);
  const started=await f.request('inbox-capture',{titleSearch:'Michael Every',closeTabs:false});
  const done=await f.finish(started.taskId);
  assert.equal(done.result.inboxSaved,2);assert.deepEqual(f.removed,[]);
});

test('title capture keeps window, private, navigation and exact group scopes',async()=>{
  const tabs=[parked(1),parked(2,undefined,{windowId:2}),parked(3,undefined,{incognito:true}),
    parked(4,undefined,{pendingUrl:'https://youtube.com/watch?v=next'}),parked(5,'Unrelated')];
  const f=fixture(tabs),filters={titleSearch:'michael every',parkedOnly:true,windowId:1};
  assert.equal((await f.request('inbox-preview',filters)).tabCount,1);
  assert.equal((await f.request('inbox-preview',{...filters,includePrivate:true})).tabCount,2);
  let selected=0;
  const plan=await inboxCapturePlan(f.api,{...filters,groupBy:'topic',groupKey:'Michael Every'},async()=>{selected++;return [2]});
  assert.equal(selected,1);assert.equal(plan.tabs.length,0,'group matching never widens the selected window');
});

test('preview samples at most five matching titles, including legacy parked tab titles',async()=>{
  const tabs=Array.from({length:8},(_,i)=>parked(i+1,`Michael Every ${i}`));
  tabs[0].url=tabs[0].url.replace(/\?title=[^#]+/,'');
  const f=fixture(tabs),preview=await f.request('inbox-preview',{titleSearch:'Michael Every',parkedOnly:true});
  assert.equal(preview.videoCount,8);assert.equal(preview.videos.length,5);
  assert.equal(preview.videos[0].title,'Michael Every 0');
});

test('malformed filters are rejected before a capture task can be queued',async()=>{
  const f=fixture([parked(1)]);
  for(const filters of [{titleSearch:1},{titleSearch:null},{titleSearch:'a'.repeat(201)},
    {parkedOnly:1},{parkedOnly:'false'},{parkedOnly:null}]) {
    assert.equal((await f.request('inbox-preview',filters)).ok,false,JSON.stringify(filters));
    assert.equal((await f.request('inbox-capture',filters)).ok,false,JSON.stringify(filters));
  }
  assert.equal((await f.tasks.list()).tasks.length,0);assert.deepEqual(f.removed,[]);
});

test('retitling a loaded source out of the search after saving keeps that tab open',async()=>{
  const f=fixture([video(1),parked(2)],{metadata:async(record,live)=>{
    if(record.tabId===1)live.get(1).title='Something unrelated';
    return {title:record.tabTitle,channel:'Channel'};
  }});
  const started=await f.request('inbox-capture',{titleSearch:'Michael Every',closeTabs:true});
  const done=await f.finish(started.taskId);
  assert.equal(done.status,'done');assert.equal(done.result.inboxSaved,2);
  assert.equal(done.result.skipped,1);assert.deepEqual(f.removed,[2]);assert.ok(f.live.has(1));
});

test('a failed durable write preserves every matching and unrelated source tab',async()=>{
  const f=fixture([parked(1),parked(2,'Unrelated')]);
  f.api.storage.local.set=async()=>{throw Error('QUOTA_BYTES exceeded')};
  const started=await f.request('inbox-capture',{titleSearch:'Michael Every',parkedOnly:true,closeTabs:true});
  const done=await f.finish(started.taskId);
  assert.equal(done.status,'failed');assert.deepEqual(f.removed,[]);assert.equal(f.live.size,2);
});
