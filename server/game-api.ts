import { newGame, startRound, play, claim, view } from '../lib/pasur.ts';
import type { RoomStore } from './rooms.ts';
class RequestError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
const reply = (data: unknown, status = 200, cookie?: string) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store', ...(cookie?{'Set-Cookie':cookie}:{})}});
const tokenOf = (r: Request) => r.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('pasur_player='))?.slice(13);
async function digest(s: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function codeOf(raw: unknown) { if (typeof raw !== 'string' || !/^[A-Z2-9]{10}$/.test(raw)) throw new RequestError('Enter the 10-character table code.'); return raw; }
function nickname(raw: unknown) { const name=typeof raw==='string'?raw.trim().slice(0,24):''; if(!name)throw new RequestError('Enter your name.'); return name; }
function gameAction(fn: () => void) { try { fn(); } catch(e) { throw new RequestError((e as Error).message); } }
export function createGameHandler(rooms: RoomStore) {
  return async (r: Request): Promise<Response> => {
    try {
      if(r.method!=='GET' && r.method!=='POST') return new Response('Method not allowed',{status:405,headers:{Allow:'GET, POST','Cache-Control':'no-store'}});
      let token=tokenOf(r);
      if(r.method==='GET') {
        if(!token)throw new RequestError('Join this table to see the game.',403);
        const room=await rooms.read(codeOf(new URL(r.url).searchParams.get('code')));
        if(!room)throw new RequestError('Table not found. Check the invitation code.',404);
        const key=await digest(token);
        if(!room.game.players.some(p=>p.key===key))throw new RequestError('Join this table to see the game.',403);
        return reply(view(room.game,key));
      }
      const origin=r.headers.get('Origin');
      if(!origin || origin!==new URL(r.url).origin)throw new RequestError('Please open the game directly to continue.',403);
      if(Number(r.headers.get('content-length')||0)>2048)throw new RequestError('Request too large.',413);
      const raw=await r.text();
      if(raw.length>2048)throw new RequestError('Request too large.',413);
      let b: Record<string, unknown>;
      try { const parsed=JSON.parse(raw); if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw Error(); b=parsed; } catch { throw new RequestError('Invalid request.'); }
      if(!token || !/^[a-f0-9-]{36}$/.test(token))token=crypto.randomUUID();
      const key=await digest(token);
      const cookie=`pasur_player=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${new URL(r.url).protocol==='https:'?'; Secure':''}`;
      if(b.action==='create') {
        const name=nickname(b.name);
        const rules={goal:b.goal===100?100:62,surLimit:b.surLimit===999?999:50,cancelSurs:b.cancelSurs!==false};
        const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        for(let attempt=0;attempt<4;attempt++){
          const code=[...crypto.getRandomValues(new Uint8Array(10))].map(n=>alphabet[n%32]).join('');
          const g=newGame(code,b.capacity===4?4:2,rules,name,key);
          if(await rooms.create(g))return reply(view(g,key),200,cookie);
        }
        throw Error('Could not allocate a table code.');
      }
      const room=await rooms.read(codeOf(b.code));
      if(!room)throw new RequestError('Table not found. Check the invitation code.',404);
      const g=room.game, revision=g.revision, seat=g.players.findIndex(p=>p.key===key);
      if(b.action==='join') {
        if(seat>=0)return reply(view(g,key),200,cookie);
        if(g.phase!=='lobby'||g.players.length>=g.capacity)throw new RequestError('This table is full or already playing.');
        const name=nickname(b.name);
        g.players.push({name,key,hand:[]});g.message=`${name} joined the table.`;
      } else {
        if(seat<0)throw new RequestError('Join this table first.',403);
        if(b.revision!==revision)throw new RequestError('The table changed. Please try again.',409);
        if(b.action==='start'){
          if(seat!==0)throw new RequestError('Only the host can deal.',403);
          gameAction(()=>startRound(g));
        } else if(b.action==='play'){
          if(typeof b.card!=='string'||!Array.isArray(b.take)||b.take.some(c=>typeof c!=='string'))throw new RequestError('Invalid move.');
          const card=b.card,take=b.take as string[];gameAction(()=>play(g,seat,card,take));
        } else if(b.action==='claim'){
          gameAction(()=>claim(g,seat));
        } else if(b.action==='rematch'){
          if(seat!==0||g.phase!=='finished')throw new RequestError('The host can start a rematch after the game ends.',403);
          g.phase='lobby';g.scores=[0,0];g.round=0;gameAction(()=>startRound(g));
        } else throw new RequestError('Unknown action.');
      }
      g.revision=revision+1;
      if(!await rooms.save(g,room.version))throw new RequestError('The table changed. Please try again.',409);
      return reply(view(g,key),200,cookie);
    } catch(e) {
      if(e instanceof RequestError)return reply({error:e.message},e.status);
      console.error('Pasur storage request failed.',e instanceof Error?e.name:'UnknownError');
      return reply({error:'The game service is unavailable. Please try again.'},503);
    }
  };
}
