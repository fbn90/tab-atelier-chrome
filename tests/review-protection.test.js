import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryStorage} from './storage-helper.js';
import {reviewPage,reviewProtection,saveReview} from '../inbox-review-protection.js';

test('restored protection follows the actual marker group and only its confirmed video IDs',async()=>{
  const api={runtime:{getURL:page=>'chrome-extension://fixture/'+page},storage:{local:memoryStorage()}};
  const id='e0ddfd46-3342-48e4-a73c-390b0e33a839';
  await saveReview(api,id,{active:true,bypass:true,members:['lex1'],pending:{markerId:901,videoId:'lex3',create:true,before:[]}});
  const clip=(id,name,groupId=456,windowId=90)=>({id,groupId,windowId,url:'https://www.youtube.com/watch?v='+name});
  const marker={id:9000,windowId:90,groupId:456,url:reviewPage(api,id)};
  const inventory=[marker,clip(100,'lex1'),clip(101,'lex2'),clip(102,'lex1',999),clip(103,'lex1',456,91),clip(104,'lex3',-1)];
  const result=await reviewProtection(api,inventory);
  assert.deepEqual([...result.protectedTabs],[100]);
  assert.deepEqual([...result.admitted],[9000,100]);
  const ambiguous=await reviewProtection(api,[...inventory,{...marker,id:9001,windowId:21}]);
  assert.equal(ambiguous.protectedTabs.size,0);
  const moved=await reviewProtection(api,[marker,{...inventory[1],groupId:-1}]);
  assert.equal(moved.protectedTabs.size,0);
});
