import { getStore } from '@netlify/blobs';
import type { Game } from '../lib/pasur.ts';
export interface RoomStore {
  read(code: string): Promise<{ game: Game; version: string } | null>;
  create(game: Game): Promise<boolean>;
  save(game: Game, version: string): Promise<boolean>;
}
// Site-wide, strongly consistent reads. Each game is one atomic document.
export function netlifyRoomStore(store = getStore({ name: 'pasur-rooms', consistency: 'strong' })): RoomStore {
  function modified(result: { modified: boolean; etag?: string }): boolean {
    // Fail closed if the provider does not confirm the stored version.
    if (result.modified && !result.etag) throw new Error('Storage did not confirm the write.');
    return result.modified;
  }
  return {
    async read(code) {
      const entry = await store.getWithMetadata(code, { type: 'json', consistency: 'strong' });
      if (!entry) return null;
      if (!entry.etag) throw new Error('Storage did not supply a version.');
      return { game: entry.data as Game, version: entry.etag };
    },
    async create(game) {
      return modified(await store.set(game.code, JSON.stringify(game), { onlyIfNew: true }));
    },
    async save(game, version) {
      if (!version) throw new Error('A stored version is required.');
      return modified(await store.set(game.code, JSON.stringify(game), { onlyIfMatch: version }));
    },
  };
}
