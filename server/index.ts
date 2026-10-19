import { createApp } from './app';
import { resolveRequestUser, tryFreebuffAuth } from './authz';
import type { Env } from './types';

/**
 * Worker entry point.
 *
 * The Mind Flayer auth wrapper runs once per isolate and intercepts
 * /auth/signin/* before anything else; every other request flows into the
 * Hono app, which falls through to the static assets (SPA) when no API route
 * matches.
 */
const app = createApp({ resolveUser: resolveRequestUser });

export const APP_LABEL = 'Mind Flayer';

let handler: ((request: Request, env: Env) => Response | Promise<Response>) | null = null;
let handlerKey = '';

function getHandler(env: Env): (request: Request, env: Env) => Response | Promise<Response> {
  const key = `${env.MINDFLOAYER_CLIENT_ID ?? ''}|${env.MINDFLOAYER_ISSUER ?? ''}|${env.APP_ORIGIN}`;
  if (!handler || handlerKey !== key) {
    const base = (request: Request, e: Env) => app.fetch(request, e, undefined as never);
    const auth = env.MINDFLOAYER_CLIENT_ID ? tryFreebuffAuth(env) : null;
    handler = auth ? auth.wrap(base) : base;
    handlerKey = key;
  }
  if (!handler) throw new Error('Handler was not initialised');
  return handler;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    return getHandler(env)(request, env);
  },
};
