import { decryptSecret } from './crypto';
import { AGENTS, type AgentId } from './agents';
import { providerById } from './providers';
import type { ConnectorRow, Env, UserRow } from './types';

/**
 * Call Mind Flayer voice layer.
 *
 * ElevenLabs is the primary engine (one distinct voice per agent). The browser
 * Web Speech API is the no-key fallback, and it is the only engine that can
 * apply a literal pitch shift — ElevenLabs exposes voice selection and speed,
 * not a pitch parameter. Each agent therefore carries a full voice profile:
 * ElevenLabs voice id, browser pitch and rate, and a display label.
 */
export type VoiceProfile = {
  elevenVoiceId: string;
  elevenLabel: string;
  pitch: number;
  rate: number;
};

export type VoiceProfiles = Record<AgentId, VoiceProfile>;

export const DEFAULT_VOICES: VoiceProfiles = {
  orchestrator: {
    elevenVoiceId: '21m00Tcm4TlvDq8ikWAM',
    elevenLabel: 'Rachel (warm, clear)',
    pitch: 1.08,
    rate: 1.0,
  },
  coder: {
    elevenVoiceId: 'TxGEqnHWrfWFTfGW9XjX',
    elevenLabel: 'Josh (bright, quick)',
    pitch: 1.2,
    rate: 1.06,
  },
  reviewer: {
    elevenVoiceId: 'pNInz6obpgDQGcFmaJgB',
    elevenLabel: 'Adam (deep, measured)',
    pitch: 0.82,
    rate: 0.95,
  },
};

export const ELEVEN_MODEL = 'eleven_flash_v2_5';

export function loadVoices(user: UserRow | null): VoiceProfiles {
  if (!user?.voice_profile) return { ...DEFAULT_VOICES };
  try {
    const parsed = JSON.parse(user.voice_profile) as Partial<VoiceProfiles>;
    return {
      orchestrator: { ...DEFAULT_VOICES.orchestrator, ...(parsed.orchestrator ?? {}) },
      coder: { ...DEFAULT_VOICES.coder, ...(parsed.coder ?? {}) },
      reviewer: { ...DEFAULT_VOICES.reviewer, ...(parsed.reviewer ?? {}) },
    };
  } catch {
    return { ...DEFAULT_VOICES };
  }
}

export function isAgentId(value: unknown): value is AgentId {
  return value === 'orchestrator' || value === 'coder' || value === 'reviewer';
}

export type TtsResult =
  | { ok: true; bytes: ArrayBuffer; contentType: string; engine: 'elevenlabs'; voiceId: string }
  | { ok: false; reason: 'no_key' | 'upstream_error'; detail: string };

/** Resolve the ElevenLabs key: server env first, then the user's connector. */
export async function resolveElevenKey(
  env: Env,
  connectors: ConnectorRow[],
  secret: string,
): Promise<string | null> {
  if (env.ELEVENLABS_API_KEY) return env.ELEVENLABS_API_KEY;
  const row = connectors.find((c) => c.provider === 'elevenlabs' && c.enabled && c.api_key_enc);
  if (!row?.api_key_enc) return null;
  try {
    return await decryptSecret(secret, row.api_key_enc);
  } catch {
    return null;
  }
}

/** Synthesise speech for one agent with its assigned voice. */
export async function synthesize(
  env: Env,
  connectors: ConnectorRow[],
  secret: string,
  agent: AgentId,
  text: string,
  voices: VoiceProfiles,
): Promise<TtsResult> {
  const clean = text.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean) return { ok: false, reason: 'no_key', detail: 'Nothing to speak' };

  const key = await resolveElevenKey(env, connectors, secret);
  if (!key) return { ok: false, reason: 'no_key', detail: 'No ElevenLabs key configured' };

  const profile = voices[agent] ?? DEFAULT_VOICES[agent];
  const base = (providerById('elevenlabs')?.baseUrl || 'https://api.elevenlabs.io').replace(/\/$/, '');
  try {
    const res = await fetch(
      `${base}/v1/text-to-speech/${profile.elevenVoiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          model_id: ELEVEN_MODEL,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: profile.rate,
          },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        reason: 'upstream_error',
        detail: `ElevenLabs HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }
    return {
      ok: true,
      bytes: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      engine: 'elevenlabs',
      voiceId: profile.elevenVoiceId,
    };
  } catch (err) {
    return { ok: false, reason: 'upstream_error', detail: (err as Error).message };
  }
}

/** Voice catalogue for the Settings voice picker (needs a key). */
export async function listVoices(
  env: Env,
  connectors: ConnectorRow[],
  secret: string,
): Promise<{ ok: boolean; voices: Array<{ voiceId: string; name: string }>; detail?: string }> {
  const key = await resolveElevenKey(env, connectors, secret);
  if (!key) return { ok: false, voices: [], detail: 'No ElevenLabs key configured' };
  const base = (providerById('elevenlabs')?.baseUrl || 'https://api.elevenlabs.io').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v2/voices`, { headers: { 'xi-api-key': key } });
    if (!res.ok) return { ok: false, voices: [], detail: `ElevenLabs HTTP ${res.status}` };
    const payload = (await res.json()) as { voices?: Array<{ voice_id: string; name: string }> };
    const voices = (payload.voices ?? []).map((v) => ({ voiceId: v.voice_id, name: v.name }));
    return { ok: true, voices };
  } catch (err) {
    return { ok: false, voices: [], detail: (err as Error).message };
  }
}

/** Payload the client needs to render agent tiles and drive browser speech. */
export function voiceManifest(voices: VoiceProfiles) {
  return {
    agents: (Object.keys(AGENTS) as AgentId[]).map((id) => ({
      id,
      name: AGENTS[id].name,
      role: AGENTS[id].role,
      accent: AGENTS[id].accent,
      tagline: AGENTS[id].tagline,
      voice: voices[id],
    })),
    engines: { elevenlabs: true, browser: true },
    note: 'ElevenLabs has no pitch parameter: pitch is applied by the browser voice, ElevenLabs uses a distinct voice id plus speed per agent.',
  };
}
