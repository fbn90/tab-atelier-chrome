import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {installParkerUpdate,UPDATE_JOURNAL} from '../parker-update.js';
import {memoryStorage,event} from './storage-helper.js';
const parked='chrome-extension://bhnabphdcdknjeebnmeikbdcncnfhdpf/parked.html?title=Michael+Every#https://youtube.com/watch?v=hold';
function fixture(extra={}){
 const tab={id:1,url:parked,windowId:2,index:3,pinned:true,groupId:42,status:'complete',...extra};
 const storage=memoryStorage(),changes=[];
 const api={runtime:{id:'ours',sendMessage:async id=>({app:'youtube-tab-parker',protocol:1,id,version:'1.3.8'}),getURL:p=>'chrome-extension://ours/'+p,onMessage:event()},storage:{local:storage},tabs:{query:async()=>[tab],get:async()=>({...tab}),update:async(id,patch)=>{assert.ok((await storage.get(UPDATE_JOURNAL))[UPDATE_JOURNAL].length,'journal must be durable before navigation');changes.push(patch);Object.assign(tab,patch);return {...tab}}}};
 installParkerUpdate(api);
 const send=(type,sender={id:'ours',url:api.runtime.getURL('inbox.html'),tab:{id:10}},patch={})=>new Promise(resolve=>api.runtime.onMessage.listeners[0]({type,...patch},sender,resolve));
 return {tab,storage,changes,send,api};
}
test('Parker update preserves tab ID, position, pin and group and journals original before holding',async()=>{
 const f=fixture();const start=await f.send('parker-update-prepare');assert.equal(start.held,1);assert.equal(f.tab.groupId,42);assert.equal(f.tab.index,3);assert.equal(f.tab.pinned,true);assert.ok(f.tab.url.startsWith(f.api.runtime.getURL('update-hold.html')));
 const done=await f.send('parker-update-restore');assert.equal(done.restored,1);assert.equal(f.tab.url,parked);assert.equal(f.tab.id,1);assert.equal((await f.send('parker-update-status')).pending,0);
});
test('update restore respects user navigation and retains pending restorations for retry',async()=>{
 const f=fixture();await f.send('parker-update-prepare');f.tab.pendingUrl='https://example.org';assert.equal((await f.send('parker-update-restore')).pending,1);
 delete f.tab.pendingUrl;f.tab.url='https://example.org';const done=await f.send('parker-update-restore');assert.equal(done.skipped,1);assert.equal(f.tab.url,'https://example.org');
});
test('private links and untrusted senders never enter the update journal',async()=>{
 const f=fixture({incognito:true});assert.equal((await f.send('parker-update-prepare')).ok,false);assert.equal(f.changes.length,0);
 const result=await f.send('parker-update-prepare',{id:'foreign',url:f.api.runtime.getURL('inbox.html')});assert.equal(result.ok,false);
 assert.equal((await f.storage.get(UPDATE_JOURNAL))[UPDATE_JOURNAL],undefined);
});

test('failed holds can be retried and unavailable Parker leaves the journal intact',async()=>{
 const f=fixture(),update=f.api.tabs.update,identify=f.api.runtime.sendMessage;
 f.api.tabs.update=async()=>{throw Error('Chrome temporarily refused navigation')};
 const partial=await f.send('parker-update-prepare');
 assert.equal(partial.held,0);assert.equal(partial.preparable,1);assert.equal(partial.pending,1);
 f.api.tabs.update=update;
 assert.equal((await f.send('parker-update-prepare',undefined,{tabId:1})).held,1);
 f.api.runtime.sendMessage=async()=>{throw Error('Parker disabled')};
 const unavailable=await f.send('parker-update-restore');
 assert.equal(unavailable.restored,0);assert.equal(unavailable.pending,1);
 f.api.runtime.sendMessage=identify;
 assert.equal((await f.send('parker-update-restore',undefined,{tabId:1})).restored,1);
});
