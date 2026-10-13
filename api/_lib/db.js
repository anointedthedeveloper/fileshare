import { MongoClient } from 'mongodb';

let cached; // reused across invocations of a warm function

export async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!cached) {
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
    cached = client.connect().then(async (c) => {
      const db = c.db(process.env.MONGODB_DB || 'parcel');
      await db.collection('files').createIndex({ code: 1 }, { unique: true });
      await db.collection('files').createIndex({ expiresAt: 1 });
      return db;
    });
    cached.catch(() => (cached = undefined)); // retry on next request if the first connect failed
  }
  return cached;
}
export const files = async () => (await getDb()).collection('files');
