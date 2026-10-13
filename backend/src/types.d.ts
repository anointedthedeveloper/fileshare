import type { UserDoc } from './models/User.js';

declare global {
  namespace Express {
    interface Request {
      user?: UserDoc;
      clientId: string; // HMAC of the client IP
    }
  }
}
export {};
