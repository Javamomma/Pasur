export type Card = string;
export type Rules = { goal: number; surLimit: number; cancelSurs: boolean };
export type Player = { name: string; key: string; hand: Card[] };
export type Breakdown = { clubs: number; clubPoints: number; aces: number; jacks: number; twoClubs: number; tenDiamonds: number; surs: number; total: number };
export type Game = { code: string; capacity: number; players: Player[]; phase: 'lobby'|'playing'|'round'|'finished'; rules: Rules; deck: Card[]; pool: Card[]; captured: Card[][]; surs: number[]; scores: number[]; dealer: number; turn: number; lastCapture: number; round: number; deal: number; revision: number; message: string; breakdown: Breakdown[]; winner: number|null };
export const rank = (c: Card) => Number(c.slice(1));
export const suitSymbols: Record<string,string> = { C:'♣', D:'♦', H:'♥', S:'♠' };
export const label = (c: Card) => `${({1:'A',11:'J',12:'Q',13:'K'} as Record<number,string>)[rank(c)] || rank(c)}${suitSymbols[c[0]]}`;
export const team = (seat: number) => seat % 2;
export function shuffled() {
  const d = ['C','D','H','S'].flatMap(s=>Array.from({length:13},(_,i)=>s+(i+1)));
  for(let i=d.length-1;i>0;i--){ const limit=Math.floor(4294967296/(i+1))*(i+1);let n:number;do{n=crypto.getRandomValues(new Uint32Array(1))[0]}while(n>=limit);const j=n%(i+1);[d[i],d[j]]=[d[j],d[i]]; }return d;
}
export function options(card: Card, pool: Card[]): Card[][] {
  const r=rank(card);
  if(r===11){const a=pool.filter(c=>rank(c)<=11);return a.length?[a]:[];}
  if(r>=12)return pool.filter(c=>rank(c)===r).map(c=>[c]);
  const result:Card[][]=[];const numbers=pool.filter(c=>rank(c)<=10);
  function visit(start:number,left:number,picked:Card[]){if(left===0){result.push(picked);return}for(let i=start;i<numbers.length;i++){const v=rank(numbers[i]);if(v<=left)visit(i+1,left-v,[...picked,numbers[i]]);}}
  visit(0,11-r,[]);return result;
}
export function newGame(code:string,capacity:number,rules:Rules,name:string,key:string):Game{return {code,capacity,rules,players:[{name,key,hand:[]}],phase:'lobby',deck:[],pool:[],captured:[[],[]],surs:[0,0],scores:[0,0],dealer:0,turn:1,lastCapture:-1,round:0,deal:0,revision:0,message:'Waiting for family to join.',breakdown:[],winner:null};}
function dealHands(g:Game){for(let step=1;step<=g.capacity;step++){g.players[(g.dealer+step)%g.capacity].hand=g.deck.splice(0,4);}g.deal++;}
export function startRound(g:Game){if(g.players.length!==g.capacity)throw Error('Wait until every seat is filled.');if(g.phase!=='lobby'&&g.phase!=='round')throw Error('This round has already started.');if(g.phase==='round')g.dealer=(g.dealer+1)%g.capacity;g.round++;g.captured=[[],[]];g.surs=[0,0];g.lastCapture=-1;g.breakdown=[];g.winner=null;
  for(;;){g.deck=shuffled();g.deal=0;dealHands(g);g.pool=g.deck.splice(0,4);if(g.pool.filter(c=>rank(c)===11).length>1||g.pool.filter(c=>rank(c)===12).length>2||g.pool.filter(c=>rank(c)===13).length>2)continue;while(g.pool.some(c=>rank(c)===11)){const i=g.pool.findIndex(c=>rank(c)===11);g.deck.push(g.pool[i]);g.pool[i]=g.deck.shift()!;}break;}
  g.turn=(g.dealer+1)%g.capacity;g.phase='playing';g.message=`Round ${g.round}. ${g.players[g.turn].name} starts.`;
}
export function count(cards:Card[],surs:number):Breakdown{const clubs=cards.filter(c=>c[0]==='C').length,clubPoints=clubs>=7?7:0,aces=cards.filter(c=>rank(c)===1).length,jacks=cards.filter(c=>rank(c)===11).length,twoClubs=cards.includes('C2')?2:0,tenDiamonds=cards.includes('D10')?3:0;return {clubs,clubPoints,aces,jacks,twoClubs,tenDiamonds,surs,total:clubPoints+aces+jacks+twoClubs+tenDiamonds+surs*5};}
function finish(g:Game){g.breakdown=g.captured.map((c,i)=>count(c,g.surs[i]));g.scores=g.scores.map((n,i)=>n+g.breakdown[i].total);const hi=Math.max(...g.scores);g.winner=hi>=g.rules.goal&&g.scores[0]!==g.scores[1]?(g.scores[0]>g.scores[1]?0:1):null;g.phase=g.winner===null?'round':'finished';}
export function play(g:Game,seat:number,card:Card,take:Card[]){if(g.phase!=='playing'||g.turn!==seat)throw Error('Wait for your turn.');if(!g.players[seat].hand.includes(card))throw Error('Choose a card from your hand.');if(new Set(take).size!==take.length)throw Error('Choose each table card only once.');const legal=options(card,g.pool);const key=(a:Card[])=>[...a].sort().join(',');if(legal.length?!legal.some(a=>key(a)===key(take)):take.length>0)throw Error(legal.length?'Select a valid capture. A capture is required for this card.':'This card cannot capture those cards.');
  g.players[seat].hand=g.players[seat].hand.filter(c=>c!==card);let sur='';if(take.length){g.pool=g.pool.filter(c=>!take.includes(c));g.captured[team(seat)].push(card,...take);g.lastCapture=seat;if(!g.pool.length&&rank(card)!==11&&g.deck.length>0&&g.scores[team(seat)]<g.rules.surLimit){const t=team(seat);if(g.rules.cancelSurs&&g.surs[1-t]>0){g.surs[1-t]--;sur=' · Sur cancelled!';}else{g.surs[t]++;sur=' · Sur!';}}}else g.pool.push(card);
  g.message=`${g.players[seat].name} played ${label(card)}${take.length?' and captured '+take.map(label).join(' '):''}${sur}`;g.turn=(seat+1)%g.capacity;
  if(g.players.every(p=>p.hand.length===0)){if(g.deck.length)dealHands(g);else{if(g.lastCapture>=0)g.captured[team(g.lastCapture)].push(...g.pool);g.pool=[];finish(g);}}
}
export function claim(g:Game,seat:number){if(g.phase!=='playing')throw Error('You can claim only during a round.');if(g.scores.every(s=>s>=g.rules.goal)&&g.scores[0]===g.scores[1])throw Error('A tied deciding round must be played to the end.');const totals=g.captured.map((c,i)=>g.scores[i]+count(c,g.surs[i]).total);if(totals[team(seat)]<g.rules.goal)throw Error('You have not reached the target yet.');if(totals[0]===totals[1])throw Error('The scores are tied. Keep playing.');finish(g);g.message=`${g.players[seat].name} called per shodam.`;}
export function view(g:Game,key:string){const seat=g.players.findIndex(p=>p.key===key);if(seat<0)throw Error('Join this table to see the game.');const {deck,players,...rest}=g;return {...rest,remaining:deck.length,seat,players:players.map((p,i)=>({name:p.name,hand:i===seat?p.hand:[],handCount:p.hand.length}))};}
export type GameView = ReturnType<typeof view>;
