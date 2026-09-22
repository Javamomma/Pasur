import assert from 'node:assert/strict';
// @ts-ignore Node runs this TypeScript test directly.
import { options, newGame, startRound, play, claim, count, view } from '../lib/pasur.ts';
assert.deepEqual(options('C6',['D3','H2','S13']),[['D3','H2']]);
assert.deepEqual(options('C11',['D3','H11','S13','C12']),[['D3','H11']]);
assert.equal(options('C12',['D12','H12']).length,2);
assert.equal(count(['C1','C2','C3','C4','C5','C6','C7','D10','S11'],2).total,24);
for(const capacity of [2,4])for(let run=0;run<15;run++){
 const g=newGame('ABCDEFGHIJ',capacity,{goal:62,surLimit:50,cancelSurs:true},'One','key0');
 for(let i=1;i<capacity;i++)g.players.push({name:'Player'+i,key:'key'+i,hand:[]});startRound(g);
 assert.equal(g.pool.some(c=>c.endsWith('11')),false);
 const v=view(g,'key0');assert.ok(!('deck' in v));assert.ok(!JSON.stringify(v).includes('key1'));assert.equal(v.players[1].hand.length,0);
 assert.throws(()=>view(g,'intruder'));
 let n=0;
 while(g.phase==='playing'){
  const all=[...g.deck,...g.pool,...g.players.flatMap(p=>p.hand),...g.captured.flat()];assert.equal(all.length,52);assert.equal(new Set(all).size,52);
  const seat=g.turn;const hand=g.players[seat].hand;const c=hand[n%hand.length];const legal=options(c,g.pool);const before=JSON.stringify(g);
  assert.throws(()=>play(g,(seat+1)%capacity,c,[]));assert.equal(JSON.stringify(g),before);
  play(g,seat,c,legal[0]||[]);n++;assert.ok(n<=48);
 }
 assert.equal(n,48);assert.equal(g.captured.flat().length,52);assert.equal(g.breakdown.reduce((n,b)=>n+b.total,0),20+5*g.surs.reduce((a,b)=>a+b,0));
}
const g=newGame('ABCDEFGHIJ',2,{goal:62,surLimit:50,cancelSurs:true},'One','k');g.players.push({name:'Two',key:'l',hand:[]});startRound(g);g.turn=0;g.players[0].hand=['C6','S9'];g.players[1].hand=['D8'];g.pool=['C3','C2'];g.deck=['D4'];g.surs=[0,1];play(g,0,'C6',['C3','C2']);assert.deepEqual(g.surs,[0,0]);
g.turn=0;g.players[0].hand=['C6','S9'];g.pool=['D3','D2'];g.deck=[];play(g,0,'C6',['D3','D2']);assert.deepEqual(g.surs,[0,0]);
g.turn=0;g.players[0].hand=['C6','S9'];g.pool=['H3','H2'];g.deck=['S4'];g.scores[0]=50;play(g,0,'C6',['H3','H2']);assert.deepEqual(g.surs,[0,0]);
assert.throws(()=>claim(g,0));
console.log('Passed: 30 complete two/four-player rounds, capture rules, score totals, private hands, turn enforcement, sur cancellation, final-deal and 50-point restrictions.');
