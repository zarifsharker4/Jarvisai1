import { createApp } from './app';
import { resolveRequestUser } from './authz';
import type { Env } from './types';

/**
 * Worker entry point.
 *
 * Every request flows into the Hono app, which handles the email + password +
 * 6-digit-code auth API, the PIN lock and the AI surfaces, then falls through
 * to the static assets (SPA) when no route matches. There is no third-party
 * identity provider in front of the app: accounts live in D1.
 */
const app = createApp({ resolveUser: resolveRequestUser });

// Only the default handler may be exported: workerd treats every other named
// export as a service entry point and refuses to boot if it is not a handler.
export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    return app.fetch(request, env, undefined as never);
  },
};
