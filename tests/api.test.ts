import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameHandler } from '../server/game-api.ts';
import type { RoomStore } from '../server/rooms.ts';
import { options, type Game, type GameView } from '../lib/pasur.ts';
function memoryRooms():RoomStore {
  const rows=new Map<string,{game:Game;version:string}>();
  let serial=0;
  return {
    async read(code){return structuredClone(rows.get(code)||null)},
    async create(game){if(rows.has(game.code))return false;rows.set(game.code,{game:structuredClone(game),version:String(++serial)});return true;},
    async save(game,version){if(rows.get(game.code)?.version!==version)return false;rows.set(game.code,{game:structuredClone(game),version:String(++serial)});return true;},
  };
}
function client(handler:ReturnType<typeof createGameHandler>) {
 let cookie='';
 return {async send(body:Record<string,unknown>,origin='https://pasur.example'){
   const response=await handler(new Request('https://pasur.example/api/game',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}));
   if(response.headers.has('set-cookie')){cookie=response.headers.get('set-cookie')!.split(';')[0];assert.match(response.headers.get('set-cookie')!,/HttpOnly/);assert.match(response.headers.get('set-cookie')!,/Secure/);}
   return {status:response.status,data:await response.json() as GameView & {error:string}};
 },async read(code:string){const response=await handler(new Request('https://pasur.example/api/game?code='+code,{headers:{Cookie:cookie}}));return {status:response.status,data:await response.json() as GameView & {error:string}};}};
}
for(const capacity of [2,4])test(`${capacity}-player API round, permissions, privacy and reconnect`,async()=>{
 const handler=createGameHandler(memoryRooms());const clients=Array.from({length:capacity},()=>client(handler));
 let r=await clients[0].send({action:'create',name:'Host',capacity});assert.equal(r.status,200);const code=r.data.code;
 assert.equal((await client(handler).read(code)).status,403);
 for(let i=1;i<capacity;i++){r=await clients[i].send({action:'join',name:'Player '+i,code});assert.equal(r.status,200);}
 assert.equal((await clients[1].send({action:'start',code,revision:r.data.revision})).status,403);
 r=await clients[0].send({action:'start',code,revision:r.data.revision});assert.equal(r.status,200);
 const rejoin=await clients[1].send({action:'join',code,name:'Changed'});assert.equal(rejoin.status,200);assert.equal(rejoin.data.players[1].name,'Player 1');
 let moves=0;
 while(r.data.phase==='playing'){
   const g=r.data;const actor=g.turn;const state=(await clients[actor].read(code)).data;
   for(let i=0;i<capacity;i++){if(i!==actor)assert.deepEqual(state.players[i].hand,[]);assert.ok(!('key' in state.players[i]));}assert.ok(!('deck' in state));
   const card=state.players[actor].hand[0],take=options(card,state.pool)[0]||[];
   const forbidden=await clients[(actor+1)%capacity].send({action:'play',code,card,take,revision:state.revision});assert.equal(forbidden.status,400);
   const stale=await clients[actor].send({action:'play',code,card,take,revision:state.revision-1});assert.equal(stale.status,409);
   r=await clients[actor].send({action:'play',code,card,take,revision:state.revision});assert.equal(r.status,200);moves++;
 }
 assert.equal(moves,48);assert.equal(r.data.phase,'round');assert.equal(r.data.breakdown.reduce((n,b)=>n+b.total,0),20+r.data.surs.reduce((n,s)=>n+5*s,0));
 const reconnect=await clients[0].read(code);assert.deepEqual(reconnect.data.scores,r.data.scores);
});
test('Concurrent joins cannot occupy the same seat or overwrite each other',async()=>{
 const store=memoryRooms();let reads=0;let release!:()=>void;const barrier=new Promise<void>(r=>{release=r});const read=store.read;store.read=async code=>{const snapshot=await read(code);reads++;if(reads===2)release();if(reads<=2)await barrier;return snapshot;};const handler=createGameHandler(store);const host=client(handler);const {data:g}=await host.send({action:'create',name:'Host',capacity:2});
 const results=await Promise.all([client(handler).send({action:'join',name:'A',code:g.code}),client(handler).send({action:'join',name:'B',code:g.code})]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
 assert.equal((await host.read(g.code)).data.players.length,2);
});
test('CSRF, invalid input, unsupported methods and storage errors fail safely',async()=>{
 const h=createGameHandler(memoryRooms()),c=client(h);
 assert.equal((await c.send({action:'create',name:'Host'},'https://evil.example')).status,403);
 assert.equal((await c.send({action:'create',name:''})).status,400);
 assert.equal((await h(new Request('https://pasur.example/api/game',{method:'DELETE'}))).status,405);
 const malformed=await h(new Request('https://pasur.example/api/game',{method:'POST',headers:{Origin:'https://pasur.example'},body:'null'}));assert.equal(malformed.status,400);
 const broken=createGameHandler({read:async()=>{throw Error('secret details')},create:async()=>{throw Error('secret details')},save:async()=>{throw Error('secret details')}});
 const unavailable=await client(broken).send({action:'create',name:'Host'});assert.equal(unavailable.status,503);assert.ok(!unavailable.data.error.includes('secret'));
});
