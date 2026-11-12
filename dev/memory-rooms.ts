import type { RoomStore } from '../server/rooms.ts';
import type { Game } from '../lib/pasur.ts';
// Dev and test only: an in-memory RoomStore. Never imported by app/, lib/, server/ or netlify/.
export type MemoryRow = { game: Game; version: string };
export type MemoryRoomStore = RoomStore & {
  rows: Map<string, MemoryRow>;
  list(): string[];
  delete(code: string): boolean;
};
export function memoryRoomStore(): MemoryRoomStore {
  const rows = new Map<string, MemoryRow>();
  let serial = 0;
  return {
    rows,
    list: () => [...rows.keys()],
    delete: (code) => rows.delete(code),
    async read(code) {
      return structuredClone(rows.get(code) || null);
    },
    async create(game) {
      if (rows.has(game.code)) return false;
      rows.set(game.code, { game: structuredClone(game), version: String(++serial) });
      return true;
    },
    async save(game, version) {
      if (rows.get(game.code)?.version !== version) return false;
      rows.set(game.code, { game: structuredClone(game), version: String(++serial) });
      return true;
    },
  };
}
