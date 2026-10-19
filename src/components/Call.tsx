import { useEffect, useRef, useState } from 'react';
import { ApiError, api, apiSSE, speakLine } from '../api';
import { useApp } from '../state';
import type { AgentId, CallEntry, VoiceProfile } from '../types';

type AgentStatus = 'idle' | 'thinking' | 'speaking';

type ManifestAgent = {
  id: AgentId;
  name: string;
  role: string;
  accent: string;
  tagline: string;
  voice: VoiceProfile;
};

type VoiceManifest = {
  agents: ManifestAgent[];
  catalogue: { ok: boolean; voices: Array<{ voiceId: string; name: string }>; detail?: string };
  note?: string;
};

const FALLBACK_AGENTS: ManifestAgent[] = [
  { id: 'orchestrator', name: 'Orchestrator', role: 'Planner', accent: '#7c8cff', tagline: 'Plans & delegates', voice: { elevenVoiceId: '21m00Tcm4TlvDq8ikWAM', elevenLabel: 'Rachel', pitch: 1.08, rate: 1 } },
  { id: 'coder', name: 'Coder', role: 'Implementer', accent: '#3ddc97', tagline: 'Writes code', voice: { elevenVoiceId: 'TxGEqnHWrfWFTfGW9XjX', elevenLabel: 'Josh', pitch: 1.2, rate: 1.06 } },
  { id: 'reviewer', name: 'Reviewer', role: 'Quality gate', accent: '#f2b45c', tagline: 'Audits quality', voice: { elevenVoiceId: 'pNInz6obpgDQGcFmaJgB', elevenLabel: 'Adam', pitch: 0.82, rate: 0.95 } },
];

const speechSupported =
  typeof window !== 'undefined' &&
  Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

/**
 * "Call Mind Flayer": a group voice room with the three agents. Speech recognition
 * (where the browser supports it) or typed lines feed the server, and replies
 * are spoken back with a distinct voice per agent — ElevenLabs when a key is
 * configured, otherwise the browser voice with the agent's pitch.
 */
export function Call() {
  const { me } = useApp();
  const [manifest, setManifest] = useState<VoiceManifest | null>(null);
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [listening, setListening] = useState(false);
  const [entries, setEntries] = useState<CallEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<Record<string, AgentStatus>>({});
  const [seconds, setSeconds] = useState(0);
  const [enginePref, setEnginePref] = useState<'auto' | 'browser'>('auto');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entriesRef = useRef<CallEntry[]>([]);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const recRef = useRef<{ stop: () => void } | null>(null);
  const listeningRef = useRef(false);
  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  entriesRef.current = entries;
  activeRef.current = active;
  mutedRef.current = muted;

  useEffect(() => {
    void api<VoiceManifest>('/api/voice')
      .then(setManifest)
      .catch(() => setManifest(null));
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const agents = manifest?.agents?.length ? manifest.agents : FALLBACK_AGENTS;

  const enqueueSpeak = (agent: AgentId, text: string) => {
    const profile = agents.find((a) => a.id === agent)?.voice;
    setStatus((prev) => ({ ...prev, [agent]: 'speaking' }));
    queueRef.current = queueRef.current
      .then(() =>
        speakLine(agent, text, profile, {
          prefer: enginePref === 'browser' ? 'browser' : 'auto',
          onFallback: (reason) => {
            if (reason === 'browser-voice') setNote('No ElevenLabs key — using the browser voice. Add one in Settings → Voice.');
            else if (reason.startsWith('tts-')) setNote('Voice service error — using the browser voice.');
          },
        }),
      )
      .catch(() => undefined)
      .finally(() => setStatus((prev) => ({ ...prev, [agent]: 'idle' })));
  };

  const sendLine = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy || !active) return;
    setBusy(true);
    setError(null);
    const nextEntries = [...entriesRef.current, { speaker: 'you', text }];
    setEntries(nextEntries);

    try {
      await apiSSE('/api/call/turn', { history: nextEntries }, (event, data) => {
        if (event === 'turn') {
          const agent = String(data.agent) as AgentId;
          if (data.status === 'start') {
            setStatus((prev) => ({ ...prev, [agent]: 'thinking' }));
          } else {
            const finalText = typeof data.text === 'string' ? data.text : '';
            setStatus((prev) => ({ ...prev, [agent]: 'idle' }));
            if (finalText) {
              setEntries((prev) => [...prev, { speaker: agent, text: finalText }]);
              enqueueSpeak(agent, finalText);
            }
          }
        } else if (event === 'error') {
          setError(String(data.message ?? 'Call failed'));
        }
      });
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Call failed');
    } finally {
      setStatus({});
      setBusy(false);
    }
  };

  const stopListening = () => {
    listeningRef.current = false;
    setListening(false);
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;
  };

  const startListening = () => {
    if (!speechSupported) {
      setError('This browser has no speech recognition — type your lines instead (Chrome/Edge recommended).');
      return;
    }
    const Ctor = (window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      const text = event.results[0][0]?.transcript ?? '';
      if (text) void sendLine(text);
    };
    rec.onerror = (event: { error?: string }) => {
      if (event.error !== 'aborted') {
        setError(event.error === 'not-allowed' ? 'Microphone permission denied.' : `Speech recognition error: ${event.error}`);
      }
      stopListening();
    };
    rec.onend = () => {
      if (activeRef.current && !mutedRef.current && listeningRef.current) {
        try {
          rec.start();
        } catch {
          stopListening();
        }
      } else {
        setListening(false);
      }
    };
    recRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    try {
      rec.start();
    } catch {
      stopListening();
    }
  };

  const toggleCall = async () => {
    if (active) {
      stopListening();
      setActive(false);
      setListening(false);
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* ignore */
      }
      queueRef.current = Promise.resolve();
      setStatus({});
      return;
    }
    setSeconds(0);
    setEntries([]);
    setError(null);
    setNote(null);
    setActive(true);
    const greeting: CallEntry = { speaker: 'you', text: 'Hello team, joining the call now — quick stand-up please.' };
    setEntries([greeting]);
    setBusy(true);
    try {
      await apiSSE('/api/call/turn', { history: [greeting] }, (event, data) => {
        if (event === 'turn') {
          const agent = String(data.agent) as AgentId;
          if (data.status === 'start') setStatus((prev) => ({ ...prev, [agent]: 'thinking' }));
          else {
            const finalText = typeof data.text === 'string' ? data.text : '';
            setStatus((prev) => ({ ...prev, [agent]: 'idle' }));
            if (finalText) {
              setEntries((prev) => [...prev, { speaker: agent, text: finalText }]);
              enqueueSpeak(agent, finalText);
            }
          }
        } else if (event === 'error') setError(String(data.message ?? 'Call failed'));
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the call');
      setActive(false);
    } finally {
      setBusy(false);
    }
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="call">
      <header className="call-head">
        <div>
          <h2>Call Mind Flayer</h2>
          <p className="muted">Group voice room — {agents.length} agents, one distinct voice each.</p>
        </div>
        <div className="call-head-right">
          <span className={`call-timer ${active ? 'live' : ''}`}>{active ? `● ${mmss}` : 'not connected'}</span>
        </div>
      </header>

      <div className="call-grid">
        <article className={`tile you ${active ? 'active' : ''} ${listening ? 'hot' : ''}`}>
          <div className="tile-avatar">You</div>
          <div className="tile-name">{me?.tag ?? 'Guest'}</div>
          <div className="tile-role">{muted ? 'muted' : listening ? 'listening…' : active ? 'on the call' : 'offline'}</div>
          <div className="tile-wave" aria-hidden>
            <span /><span /><span />
          </div>
        </article>

        {agents.map((agent) => {
          const agentStatus = status[agent.id] ?? 'idle';
          return (
            <article
              key={agent.id}
              className={`tile ${agentStatus}`}
              style={{ ['--tile' as string]: agent.accent }}
            >
              <div className="tile-avatar" style={{ background: `${agent.accent}22`, color: agent.accent, borderColor: `${agent.accent}55` }}>
                {agent.name.slice(0, 1)}
              </div>
              <div className="tile-name">{agent.name}</div>
              <div className="tile-role">{agentStatus === 'idle' ? agent.role : agentStatus === 'thinking' ? 'thinking…' : 'speaking…'}</div>
              <div className="tile-voice" title={manifest?.note}>
                {enginePref === 'browser' ? `pitch ${agent.voice.pitch.toFixed(2)}` : agent.voice.elevenLabel}
                <span className="tile-voice-sub">pitch {agent.voice.pitch.toFixed(2)} · rate {agent.voice.rate.toFixed(2)}</span>
              </div>
              <div className="tile-wave" aria-hidden>
                <span /><span /><span />
              </div>
            </article>
          );
        })}
      </div>

      <div className="call-transcript" ref={scrollRef}>
        {entries.length === 0 ? (
          <div className="empty-state compact">
            <p className="muted">Press start to open the room — the team greets you, then you can talk or type.</p>
          </div>
        ) : (
          entries.map((entry, idx) => {
            const agent = agents.find((a) => a.id === entry.speaker);
            const accent = agent?.accent ?? '#7c8cff';
            const name = agent?.name ?? 'You';
            return (
              <div key={`${entry.speaker}-${idx}`} className={`line ${entry.speaker === 'you' ? 'me' : ''}`}>
                <span className="line-who" style={{ color: entry.speaker === 'you' ? '#e8ecf5' : accent }}>
                  {name}
                </span>
                <span className="line-text">{entry.text}</span>
              </div>
            );
          })
        )}
        {busy ? <div className="line muted">connecting…</div> : null}
      </div>

      {error ? <div className="inline-error">{error}</div> : null}
      {note ? <div className="inline-note">{note}</div> : null}
      {!speechSupported ? (
        <div className="inline-note">Speech recognition is unavailable in this browser — use the text box (Chrome/Edge for mic input).</div>
      ) : null}

      <div className="call-controls">
        <button className={`btn btn-lg ${active ? 'btn-danger' : 'btn-primary'}`} onClick={() => void toggleCall()}>
          {active ? 'End call' : '📞 Start call'}
        </button>

        <button
          className={`btn ${listening ? 'btn-primary' : 'btn-ghost'}`}
          disabled={!active}
          onClick={() => (listening ? stopListening() : startListening())}
        >
          {listening ? '● Listening — tap to stop' : '🎤 Speak'}
        </button>

        <button
          className={`btn ${muted ? 'btn-warn' : 'btn-ghost'}`}
          disabled={!active}
          onClick={() => {
            setMuted((m) => !m);
            if (!muted) stopListening();
          }}
        >
          {muted ? 'Unmute mic' : 'Mute mic'}
        </button>

        <select
          className="input select"
          value={enginePref}
          onChange={(e) => setEnginePref(e.target.value as 'auto' | 'browser')}
          title="Voice engine"
        >
          <option value="auto">Voice: ElevenLabs (fallback browser)</option>
          <option value="browser">Voice: Browser only</option>
        </select>

        <form
          className="call-text"
          onSubmit={(e) => {
            e.preventDefault();
            void sendLine(draft);
            setDraft('');
          }}
        >
          <input
            className="input"
            placeholder="Type a line instead…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={!active || !draft.trim()}>
            Say
          </button>
        </form>
      </div>

      {manifest?.catalogue?.ok ? (
        <div className="muted small">
          {manifest.catalogue.voices.length} ElevenLabs voices available for re-assignment in Settings → Voice.
        </div>
      ) : null}
    </div>
  );
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
