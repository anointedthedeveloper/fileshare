import mongoose from 'mongoose';
import { config } from '../config.js';
import { connectDb, syncIndexes } from '../db.js';
import { ensureAdmin } from '../services/auth.js';

await connectDb(config().MONGODB_URI);
await syncIndexes();
await ensureAdmin();
console.log('indexes synced');
await mongoose.disconnect();
