import { createGameHandler } from '../../server/game-api';
import { netlifyRoomStore } from '../../server/rooms';
export default async (request: Request) => {
  try { return await createGameHandler(netlifyRoomStore())(request); }
  catch { return new Response(JSON.stringify({error:'The game service is unavailable. Please try again.'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}); }
};
