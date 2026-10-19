import { decryptSecret } from './crypto';
import type { ConnectorRow, Env } from './types';

/**
 * API connector registry. Every LLM provider speaks the OpenAI-compatible
 * /chat/completions contract, so a connector is just base URL + key + model.
 * Users can add an unlimited number of connectors, including custom ones.
 */
export type ProviderPreset = {
  id: string;
  label: string;
  kind: 'llm' | 'tts';
  baseUrl: string;
  defaultModel?: string;
  docs: string;
  keyHint: string;
  local?: boolean;
  note?: string;
};

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    kind: 'llm',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    docs: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'llm',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-3.7-sonnet',
    docs: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-...',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'llm',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    docs: 'https://console.groq.com/keys',
    keyHint: 'gsk_...',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'llm',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    docs: 'https://api.together.ai/settings/api-keys',
    keyHint: '...',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'llm',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    docs: 'https://console.mistral.ai/api-keys',
    keyHint: '...',
  },
  {
    id: 'openllm',
    label: 'OpenLLM',
    kind: 'llm',
    baseUrl: 'http://localhost:4000/v1',
    defaultModel: 'openllm',
    docs: 'https://github.com/bentoml/OpenLLM',
    keyHint: 'not-needed',
    local: true,
    note: 'Self-hosted OpenLLM / vLLM server. Point base URL at your own host.',
  },
  {
    id: 'huggingface',
    label: 'HuggingFace',
    kind: 'llm',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    docs: 'https://huggingface.co/settings/tokens',
    keyHint: 'hf_...',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    kind: 'llm',
    baseUrl: '',
    defaultModel: 'custom',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    keyHint: '...',
    note: 'Any endpoint that exposes POST /chat/completions.',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs (voice)',
    kind: 'tts',
    baseUrl: 'https://api.elevenlabs.io',
    docs: 'https://elevenlabs.io/app/settings/api-keys',
    keyHint: 'sk_...',
    note: 'Powers Call Mind Flayer agent voices. Without it the browser voice is used.',
  },
];

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export type LLMClient = {
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Thrown for upstream failures; `publicMessage` is safe to send to the browser. */
export class UpstreamError extends Error {
  publicMessage: string;
  constructor(message: string, publicMessage = message) {
    super(message);
    this.name = 'UpstreamError';
    this.publicMessage = publicMessage;
  }
}

function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String((part as { text?: string })?.text ?? '')))
      .join('');
  }
  return '';
}

function errorText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message.slice(0, 400);
  } catch {
    /* not JSON */
  }
  return `Provider returned HTTP ${status}`;
}

/** Non-streaming completion. */
export async function llmChat(client: LLMClient, messages: ChatMessage[], temperature = 0.7): Promise<string> {
  const res = await fetch(`${client.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({ model: client.model, messages, temperature, stream: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new UpstreamError(body, errorText(body, res.status));
  }
  const payload = (await res.json()) as unknown;
  const text = extractContent(payload).trim();
  if (!text) throw new UpstreamError('Empty completion from provider', 'The model returned an empty response.');
  return text;
}

/**
 * Streaming completion: forwards OpenAI-style SSE deltas to `onToken`.
 * Falls back to a single non-streamed completion if the provider refuses to stream.
 */
export async function llmStream(
  client: LLMClient,
  messages: ChatMessage[],
  onToken: (chunk: string) => void | Promise<void>,
  temperature = 0.7,
): Promise<void> {
  const res = await fetch(`${client.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.apiKey}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ model: client.model, messages, temperature, stream: true }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 || res.status === 400) {
      // Provider rejected streaming — retry once without it.
      const text = await llmChat(client, messages, temperature);
      await onToken(text);
      return;
    }
    throw new UpstreamError(body, errorText(body, res.status));
  }
  if (!res.body) {
    const text = await llmChat(client, messages, temperature);
    await onToken(text);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawToken = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const piece = parsed?.choices?.[0]?.delta?.content;
          if (piece) {
            sawToken = true;
            await onToken(piece);
          }
        } catch {
          /* keepalive / non-JSON chunk */
        }
      }
    }
  }
  if (!sawToken) {
    const text = await llmChat(client, messages, temperature);
    await onToken(text);
  }
}

export async function testConnection(client: LLMClient): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${client.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${client.apiKey}` },
    });
    if (res.ok) {
      const payload = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
      const count = Array.isArray(payload?.data) ? payload.data.length : 0;
      return { ok: true, detail: count ? `${count} models available` : 'Connected' };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, detail: 'Rejected: invalid API key' };
    if (res.status === 404) return { ok: false, detail: 'Endpoint not found — check the base URL' };
    return { ok: false, detail: `Provider returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `Could not reach endpoint: ${(err as Error).message}` };
  }
}

/* ------------------------------------------------------------------ *
 * Offline demo engine
 * Used when no connector is configured, so every feature stays usable.
 * Responses are labelled "demo engine" in the UI — never passed off as
 * real model output.
 * ------------------------------------------------------------------ */

export const DEMO_LATENCY_MS = 18;

function topicOf(prompt: string): string {
  const lines = prompt.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? 'your request';
  return last.replace(/^(topic|task|request|user)\s*:\s*/i, '').slice(0, 160);
}

function slugOf(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const pick = words.filter((w) => w.length > 3).slice(0, 3);
  return (pick.length ? pick : words.slice(0, 3)).join('_') || 'task';
}

export type DemoKind = 'chat' | 'orchestrator' | 'coder' | 'reviewer' | 'discussion' | 'call';

export function demoComplete(kind: DemoKind, prompt: string): string {
  const topic = topicOf(prompt);
  const slug = slugOf(topic);

  switch (kind) {
    case 'orchestrator':
      return [
        `**Plan for: ${topic}**`,
        '',
        '1. **Clarify scope** — confirm inputs, outputs and constraints before writing code.',
        '2. **Design the interface** — define the function signature, error handling and data shapes.',
        '3. **Implement core path** — smallest correct implementation first, no premature optimisation.',
        '4. **Verify** — cover the happy path plus 2–3 edge cases (empty input, failure branch).',
        '5. **Hand off** — Coder implements steps 2–3, Reviewer audits step 4.',
        '',
        `_Decomposed into 5 steps. Handing the build to **Coder**._`,
      ].join('\n');
    case 'coder':
      return [
        '```ts',
        `/** ${topic} */`,
        `export async function ${slug}(input: { value: string }): Promise<{ ok: boolean; result: string }> {`,
        '  if (!input?.value) {',
        '    return { ok: false, result: "empty input" };',
        '  }',
        '',
        '  try {',
        '    const result = input.value.trim();',
        '    return { ok: true, result };',
        '  } catch (err) {',
        '    return { ok: false, result: err instanceof Error ? err.message : "unknown failure" };',
        '  }',
        '}',
        '```',
        '',
        'Implements the orchestrator plan with guard clauses, typed errors and no external deps.',
      ].join('\n');
    case 'reviewer':
      return [
        '**Review verdict: PASS with 2 notes.**',
        '',
        '- ✅ Guard clause covers the empty-input branch from the plan.',
        '- ✅ Errors are caught and returned, never thrown across the boundary.',
        '- ⚠️ `result` is currently echoed — add the real transformation when the spec is fixed.',
        '- ⚠️ Add one test for whitespace-only input before shipping.',
        '',
        'No blocking defects. Ready to merge after the two notes are addressed.',
      ].join('\n');
    case 'discussion':
      return [
        `On "${topic}" — I would sequence it as interface first, implementation second, so we can review a stable contract.`,
        '',
        'Coders on the team: does the signature above cover your edge cases?',
      ].join('\n');
    case 'call':
      return `Standing by. Ask me anything about ${topic} — I will keep it short so the others can weigh in.`;
    case 'chat':
    default:
      return [
        `Here is a working take on **${topic}**:`,
        '',
        '- Define the input contract explicitly so failures surface early.',
        '- Keep the core function pure; push I/O to the edges.',
        '- Return structured results (`{ ok, result }`) instead of throwing for expected failures.',
        '',
        'Want me to run this through the 3-agent pipeline for a plan, implementation and review?',
      ].join('\n');
  }
}

export async function demoStream(kind: DemoKind, prompt: string, onToken: (chunk: string) => void | Promise<void>): Promise<void> {
  const text = demoComplete(kind, prompt);
  const chunks = text.split(/(\s+)/).filter(Boolean);
  for (let i = 0; i < chunks.length; i += 3) {
    await onToken(chunks.slice(i, i + 3).join(''));
    await new Promise((resolve) => setTimeout(resolve, DEMO_LATENCY_MS));
  }
}

/* ------------------------------------------------------------------ *
 * Engine selection
 * ------------------------------------------------------------------ */

export type ResolvedEngine = { engine: 'llm'; client: LLMClient } | { engine: 'demo' };

export async function resolveEngine(
  _env: Env,
  connectors: ConnectorRow[],
  secret: string,
): Promise<ResolvedEngine> {
  const active = connectors.filter((c) => c.enabled && c.api_key_enc);
  if (!active.length) return { engine: 'demo' };
  const chosen =
    active.find((c) => c.is_default) ??
    active.find((c) => providerById(c.provider)?.kind === 'llm') ??
    active[0];
  if (providerById(chosen.provider)?.kind === 'tts') {
    const llm = active.find((c) => providerById(c.provider)?.kind === 'llm');
    if (!llm) return { engine: 'demo' };
    return { engine: 'llm', client: await toClient(llm, secret) };
  }
  return { engine: 'llm', client: await toClient(chosen, secret) };
}

export async function toClient(row: ConnectorRow, secret: string): Promise<LLMClient> {
  const preset = providerById(row.provider);
  const apiKey = row.api_key_enc ? await decryptSecret(secret, row.api_key_enc) : '';
  return {
    baseUrl: row.base_url || preset?.baseUrl || '',
    apiKey,
    model: row.model || preset?.defaultModel || 'unknown',
    label: row.name || preset?.label || row.provider,
  };
}
