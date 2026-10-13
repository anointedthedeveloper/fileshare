import { MongoMemoryServer } from 'mongodb-memory-server';

export default async function setup() {
  const m = await MongoMemoryServer.create();
  process.env.TEST_MONGO_URI = m.getUri();
  return async () => void (await m.stop());
}
