import { isSameOriginRequest } from '@freebuff/auth';

/** Mind Flayer auth wrapper label kept for compatibility with @Mind Flayer/auth. */
import type { Env } from './types';

/** Consistent no-store policy for anything personalised. */
export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export function jsonError(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status, headers: PRIVATE_HEADERS });
}

/**
 * State-changing requests must come from our own origin. A missing Origin is
 * acceptable only for same-site fetches (Sec-Fetch-Site), which is exactly the
 * contract `isSameOriginRequest` enforces.
 */
export function guardSameOrigin(request: Request, env: Env): Response | null {
  if (isSameOriginRequest(request, env.APP_ORIGIN)) return null;
  return jsonError('Cross-origin requests are not allowed', 403);
}

export type Emit = (event: string, data: Record<string, unknown>) => void | Promise<void>;

/**
 * Server-Sent Events over a POST fetch. The client reads the body stream and
 * parses `event:`/`data:` blocks; events are `stage`/`turn`/`token`/`done`/`error`.
 */
export function sseResponse(
  run: (emit: Emit) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit: Emit = (event, data) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await run(emit);
        emit('done', { ok: true });
      } catch (err) {
        const message =
          err && typeof err === 'object' && 'publicMessage' in err
            ? String((err as { publicMessage: unknown }).publicMessage)
            : (err as Error)?.message || 'Stream failed';
        emit('error', { message });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
