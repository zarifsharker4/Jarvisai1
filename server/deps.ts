import type { RequestUser, Env } from './types';

/**
 * Injectable dependencies so the same app can run in production (email account
 * resolved from the signed session cookie) and in tests (a fixed user).
 */
export type AppDeps = {
  resolveUser: (request: Request, env: Env) => Promise<RequestUser | null>;
};
