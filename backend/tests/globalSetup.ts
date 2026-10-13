import { MongoMemoryServer } from 'mongodb-memory-server';

export default async function setup() {
  const mongod = await MongoMemoryServer.create();
  process.env.TEST_MONGO_URI = mongod.getUri();
  return async () => {
    await mongod.stop();
  };
}
