import { MongoClient } from 'mongodb';
import { resolvePorts, readRepoEnv } from '../../../tools/ports.mts';

// Direct-to-Mongo seeding for the manage-assets approval e2e. The replay backend
// (`just backend-serve-replay`) uses MONGO_DB=bloom_studio on localhost:27017.
// The run cassette deletes the FIXED asset id `e2e-doomed-asset`, so the seeded
// doc MUST carry that exact _id and the active room's game_id, with a completed
// generation so it renders as a card on the Asset Board.
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017';
const { offset } = resolvePorts(readRepoEnv());
// Mirror the justfile's backend-serve-replay DB derivation so seeding hits the SAME
// DB the offset backend reads (offset 0 -> bloom_studio, else bloom_studio_wt{N}).
// Keep these two derivations in sync (the justfile is the other site).
const MONGO_DB = process.env.MONGO_DB ?? (offset === 0 ? 'bloom_studio' : `bloom_studio_wt${offset}`);

interface IAssetDoc {
  _id: string;
  game_id: string;
  name: string;
  category: string | null;
  prompt: string;
  width: number;
  height: number;
  workflow: string;
  seed: number | null;
  status: string;
  generations: { id: string; seed: number; image_ref: string; created_at: string }[];
  selected_generation_id: string | null;
  error: string | null;
}

export async function seedAsset(gameId: string, assetId: string, name: string): Promise<void> {
  const client = new MongoClient(MONGO_URL);
  try {
    const doc: IAssetDoc = {
      _id: assetId,
      game_id: gameId,
      name,
      category: null,
      prompt: 'seeded for e2e',
      width: 512,
      height: 512,
      workflow: 'schnell-transparent',
      seed: null,
      status: 'done',
      generations: [{ id: 'gen-e2e', seed: 1, image_ref: '/media/placeholder.png', created_at: new Date().toISOString() }],
      selected_generation_id: 'gen-e2e',
      error: null,
    };
    await client.db(MONGO_DB).collection<IAssetDoc>('assets').replaceOne({ _id: assetId }, doc, { upsert: true });
  } finally {
    await client.close();
  }
}

export async function removeSeed(assetId: string): Promise<void> {
  const client = new MongoClient(MONGO_URL);
  try {
    await client.db(MONGO_DB).collection<IAssetDoc>('assets').deleteOne({ _id: assetId });
  } finally {
    await client.close();
  }
}
