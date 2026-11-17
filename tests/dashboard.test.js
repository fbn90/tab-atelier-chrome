import './i18n-helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isTrustedPage,validateWindowId} from '../extension-pages.js';
import {domainGroups,visibleGroups} from '../dashboard-model.js';

test('only exact bundled popup/dashboard pages can send privileged messages',()=>{
  const api={runtime:{id:'ours',getURL:p=>`chrome-extension://ours/${p}`}};
  assert.ok(isTrustedPage({id:'ours',url:api.runtime.getURL('popup.html')},api));
  assert.ok(isTrustedPage({id:'ours',url:api.runtime.getURL('dashboard.html'),tab:{id:7}},api));
  for(const sender of [undefined,{id:'ours',url:'https://youtube.com',tab:{id:7}},
    {id:'other',url:api.runtime.getURL('dashboard.html')},
    {id:'ours',url:api.runtime.getURL('other.html')},
    {id:'ours',url:api.runtime.getURL('dashboard.html.evil')},
    {id:'ours',url:api.runtime.getURL('popup.html'),tab:{id:1}}])assert.equal(isTrustedPage(sender,api),false);
  for(const value of [null,-1,'1',NaN,1.5])assert.throws(()=>validateWindowId(value));
});

test('dashboard search finds video titles without shrinking the group behind its action',()=>{
  const tabs=[{id:1,domain:'youtube.com',title:'Alex Karp interview',url:'https://youtube.com/a'},
    {id:2,domain:'youtube.com',title:'Another video',url:'https://youtube.com/b'},
    {id:3,domain:'example.org',title:'Example',url:'https://example.org'}];
  const map=new Map(tabs.map(t=>[t.id,t])),groups=domainGroups(tabs);
  const found=visibleGroups(groups,map,{search:'KARP'});
  assert.equal(found.length,1);assert.equal(found[0].count,2);assert.deepEqual(found[0].tabIds,[1,2]);
  assert.equal(visibleGroups(groups,map,{minimum:2}).length,1);
  assert.equal(visibleGroups(groups,map,{sort:'name'})[0].label,'example.org');
  assert.equal(visibleGroups(groups,map,{search:'no match'}).length,0);
});


test('Inbox capture links authorize only exact bundled page with bounded known view options',()=>{
  const api={runtime:{id:'ours',getURL:p=>`chrome-extension://ours/${p}`}};
  const valid='inbox.html?titleSearch=Michael+Every&parkedOnly=1&windowId=42';
  assert.equal(isTrustedPage({id:'ours',url:api.runtime.getURL(valid),tab:{id:7}},api),true);
  for(const path of ['inbox.html.evil?titleSearch=x','inbox.html?unknown=x','inbox.html?titleSearch=a&titleSearch=b',
      'inbox.html?titleSearch='+('a'.repeat(201)),'inbox.html?parkedOnly=true','inbox.html?windowId=-1',
      'inbox.html?windowId=9007199254740993','inbox.html?titleSearch=x#other','dashboard.html?titleSearch=x']){
    assert.equal(isTrustedPage({id:'ours',url:api.runtime.getURL(path),tab:{id:7}},api),false,path);
  }
  assert.equal(isTrustedPage({id:'other',url:api.runtime.getURL(valid),tab:{id:7}},api),false);
  assert.equal(isTrustedPage({id:'ours',url:'https://ours/inbox.html?titleSearch=x',tab:{id:7}},api),false);
});
