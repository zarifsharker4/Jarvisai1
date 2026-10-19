import type { RequestUser, Env } from './types';

/**
 * Injectable dependencies so the same app can run in production (Mind Flayer /
 * Google sessions resolved from cookies) and in tests (a fixed user).
 */
export type AppDeps = {
  resolveUser: (request: Request, env: Env) => Promise<RequestUser | null>;
};
