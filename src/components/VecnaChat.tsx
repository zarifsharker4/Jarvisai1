import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, apiSSE, speakWithBrowser, toHistory } from '../api';
import { Markdown } from '../markdown';
import { useApp } from '../state';
import type { Attachment, ChatMessage, VecnaStatus } from '../types';
import { playCallTone, playConfigAlert, playRingtone, type RingHandle } from '../ringtone';
import { Chat } from './Chat';
import { VecnaLogo } from './VecnaLogo';

type UiMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  streaming?: boolean;
  error?: boolean;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_FILE_BYTES = 200_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Button 1 — Vecna Chat: the continuous Gemini-style thread with Vecna, the
 * Supreme Guide (text, image and file uploads), a dedicated thread per
 * project, plus the user ↔ Vecna voice call with the kids-theme ringtone.
 * The legacy 3-agent lab (pipeline / discussion) lives behind the sub-tab.
 */
export function VecnaChat() {
  const { activeChatId, setActiveChatId, refreshChats, requestUnlock, activeProjectId, projects } =
    useApp();
  const [subMode, setSubMode] = useState<'vecna' | 'lab'>('vecna');
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [callOpen, setCallOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  /* Load the active thread (PIN-gated server side). */
  useEffect(() => {
    let cancelled = false;
    if (!activeChatId) {
      setMessages([]);
      setTitle(null);
      return;
    }
    (async () => {
      try {
        const res = await api<{ chat: { title: string; mode: string }; messages: ChatMessage[] }>(
          `/api/chats/${activeChatId}/messages`,
        );
        if (cancelled) return;
        setTitle(res.chat.title);
        setMessages(
          res.messages.map((m) => ({
            id: m.id ?? uid(),
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          })),
        );
        setSubMode(res.chat.mode === 'vecna' || res.chat.mode === 'chat' ? 'vecna' : 'lab');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 423) requestUnlock();
        else if (err instanceof ApiError && err.status !== 404) setLocalError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, requestUnlock]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* Attachments: images up to 4 MB, text files up to 200 KB. */
  const onFiles = (files: FileList | null) => {
    if (!files) return;
    void (async () => {
      const next: Attachment[] = [];
      for (const file of Array.from(files).slice(0, 5)) {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_BYTES) continue;
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('read failed'));
            reader.readAsDataURL(file);
          });
          next.push({ kind: 'image', name: file.name, mime: file.type, data });
        } else {
          if (file.size > MAX_FILE_BYTES) continue;
          const text = await file.text();
          next.push({ kind: 'text', name: file.name, data: text });
        }
      }
      setAttachments((prev) => [...prev, ...next].slice(0, 6));
    })();
  };

  const send = useCallback(
    async (raw?: string) => {
      const message = (raw ?? input).trim();
      if ((!message && !attachments.length) || busy) return;
      const sent = attachments;
      setBusy(true);
      setLocalError(null);
      setInput('');
      setAttachments([]);
      const assistantId = uid();
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'user',
          content: message || `(sent ${sent.length} attachment${sent.length > 1 ? 's' : ''})`,
          attachments: sent.length ? sent : undefined,
        },
        { id: assistantId, role: 'assistant', content: '', streaming: true },
      ]);

      try {
        await apiSSE(
          '/api/vecna/chat',
          {
            message: message || 'Here are the attachments.',
            chatId: activeChatId,
            projectId: activeProjectId,
            history: toHistory(messages as ChatMessage[]),
            attachments: sent,
          },
          (event, data) => {
            if (event === 'meta') {
              setEngine(String(data.engine ?? ''));
              if (typeof data.chatId === 'string' && data.chatId !== activeChatId) {
                setActiveChatId(data.chatId);
              }
            } else if (event === 'token') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + String(data.text ?? '') } : m,
                ),
              );
            } else if (event === 'error') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        streaming: false,
                        error: true,
                        content: m.content + `\n\n⚠️ ${String(data.message ?? 'stream failed')}`,
                      }
                    : m,
                ),
              );
            } else if (event === 'saved') {
              void refreshChats();
            }
          },
        );
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 423) {
          requestUnlock();
          setLocalError('Chat history is locked — enter your PIN to continue.');
        } else {
          setLocalError(err instanceof Error ? err.message : 'Request failed');
        }
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
      } finally {
        setBusy(false);
      }
    },
    [activeChatId, activeProjectId, attachments, busy, input, messages, refreshChats, requestUnlock, setActiveChatId],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="mode-switch" role="tablist" aria-label="Thread">
          <button
            role="tab"
            aria-selected={subMode === 'vecna'}
            className={`mode-btn ${subMode === 'vecna' ? 'active' : ''}`}
            onClick={() => setSubMode('vecna')}
          >
            ◉ Vecna
          </button>
          <button
            role="tab"
            aria-selected={subMode === 'lab'}
            className={`mode-btn ${subMode === 'lab' ? 'active' : ''}`}
            onClick={() => setSubMode('lab')}
          >
            ⚗ 3-Agent Lab
          </button>
        </div>
        <div className="chat-head-right">
          {project ? <span className="proj-chip">{project.name} · dedicated thread</span> : null}
          {engine === 'demo' ? (
            <span className="badge badge-warn" title="Add Vecna's Gemini key to go live">
              offline demo engine
            </span>
          ) : engine ? (
            <span className="badge badge-ok">{engine}</span>
          ) : null}
          <button
            className={`btn btn-sm ${callOpen ? 'btn-danger' : 'btn-ghost'}`}
            onClick={() => setCallOpen((v) => !v)}
          >
            {callOpen ? '✕ Close call' : '📞 Call Vecna'}
          </button>
        </div>
      </div>

      {callOpen ? <VecnaCall /> : null}
      {title && subMode === 'vecna' ? <div className="session-title">{title}</div> : null}
      {localError ? <div className="inline-error">{localError}</div> : null}

      {subMode === 'lab' ? (
        <div className="lab-wrap">
          <Chat />
        </div>
      ) : (
        <>
          <div className="chat-scroll" ref={scrollRef}>
            <div className="msg-list">
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-mark vecna-empty">
                    <VecnaLogo size={54} />
                  </div>
                  <h2>What are we building?</h2>
                  <p className="muted">
                    Vecna is always on. Ask anything, drop screenshots or files in, or call Vecna
                    for a live voice walkthrough.
                  </p>
                  <div className="empty-cta">
                    Try: “Review the file I'm about to push to zarifsharker4/Jarvisai1”
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : 'assistant vecna-msg'}`}>
                    {m.role === 'assistant' ? (
                      <div className="msg-avatar vecna-avatar-chip">
                        <VecnaLogo size={26} />
                      </div>
                    ) : null}
                    <div className={m.role === 'user' ? 'msg-body' : 'msg-col'}>
                      {m.role === 'assistant' ? <div className="msg-name">Vecna · Supreme Guide</div> : null}
                      {m.attachments?.length ? (
                        <div className="attach-chips">
                          {m.attachments.map((a) => (
                            <span key={a.name} className={`attach-chip ${a.kind}`}>
                              {a.kind === 'image' ? '🖼' : '📎'} {a.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className={m.role === 'user' ? 'msg-body' : 'msg-body'}>
                        {m.content ? <Markdown text={m.content} /> : null}
                        {m.streaming && !m.content ? <span className="muted">thinking…</span> : null}
                        {m.streaming ? <span className="caret" /> : null}
                        {m.error ? <span className="msg-error">stream interrupted</span> : null}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <form className="composer" onSubmit={onSubmit}>
            {attachments.length ? (
              <div className="attach-chips editable">
                {attachments.map((a, idx) => (
                  <span key={`${a.name}-${idx}`} className={`attach-chip ${a.kind}`}>
                    {a.kind === 'image' ? '🖼' : '📎'} {a.name}
                    <button
                      type="button"
                      className="attach-x"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer-row">
              <button
                type="button"
                className="icon-btn attach-btn"
                title="Attach images or files"
                onClick={() => fileRef.current?.click()}
              >
                ＋
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept="image/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.html,.css,.yml,.yaml,.toml,.csv,.sh,.sql"
                onChange={(e) => {
                  onFiles(e.target.files);
                  e.currentTarget.value = '';
                }}
              />
              <textarea
                className="composer-input"
                rows={2}
                placeholder={`Message Vecna${project ? ` · ${project.name}` : ''} — text, images, files…`}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button className="btn btn-primary send-btn" type="submit" disabled={busy || (!input.trim() && !attachments.length)}>
                {busy ? '…' : 'Send'}
              </button>
            </div>
            <div className="composer-hint">
              Enter to send · Shift+Enter for a newline · images become multimodal context
            </div>
          </form>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Voice call: strictly the user and Vecna.
 * ------------------------------------------------------------------ */

type CallEntry = { speaker: 'you' | 'vecna'; text: string };

function VecnaCall() {
  const { activeProjectId } = useApp();
  const [status, setStatus] = useState<VecnaStatus | null>(null);
  const [phase, setPhase] = useState<'idle' | 'ringing' | 'active'>('idle');
  const [entries, setEntries] = useState<CallEntry[]>([]);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const ringRef = useRef<RingHandle | null>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const listeningRef = useRef(false);
  const phaseRef = useRef(phase);
  const speakQueue = useRef<Promise<void>>(Promise.resolve());
  const entriesRef = useRef<CallEntry[]>([]);
  phaseRef.current = phase;
  entriesRef.current = entries;

  useEffect(() => {
    api<VecnaStatus>('/api/vecna/status').then(setStatus).catch(() => undefined);
    return () => {
      ringRef.current?.stop();
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'active') return;
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

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

  const speak = (text: string) => {
    speakQueue.current = speakQueue.current
      .then(() => speakWithBrowser(text, { pitch: 0.9, rate: 1.02 }))
      .catch(() => undefined);
  };

  const turn = useCallback(
    async (next: CallEntry[]) => {
      setBusy(true);
      setError(null);
      try {
        await apiSSE('/api/vecna/call/turn', { history: next, projectId: activeProjectId }, (event, data) => {
          if (event === 'turn' && data.status === 'end') {
            const text = typeof data.text === 'string' ? data.text : '';
            if (text) {
              setEntries((prev) => [...prev, { speaker: 'vecna', text }]);
              speak(text);
            }
          } else if (event === 'error') {
            setError(String(data.message ?? 'Call failed'));
          }
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Call failed');
      } finally {
        setBusy(false);
      }
    },
    [activeProjectId],
  );

  const startListening = () => {
    type Rec = {
      lang: string;
      interimResults: boolean;
      maxAlternatives: number;
      continuous: boolean;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: ((e: { error?: string }) => void) | null;
      onend: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setError('This browser has no speech recognition — type your lines instead.');
      return;
    }
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (event) => {
      const text = event.results[0][0]?.transcript ?? '';
      if (text) {
        const next = [...entriesRef.current, { speaker: 'you' as const, text }];
        setEntries(next);
        void turn(next);
      }
    };
    rec.onerror = (event) => {
      if (event.error !== 'aborted') {
        setError(event.error === 'not-allowed' ? 'Microphone permission denied.' : `Speech error: ${event.error}`);
      }
      stopListening();
    };
    rec.onend = () => {
      if (phaseRef.current === 'active' && listeningRef.current) {
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

  const startCall = async () => {
    if (status && !status.configured && !status.hasAnyKey) {
      playConfigAlert();
      setError("Vecna has no API key yet — add a Gemini key in the API & Field Manager first.");
      return;
    }
    setSeconds(0);
    setEntries([]);
    setError(null);
    setPhase('ringing');
    ringRef.current = playRingtone(); // kids-theme homage while it rings
    await new Promise((resolve) => window.setTimeout(resolve, 1800));
    ringRef.current?.stop();
    ringRef.current = null;
    playCallTone('connect');
    setPhase('active');
    const greeting: CallEntry = { speaker: 'you', text: 'Hey Vecna, I am on the call.' };
    setEntries([greeting]);
    void turn([greeting]);
  };

  const endCall = () => {
    ringRef.current?.stop();
    ringRef.current = null;
    stopListening();
    playCallTone('disconnect');
    window.speechSynthesis?.cancel();
    setPhase('idle');
    setSeconds(0);
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <section className="vecna-call">
      <header className="vecna-call-head">
        <div className="vecna-call-peer">
          <VecnaLogo size={34} />
          <div>
            <strong>Vecna</strong>
            <span className="muted small">
              {phase === 'active' ? `on call · ${mmss}` : phase === 'ringing' ? 'ringing…' : 'voice call · just you two'}
            </span>
          </div>
        </div>
        <div className="vecna-call-actions">
          {phase === 'idle' ? (
            <button className="btn btn-primary" onClick={() => void startCall()}>
              📞 Start call
            </button>
          ) : (
            <>
              <button
                className={`btn ${listening ? 'btn-primary' : 'btn-ghost'}`}
                disabled={phase !== 'active' || busy}
                onClick={() => (listening ? stopListening() : startListening())}
              >
                {listening ? '● Listening' : '🎤 Speak'}
              </button>
              <button className="btn btn-danger" onClick={endCall}>
                End call
              </button>
            </>
          )}
        </div>
      </header>

      {error ? <div className="inline-error">{error}</div> : null}

      {entries.length ? (
        <div className="vecna-call-transcript">
          {entries.map((entry, idx) => (
            <div key={`${entry.speaker}-${idx}`} className={`line ${entry.speaker === 'you' ? 'me' : ''}`}>
              <span className="line-who">{entry.speaker === 'you' ? 'You' : 'Vecna'}</span>
              <span className="line-text">{entry.text}</span>
            </div>
          ))}
          {busy ? <div className="line muted">Vecna is composing…</div> : null}
        </div>
      ) : (
        <p className="muted small">
          Live voice conversation with Vecna — the ringtone plays while it connects, and the
          config chime fires if a key is missing.
        </p>
      )}
    </section>
  );
}
