import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMetadataCache} from '../metadata-cache.js';
import {createTaskService} from '../task-runner.js';
import {runExclusive} from '../action-coordinator.js';
import {parseYouTubeVideo,navigationKey} from '../youtube-url.js';
import {duplicatePairs} from '../tab-rules.js';
import {memoryStorage,event} from './storage-helper.js';

test('YouTube formats share a video key without time marks; other context stays distinct',()=>{
  const urls=['https://www.youtube.com/watch?v=abcdefghijk&t=30','https://youtu.be/abcdefghijk?t=99&si=share','https://youtube.com/shorts/abcdefghijk','https://m.youtube.com/live/abcdefghijk?start=10','https://youtube.com/embed/abcdefghijk#t=2m'];
  for(const url of urls){assert.equal(parseYouTubeVideo(url).videoId,'abcdefghijk');assert.equal(navigationKey(url),'https://www.youtube.com/watch?v=abcdefghijk')}
  assert.notEqual(navigationKey(urls[0]),navigationKey('https://youtube.com/watch?v=abcdefghijk&list=playlist'));
  assert.notEqual(navigationKey(urls[0]),navigationKey('https://youtube.com/watch?v=abcdefghijk#notes'));
  assert.equal(navigationKey('https://other.example/?t=30'),'https://other.example/?t=30');
  for(const bad of ['https://notyoutube.com/watch?v=abcdefghijk','https://studio.youtube.com/watch?v=abcdefghijk','https://youtube.com:1234/watch?v=abcdefghijk','https://youtube.com.evil.test/watch?v=abcdefghijk','https://youtu.be/abcdefghijk/extra','file://youtube.com/watch?v=abcdefghijk','https://youtube.com/playlist?list=x']) assert.equal(parseYouTubeVideo(bad),null);
  assert.equal(duplicatePairs(urls.map((url,i)=>({id:i,url,status:'complete'})),{}).length,4);
});

test('cache is lazy, flushes only changed shards and resumes after worker restart',async()=>{
  const storage=memoryStorage(),cache=createMetadataCache(storage);
  assert.equal(storage.writes.length,0);
  for(let i=0;i<100;i++)await cache.set(`video${i}`,{title:`Title ${i}`,channel:'A'});
  await cache.flush();
  const restarted=createMetadataCache(storage);
  assert.equal((await restarted.get('video25')).title,'Title 25');
  storage.writes.length=0;
  await restarted.set('video25',{title:'Changed',channel:'A'});await restarted.flush();
  assert.equal(storage.writes.length,1);assert.equal(Object.keys(storage.writes[0]).length,1);
  const stats=await restarted.stats();assert.equal(stats.entries,100);assert.ok(stats.memoryShards<=8);
});

test('cache expires metadata, limits size and clear prevents late requests repopulating it',async()=>{
  const storage=memoryStorage(),cache=createMetadataCache(storage);
  const staleRevision=cache.revision;
  for(let i=0;i<4200;i++)await cache.set(`id${i}`,{title:'x'.repeat(1000),channel:'A'});
  await cache.flush();const stats=await cache.stats();
  assert.ok(stats.entries<=4000);assert.ok(stats.bytes<4.3*1024*1024);assert.ok(stats.memoryShards<=8);
  await cache.clear();await cache.set('late',{title:'Late',channel:'A'},staleRevision);await cache.flush();
  assert.equal(await cache.get('late'),null);assert.equal((await cache.stats()).entries,0);
  await cache.set('old',{title:'Old',channel:'A'});await cache.flush();
  for(const [key,values]of Object.entries(storage.data))if(key.startsWith('ytMetadataV2:')&&values.old)values.old.updatedAt=1;
  assert.equal(await createMetadataCache(storage).get('old'),null);
});

test('old unverified metadata is revalidated; storage errors are surfaced',async()=>{
  const storage=memoryStorage({ytVideoMetadataCacheV1:{old:{title:'Old',channel:'A',updatedAt:Date.now()}}});
  const cache=createMetadataCache(storage);assert.equal(await cache.get('old'),null);assert.equal(storage.data.ytVideoMetadataCacheV1,undefined);
  await cache.set('a',{title:'A',channel:'A'});
  storage.set=async()=>{throw Error('Quota exceeded')};
  await assert.rejects(cache.flush(),/Quota/);assert.equal(cache.error,'Quota exceeded');
});

function taskAPI(storage=memoryStorage()) {
  return {storage:{session:storage},runtime:{sendMessage:async()=>{}},alarms:{onAlarm:event(),async create(){},async clear(){}}};
}
const runner=api=>createTaskService(api,{schedule:()=>{}});

test('task checkpoints resume after worker termination without repeating completed chunks',async()=>{
  const api=taskAPI();let service=runner(api);const seen=[];
  const handler=async(job,ctx)=>{seen.push(job.cursor);await ctx.write([job.cursor],`chunk-${job.cursor}`);job.cursor++;job.processed=job.cursor;job.total=3;if(job.cursor===3){job.result={ok:true,count:3};return true;}return false;};
  service.register('work',handler);const {taskId}=await service.start('work');await service.pump();
  assert.equal((await service.list()).tasks[0].processed,1);
  service=runner(api);service.register('work',handler);await service.pump();
  assert.deepEqual((await service.data(taskId,'chunk-1')).value,[1]);
  await service.pump();
  assert.deepEqual(seen,[0,1,2]);assert.equal((await service.list()).tasks[0].status,'done');
  assert.equal((await service.data(taskId,'chunk-1')).value,undefined);
});

test('cancellation is accepted during a running step and prevents its next mutation',async()=>{
  const api=taskAPI(),service=runner(api);let ready,release,effects=0;
  const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
  service.register('slow',async(job,ctx)=>{ready();await gate;await ctx.effect(async()=>effects++);return false;});
  const {taskId}=await service.start('slow');const pumping=service.pump();await started;await service.cancel(taskId);release();await pumping;
  assert.equal(effects,0);assert.equal((await service.list()).tasks[0].status,'cancelled');
});

test('all task steps and automatic tab mutations use the same exclusive queue',async()=>{
  const api=taskAPI(),service=runner(api),order=[];let ready,release;
  const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
  service.register('hold',async()=>{order.push('start');ready();await gate;order.push('end');return true});
  await service.start('hold');const pumping=service.pump();await started;
  const mutation=runExclusive(async()=>order.push('mutation'),api);assert.deepEqual(order,['start']);release();await Promise.all([pumping,mutation]);
  assert.deepEqual(order,['start','end','mutation']);
});

test('uncertain browser mutations are never automatically replayed after termination',async()=>{
  const api=taskAPI(memoryStorage({atelierTasksV1:{tasks:[{id:'uncertain',type:'work',status:'running',inFlight:true,processed:2,total:5}]}}));
  const service=runner(api);let effects=0;service.register('work',async()=>{effects++;return true});await service.pump();
  assert.equal(effects,0);assert.equal((await service.list()).tasks[0].status,'interrupted');
});

test('cancellation arriving during intent persistence stops the browser effect',async()=>{
  const api=taskAPI(),service=runner(api);let taskId,effects=0;
  const original=api.storage.session.set;
  api.storage.session.set=async value=>{
    await original(value);
    if(value.atelierTasksV1?.tasks.some(t=>t.inFlight))await service.cancel(taskId);
  };
  service.register('effect',async(job,ctx)=>{await ctx.effect(async()=>effects++);return false;});
  taskId=(await service.start('effect')).taskId;await service.pump();
  assert.equal(effects,0);assert.equal((await service.list()).tasks[0].status,'cancelled');
});

test('retired transfer tasks and tickets are cleaned before resuming other work',async()=>{
  const storage=memoryStorage({atelierTasksV1:{tasks:[
    {id:'old',type:'onetab-close',status:'queued',keys:['atelierTasksV1:old:data']},
    {id:'inbox',type:'inbox-capture',status:'queued',keys:['atelierTasksV1:inbox:data']}
  ]},atelierTasksV1Cancel:['old'],'atelierTasksV1:old:data':[1],'oneTabTransferV1:old':{url:'fixture'},'atelierTasksV1:inbox:data':['saved']});
  const service=runner(taskAPI(storage));
  let seen;
  service.register('inbox-capture',async(_job,ctx)=>{seen=await ctx.read();return true;});
  await service.resume();
  await service.pump();
  assert.deepEqual(seen,['saved']);
  assert.deepEqual((await service.list()).tasks.map(task=>[task.id,task.status]),[['inbox','done']]);
  assert.equal(storage.data['oneTabTransferV1:old'],undefined);
  assert.equal(storage.data['atelierTasksV1:old:data'],undefined);
});
