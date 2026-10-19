import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, apiSSE, toHistory } from '../api';
import { Markdown } from '../markdown';
import { useApp } from '../state';
import type { AgentId, ChatMessage } from '../types';

type Mode = 'assist' | 'pipeline' | 'discussion';

type UiMsg = {
  id: string;
  role: 'user' | 'assistant';
  agent?: string;
  content: string;
  streaming?: boolean;
  error?: boolean;
};

type StageState = {
  agent: AgentId;
  round: number;
  status: 'pending' | 'active' | 'done';
  text: string;
};

type TurnState = {
  agent: string;
  name: string;
  text: string;
  status: 'active' | 'done';
};

const AGENT_STYLE: Record<string, { name: string; accent: string }> = {
  orchestrator: { name: 'Orchestrator', accent: '#7c8cff' },
  coder: { name: 'Coder', accent: '#3ddc97' },
  reviewer: { name: 'Reviewer', accent: '#f2b45c' },
  jarvis: { name: 'Mind Flayer', accent: '#7c8cff' },
  pipeline: { name: 'Pipeline', accent: '#7c8cff' },
};

const uid = () => Math.random().toString(36).slice(2, 10);

export function Chat() {
  const { activeChatId, setActiveChatId, refreshChats, requestUnlock, me } = useApp();
  const [mode, setMode] = useState<Mode>('assist');
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [stages, setStages] = useState<StageState[]>([]);
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [input, setInput] = useState('');
  const [topic, setTopic] = useState('');
  const [rounds, setRounds] = useState(6);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  const agents = useMemo(
    () =>
      (['orchestrator', 'coder', 'reviewer'] as AgentId[]).map((id) => ({
        id,
        ...(AGENT_STYLE[id] ?? { name: id, accent: '#7c8cff' }),
      })),
    [],
  );

  /* Load a chat from the sidebar */
  useEffect(() => {
    let cancelled = false;
    abortRef.current = true;
    setLocalError(null);
    if (!activeChatId) {
      setMessages([]);
      setStages([]);
      setTurns([]);
      setTitle(null);
      return () => {
        cancelled = true;
      };
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
            agent: m.agent ?? undefined,
            content: m.content,
          })),
        );
        if (res.chat.mode === 'pipeline') setMode('pipeline');
        else setMode('assist');
        setStages([]);
        setTurns([]);
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
  }, [messages, stages, turns]);

  const handleStreamError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 423) {
        requestUnlock();
        setLocalError('Chat history is locked — enter your PIN to continue.');
      } else {
        setLocalError(err instanceof Error ? err.message : 'Request failed');
      }
    },
    [requestUnlock],
  );

  const sendChat = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setLocalError(null);
    abortRef.current = false;
    setInput('');

    const assistantId = uid();
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', content: message },
      { id: assistantId, role: 'assistant', agent: 'jarvis', content: '', streaming: true },
    ]);

    try {
      await apiSSE(
        '/api/chat',
        { message, chatId: activeChatId, history: toHistory(messages as ChatMessage[]) },
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
                  ? { ...m, streaming: false, error: true, content: m.content + `\n\n⚠️ ${String(data.message ?? 'stream failed')}` }
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
      handleStreamError(err);
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
    } finally {
      setBusy(false);
    }
  };

  const runPipeline = async () => {
    const request = input.trim();
    if (!request || busy) return;
    setBusy(true);
    setLocalError(null);
    abortRef.current = false;
    setInput('');
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: request }]);
    setStages(
      agents.map((a) => ({ agent: a.id, round: 1, status: 'pending' as const, text: '' })),
    );

    try {
      await apiSSE('/api/pipeline', { request, chatId: activeChatId }, (event, data) => {
        if (event === 'meta') {
          setEngine(String(data.engine ?? ''));
          if (typeof data.chatId === 'string' && data.chatId !== activeChatId) {
            setActiveChatId(data.chatId);
          }
        } else if (event === 'stage') {
          const agent = String(data.agent) as AgentId;
          const round = Number(data.round ?? 1);
          setStages((prev) => {
            const existing = prev.find((s) => s.agent === agent && s.round === round);
            if (!existing) {
              return [...prev, { agent, round, status: data.status === 'end' ? 'done' : 'active', text: String(data.text ?? '') }];
            }
            return prev.map((s) =>
              s.agent === agent && s.round === round
                ? {
                    ...s,
                    status: data.status === 'end' ? 'done' : 'active',
                    text: typeof data.text === 'string' ? data.text : s.text,
                  }
                : s,
            );
          });
        } else if (event === 'token') {
          const agent = String(data.agent) as AgentId;
          setStages((prev) => {
            const idx = [...prev].reverse().findIndex((s) => s.agent === agent && s.status === 'active');
            if (idx < 0) return prev;
            const target = prev.length - 1 - idx;
            return prev.map((s, i) => (i === target ? { ...s, text: s.text + String(data.text ?? '') } : s));
          });
        } else if (event === 'error') {
          setLocalError(String(data.message ?? 'Pipeline failed'));
        } else if (event === 'saved') {
          void refreshChats();
        }
      });
      setStages((prev) => prev.map((s) => (s.status === 'active' ? { ...s, status: 'done' } : s)));
    } catch (err) {
      handleStreamError(err);
    } finally {
      setBusy(false);
    }
  };

  const runDiscussion = async () => {
    const value = topic.trim();
    if (!value || busy) return;
    setBusy(true);
    setLocalError(null);
    setTurns([]);

    try {
      await apiSSE('/api/discussion', { topic: value, rounds }, (event, data) => {
        if (event === 'meta') {
          setEngine(String(data.engine ?? ''));
        } else if (event === 'turn') {
          const agent = String(data.agent);
          const name = String(data.name ?? agent);
          if (data.status === 'start') {
            setTurns((prev) => [...prev, { agent, name, text: '', status: 'active' }]);
          } else {
            setTurns((prev) =>
              prev.map((t, i) =>
                i === prev.length - 1
                  ? { ...t, status: 'done', text: typeof data.text === 'string' ? data.text : t.text }
                  : t,
              ),
            );
          }
        } else if (event === 'token') {
          setTurns((prev) =>
            prev.map((t, i) => (i === prev.length - 1 ? { ...t, text: t.text + String(data.text ?? '') } : t)),
          );
        } else if (event === 'error') {
          setLocalError(String(data.message ?? 'Discussion failed'));
        }
      });
      setTurns((prev) => prev.map((t) => ({ ...t, status: 'done' as const })));
    } catch (err) {
      handleStreamError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (mode === 'assist') void sendChat();
    else if (mode === 'pipeline') void runPipeline();
    else void runDiscussion();
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="mode-switch" role="tablist" aria-label="Chat mode">
          <button
            role="tab"
            aria-selected={mode === 'assist'}
            className={`mode-btn ${mode === 'assist' ? 'active' : ''}`}
            onClick={() => setMode('assist')}
          >
            Assist
          </button>
          <button
            role="tab"
            aria-selected={mode === 'pipeline'}
            className={`mode-btn ${mode === 'pipeline' ? 'active' : ''}`}
            onClick={() => setMode('pipeline')}
          >
            3-Agent Pipeline
          </button>
          <button
            role="tab"
            aria-selected={mode === 'discussion'}
            className={`mode-btn ${mode === 'discussion' ? 'active' : ''}`}
            onClick={() => setMode('discussion')}
          >
            AI ↔ AI Discussion
          </button>
        </div>
        <div className="chat-head-right">
          {engine === 'demo' ? (
            <span className="badge badge-warn" title="Add an API key in Settings → Connectors for live model output">
              offline demo engine
            </span>
          ) : engine ? (
            <span className="badge badge-ok">{engine}</span>
          ) : null}
        </div>
      </div>

      {title ? <div className="session-title">{title}</div> : null}
      {localError ? <div className="inline-error">{localError}</div> : null}

      <div className="chat-scroll" ref={scrollRef}>
        {mode === 'assist' ? (
          <div className="msg-list">
            {messages.length === 0 ? (
              <EmptyState mode={mode} />
            ) : (
              messages.map((m) => <MessageBubble key={m.id} msg={m} />)
            )}
          </div>
        ) : null}

        {mode === 'pipeline' ? (
          <div className="pipeline">
            {stages.length === 0 && messages.length === 0 ? <EmptyState mode={mode} /> : null}
            {messages.map((m) =>
              m.role === 'user' ? <MessageBubble key={m.id} msg={m} /> : null,
            )}
            <div className="pipeline-grid">
              {stages.map((stage) => (
                <section
                  key={`${stage.agent}-${stage.round}`}
                  className={`stage-card ${stage.status}`}
                  style={{ ['--stage' as string]: AGENT_STYLE[stage.agent]?.accent ?? '#7c8cff' }}
                >
                  <header className="stage-head">
                    <span className="stage-dot" />
                    <strong>{AGENT_STYLE[stage.agent]?.name ?? stage.agent}</strong>
                    <span className="stage-role">
                      {stage.agent === 'orchestrator' ? 'Planner' : stage.agent === 'coder' ? 'Implementer' : 'Quality gate'}
                    </span>
                    {stage.round > 1 ? <span className="round-chip">revision {stage.round}</span> : null}
                    <span className={`stage-status st-${stage.status}`}>
                      {stage.status === 'pending' ? 'queued' : stage.status === 'active' ? 'working…' : 'done'}
                    </span>
                  </header>
                  <div className="stage-body">
                    {stage.text ? (
                      <Markdown text={stage.text} />
                    ) : (
                      <span className="muted">{stage.status === 'pending' ? 'Waiting for hand-off' : 'Thinking…'}</span>
                    )}
                    {stage.status === 'active' ? <span className="caret" /> : null}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : null}

        {mode === 'discussion' ? (
          <div className="discussion">
            {turns.length === 0 ? <EmptyState mode={mode} /> : null}
            <div className="turn-list">
              {turns.map((turn, idx) => {
                const style = AGENT_STYLE[turn.agent] ?? { name: turn.name, accent: '#7c8cff' };
                return (
                  <article
                    key={`${turn.agent}-${idx}`}
                    className={`turn ${turn.status}`}
                    style={{ ['--turn' as string]: style.accent }}
                  >
                    <header className="turn-head">
                      <span className="turn-avatar">{style.name.slice(0, 1)}</span>
                      <strong>{turn.name}</strong>
                      <span className="turn-state">{turn.status === 'active' ? 'speaking…' : ''}</span>
                    </header>
                    <div className="turn-body">
                      {turn.text ? <Markdown text={turn.text} /> : <span className="muted">composing…</span>}
                      {turn.status === 'active' ? <span className="caret" /> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="composer">
        {mode === 'discussion' ? (
          <div className="discussion-controls">
            <input
              className="input"
              placeholder="Topic for the agents to discuss, e.g. “Should we cache the D1 reads?”"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void runDiscussion();
                }
              }}
            />
            <label className="rounds">
              <span>{rounds} turns</span>
              <input
                type="range"
                min={2}
                max={12}
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
              />
            </label>
            <button className="btn btn-primary" onClick={() => void runDiscussion()} disabled={busy || !topic.trim()}>
              {busy ? 'Discussing…' : 'Start discussion'}
            </button>
          </div>
        ) : (
          <div className="composer-row">
            <textarea
              className="composer-input"
              rows={2}
              placeholder={
                mode === 'pipeline'
                  ? 'Describe the task — Orchestrator plans, Coder implements, Reviewer audits…'
                  : `Ask Mind Flayer anything${me ? ` · ${me.tag}` : ''}…`
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button
              className="btn btn-primary send-btn"
              onClick={submit}
              disabled={busy || !input.trim()}
            >
              {busy ? '…' : mode === 'pipeline' ? 'Run pipeline' : 'Send'}
            </button>
          </div>
        )}
        <div className="composer-hint">
          {mode === 'pipeline'
            ? 'Runs Orchestrator → Coder → Reviewer, with one automatic revision round if Reviewer returns REVISE.'
            : mode === 'discussion'
              ? 'The three agents talk to each other live — you can watch or add a topic at any time.'
              : 'Enter to send · Shift+Enter for a newline'}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: UiMsg }) {
  const style = AGENT_STYLE[msg.agent ?? 'jarvis'] ?? AGENT_STYLE.jarvis;
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-body">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className="msg assistant" style={{ ['--turn' as string]: style.accent }}>
      <div className="msg-avatar">{style.name.slice(0, 1)}</div>
      <div className="msg-col">
        <div className="msg-name">
          {style.name}
          {msg.agent === 'pipeline' ? <span className="mode-chip mode-pipeline">combined report</span> : null}
        </div>
        <div className="msg-body">
          {msg.content ? <Markdown text={msg.content} /> : null}
          {msg.streaming && !msg.content ? <span className="muted">thinking…</span> : null}
          {msg.streaming ? <span className="caret" /> : null}
          {msg.error ? <span className="msg-error">stream interrupted</span> : null}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ mode }: { mode: Mode }) {
  const copy =
    mode === 'pipeline'
      ? {
          title: 'Three agents, one task',
          body: 'Orchestrator breaks it down, Coder implements, Reviewer audits — streamed stage by stage.',
          cta: 'Try: “Build a rate limiter with a sliding window in TypeScript”',
        }
      : mode === 'discussion'
        ? {
            title: 'Live AI-to-AI discussion',
            body: 'The agents debate each other turn by turn while you watch, or you can drop in a topic.',
            cta: 'Try: “Is D1 or KV better for session storage?”',
          }
        : {
            title: 'What are we building?',
            body: 'Chat with Mind Flayer directly, switch to the pipeline for a full plan → code → review, or open the discussion space.',
            cta: 'Try: “Explain how to stream SSE from a Cloudflare Worker”',
          };
  return (
    <div className="empty-state">
      <div className="empty-mark">J</div>
      <h2>{copy.title}</h2>
      <p className="muted">{copy.body}</p>
      <div className="empty-cta">{copy.cta}</div>
    </div>
  );
}
