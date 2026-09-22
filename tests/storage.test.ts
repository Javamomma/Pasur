import test from 'node:test';
import assert from 'node:assert/strict';
import { getStore } from '@netlify/blobs';
import { netlifyRoomStore } from '../server/rooms.ts';
import { newGame } from '../lib/pasur.ts';
// Exercise the real SDK's request headers and response parsing against a provider
// protocol fixture. The official local emulator omits ETags on GET responses.
function fixture(missingReadEtag=false){
 let record:{body:string;etag:string}|null=null,version=0;
 const transport:typeof fetch=async(_url,init)=>{
  const headers=new Headers(init?.headers);
  if(init?.method?.toUpperCase()==='PUT'){
   if(headers.get('if-none-match')==='*'&&record)return new Response(null,{status:412});
   if(headers.has('if-match')&&record?.etag!==headers.get('if-match'))return new Response(null,{status:412});
   record={body:String(init.body),etag:`"version-${++version}"`};
   return new Response(null,{status:200,headers:{etag:record.etag}});
  }
  return record?new Response(record.body,{headers:missingReadEtag?{}:{etag:record.etag}}):new Response(null,{status:404});
 };
 return netlifyRoomStore(getStore({name:'test-rooms',siteID:'local-test-site',token:'test-only',edgeURL:'https://storage.example',uncachedEdgeURL:'https://storage.example',consistency:'strong',fetch:transport}));
}
const game=()=>newGame('ABCDEFGHIJ',2,{goal:62,surLimit:50,cancelSurs:true},'Test','local-key');
test('Real Netlify SDK sends conditional writes and preserves version headers',async()=>{
 const rooms=fixture(),g=game();assert.equal(await rooms.read(g.code),null);
 assert.equal(await rooms.create(g),true);assert.equal(await rooms.create(g),false);
 const original=await rooms.read(g.code);assert.ok(original);
 const change={...g,revision:1,message:'Saved'};
 assert.equal(await rooms.save(change,original.version),true);
 assert.equal(await rooms.save({...change,message:'Must not overwrite'},original.version),false);
 assert.equal((await rooms.read(g.code))?.game.message,'Saved');
});
test('Missing storage version fails closed instead of allowing an unconditional write',async()=>{
 const rooms=fixture(true),g=game();await rooms.create(g);
 await assert.rejects(rooms.read(g.code),/version/);
 await assert.rejects(rooms.save(g,''),/version/);
});
