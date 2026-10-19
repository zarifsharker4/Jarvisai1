import type { ChatMessage } from './types';

export class ApiError extends Error {
  status: number;
  reason?: string;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const PIN_KEY = 'mindflayer_pin_token';

export function getPinToken(): string | null {
  try {
    return sessionStorage.getItem(PIN_KEY);
  } catch {
    return null;
  }
}

export function setPinToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(PIN_KEY, token);
    else sessionStorage.removeItem(PIN_KEY);
  } catch {
    /* private mode */
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  pin?: boolean;
  signal?: AbortSignal;
};

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const pin = options.pin !== false ? getPinToken() : null;
  if (pin) headers['x-mindflayer-pin'] = pin;

  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    signal: options.signal,
  });

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const err = (payload ?? {}) as { error?: string; reason?: string };
    throw new ApiError(err.error || `Request failed (${res.status})`, res.status, err.reason);
  }
  return payload as T;
}

export type SSEHandler = (event: string, data: Record<string, unknown>) => void;

/**
 * POST + Server-Sent Events. The server streams `stage`/`turn`/`token`/`done`
 * events; non-2xx responses are parsed as JSON errors first.
 */
export async function apiSSE(path: string, body: unknown, onEvent: SSEHandler): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const pin = getPinToken();
  if (pin) headers['x-mindflayer-pin'] = pin;

  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });

  if (!res.ok) {
    const text = await res.text();
    let payload: { error?: string; reason?: string } = {};
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 200) };
    }
    throw new ApiError(payload.error || `Request failed (${res.status})`, res.status, payload.reason);
  }
  if (!res.body) throw new ApiError('No response stream', 500);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block: string) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      onEvent(event, JSON.parse(data));
    } catch {
      /* malformed chunk */
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      dispatch(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

/** Speech synthesis for one agent line, with ElevenLabs first and browser speech as fallback. */
export async function speakLine(
  agent: string,
  text: string,
  voice: { elevenVoiceId: string; pitch: number; rate: number } | undefined,
  opts: { prefer?: 'auto' | 'browser'; onFallback?: (reason: string) => void } = {},
): Promise<void> {
  const clean = text.replace(/\*\*?/g, '').replace(/[#`>]/g, '').trim();
  if (!clean) return;

  if (opts.prefer !== 'browser') {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean, agent }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          await new Promise<void>((resolve, reject) => {
            const audio = new Audio(url);
            audio.onended = () => {
              URL.revokeObjectURL(url);
              resolve();
            };
            audio.onerror = () => {
              URL.revokeObjectURL(url);
              reject(new Error('audio playback failed'));
            };
            audio.play().catch(reject);
          });
          return;
        }
      } else if (res.status === 424) {
        opts.onFallback?.('browser-voice');
      } else {
        opts.onFallback?.(`tts-http-${res.status}`);
      }
    } catch {
      opts.onFallback?.('tts-network');
    }
  }

  await speakWithBrowser(clean, voice);
}

export function speakWithBrowser(
  text: string,
  voice: { pitch: number; rate: number } | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve();
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.pitch = voice?.pitch ?? 1;
      utterance.rate = voice?.rate ?? 1;
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        const preferred =
          voices.find((v) => /en-(US|GB)/.test(v.lang) && /female|natural|samantha|karen|serena/i.test(v.name)) ??
          voices.find((v) => v.lang.startsWith('en')) ??
          voices[0];
        utterance.voice = preferred;
      }
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve();
    }
  });
}

export type HistoryEntry = { role: 'user' | 'assistant'; content: string };

export function toHistory(messages: ChatMessage[]): HistoryEntry[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}
