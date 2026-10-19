import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../state';
import { THEMES } from './Shell';
import type { AgentId, Connector, MailItem, ProviderPreset } from '../types';

type AuthSettings = {
  freebuff: { enabled: boolean; issuer: string | null };
  google: { configured: boolean; clientId: string | null };
  session: { origin: string };
};

type VoiceResponse = {
  agents: Array<{ id: AgentId; name: string; voice: import('../types').VoiceProfile }>;
  catalogue: { ok: boolean; voices: Array<{ voiceId: string; name: string }>; detail?: string };
  note?: string;
};

/** Settings: account + theme (25 themes), PIN lock, the unlimited API connector registry,
 * per-agent voices, Google OAuth credentials, and the branded mail outbox. */
export function Settings() {
  const { me, patchMe, bootstrap, theme, setTheme, requestUnlock } = useApp();
  const [section, setSection] = useState<'account' | 'security' | 'connectors' | 'voice' | 'auth' | 'mail'>('account');

  return (
    <div className="settings">
      <header className="settings-head">
        <h2>Settings</h2>
        <nav className="subtabs" aria-label="Settings sections">
          {(
            [
              ['account', 'Account'],
              ['security', 'PIN lock'],
              ['connectors', 'API connectors'],
              ['voice', 'Voice'],
              ['auth', 'Authentication'],
              ['mail', 'Mail outbox'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`subtab ${section === id ? 'active' : ''}`}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {section === 'account' ? (
        <section className="panel">
          <h3>Account</h3>
          <div className="kv">
            <div><span className="k">Unique tag</span><span className="v mono">{me?.tag}</span></div>
            <div><span className="k">Signed in with</span><span className="v">{me?.provider === 'google' ? 'Google' : 'Mind Flayer'}</span></div>
            <div><span className="k">Email</span><span className="v">{me?.email ?? '—'}</span></div>
            <div><span className="k">Account ID</span><span className="v mono small">{me?.sub}</span></div>
            <div><span className="k">Member since</span><span className="v">{me?.createdAt?.slice(0, 10) ?? '—'}</span></div>
          </div>
          <NameForm current={me?.displayName ?? ''} onSave={(displayName) => patchMe({ displayName })} />
          <h3>Appearance</h3>
          <div className="theme-cards" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-card ${theme === t.id ? 'active' : ''}`}
                onClick={() => setTheme(t.id)}
                role="radio"
                aria-checked={theme === t.id}
              >
                <span className={`theme-preview tp-${t.id}`} />
                <span className="theme-card-label">{t.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {section === 'security' ? <PinSection requestUnlock={requestUnlock} /> : null}
      {section === 'connectors' ? <ConnectorSection /> : null}
      {section === 'voice' ? <VoiceSection providers={bootstrap?.providers ?? []} /> : null}
      {section === 'auth' ? <AuthSection /> : null}
      {section === 'mail' ? <MailSection /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function NameForm({ current, onSave }: { current: string; onSave: (name: string) => void }) {
  const [value, setValue] = useState(current);
  const [saved, setSaved] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api('/api/me', { method: 'PATCH', body: { displayName: value } });
      onSave(value.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <label className="field">
        <span>Display name</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={60} />
      </label>
      <button className="btn btn-ghost" type="submit">Save</button>
      {saved ? <span className="saved-dot">saved</span> : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */

function PinSection({ requestUnlock }: { requestUnlock: () => void }) {
  const { me, patchMe } = useApp();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = Boolean(me?.pinEnabled);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api('/api/pin/set', { method: 'POST', body: { pin } });
      patchMe({ pinEnabled: true });
      setPin('');
      setMessage('PIN set — chat history is now locked behind it.');
      requestUnlock();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not set PIN');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/pin/disable', { method: 'POST', body: { pin } });
      patchMe({ pinEnabled: false });
      setPin('');
      setMessage('PIN removed — history is open again.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove PIN');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h3>PIN lock</h3>
      <p className="muted">
        A PIN hashes with PBKDF2 (120k iterations) on the server and gates every read of your chat history.
        Unlocking issues a 12-hour session token on this device.
      </p>
      <div className="kv">
        <div>
          <span className="k">Status</span>
          <span className={`v ${enabled ? 'ok' : ''}`}>{enabled ? '🔒 Locked' : 'Unlocked'}</span>
        </div>
      </div>
      <form className="inline-form" onSubmit={enabled ? (e) => { e.preventDefault(); void disable(); } : submit}>
        <label className="field">
          <span>{enabled ? 'Enter current PIN to remove' : 'Choose a PIN (4-12 digits)'}</span>
          <input
            className="input pin-input"
            type="password"
            inputMode="numeric"
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\\D/g, ''))}
            placeholder="••••"
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || pin.length < 4}>
          {enabled ? 'Remove PIN' : 'Set PIN'}
        </button>
      </form>
      {enabled ? (
        <button className="btn btn-ghost btn-sm" onClick={requestUnlock}>
          Unlock history now
        </button>
      ) : null}
      {message ? <div className="inline-note">{message}</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ConnectorSection() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [providers, setProviders] = useState<ProviderPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    provider: 'openrouter',
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    isDefault: false,
  });

  const refresh = useCallback(async () => {
    try {
      const [list, providerList] = await Promise.all([
        api<{ connectors: Connector[] }>('/api/connectors'),
        api<{ providers: ProviderPreset[] }>('/api/providers'),
      ]);
      setConnectors(list.connectors);
      setProviders(providerList.providers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load connectors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const preset = providers.find((p) => p.id === form.provider);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api('/api/connectors', {
        method: 'POST',
        body: {
          provider: form.provider,
          name: form.name || undefined,
          baseUrl: form.baseUrl || undefined,
          apiKey: form.apiKey || undefined,
          model: form.model || undefined,
          isDefault: form.isDefault,
        },
      });
      setForm({ provider: form.provider, name: '', baseUrl: '', apiKey: '', model: '', isDefault: false });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add connector');
    }
  };

  const test = async (id: string) => {
    setStatus((s) => ({ ...s, [id]: 'testing…' }));
    try {
      const res = await api<{ ok: boolean; detail: string }>(`/api/connectors/${id}/test`, { method: 'POST', body: {} });
      setStatus((s) => ({ ...s, [id]: `${res.ok ? '✓' : '✗'} ${res.detail}` }));
    } catch (err) {
      setStatus((s) => ({ ...s, [id]: `✗ ${err instanceof ApiError ? err.message : 'failed'}` }));
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/connectors/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  };

  const toggleDefault = async (c: Connector) => {
    try {
      await api(`/api/connectors/${c.id}`, { method: 'PUT', body: { isDefault: !c.isDefault, enabled: c.enabled } });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update');
    }
  };

  return (
    <section className="panel">
      <h3>API connectors</h3>
      <p className="muted">
        Unlimited connectors — add as many accounts as you like. Keys are encrypted with AES-256-GCM using your
        deployment secret and are never returned to the browser. The default connector powers chat, the pipeline,
        the discussion and calls.
      </p>

      <div className="connector-list">
        {loading ? <div className="muted">Loading…</div> : null}
        {!loading && connectors.length === 0 ? (
          <div className="empty-hint">
            No connectors yet — the app is running on the labelled offline demo engine. Add a key below for live
            model output.
          </div>
        ) : null}
        {connectors.map((c) => (
          <div key={c.id} className={`connector ${c.enabled ? '' : 'disabled'}`}>
            <div className="connector-main">
              <div className="connector-title">
                <strong>{c.name}</strong>
                <span className="mode-chip">{c.providerLabel}</span>
                {c.isDefault ? <span className="badge badge-ok">default</span> : null}
                {!c.hasKey ? <span className="badge badge-warn">no key</span> : null}
              </div>
              <div className="connector-meta mono">
                {c.baseUrl ?? '—'} · {c.model ?? 'default model'} · {c.keyHint}
              </div>
              {status[c.id] ? <div className="connector-test">{status[c.id]}</div> : null}
            </div>
            <div className="connector-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => void test(c.id)}>Test</button>
              <button className="btn btn-ghost btn-sm" onClick={() => void toggleDefault(c)}>
                {c.isDefault ? 'Unset default' : 'Make default'}
              </button>
              <button className="btn btn-ghost btn-sm danger" onClick={() => void remove(c.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <h4>Add connector</h4>
      <form className="connector-form" onSubmit={add}>
        <label className="field">
          <span>Provider</span>
          <select
            className="input select"
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value, baseUrl: '', model: '' })}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}{p.kind === 'tts' ? ' · voice' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            placeholder={preset?.label ?? 'My connector'}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Base URL {preset?.local ? '(local server)' : ''}</span>
          <input
            className="input mono"
            placeholder={preset?.baseUrl || 'https://your-endpoint/v1'}
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
        </label>
        <label className="field">
          <span>API key {preset?.local ? '(optional for local servers)' : ''}</span>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            placeholder={preset?.keyHint ?? 'sk-…'}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Model</span>
          <input
            className="input mono"
            placeholder={preset?.defaultModel ?? 'model-id'}
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
          />
          Use as default engine
        </label>
        <div className="form-row">
          <button className="btn btn-primary" type="submit">
            Add connector
          </button>
          {preset ? (
            <a className="btn btn-ghost btn-sm" href={preset.docs} target="_blank" rel="noreferrer noopener">
              Get a {preset.label} key ↗
            </a>
          ) : null}
        </div>
        {preset?.note ? <p className="muted small">{preset.note}</p> : null}
      </form>
      {error ? <div className="form-error">{error}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function VoiceSection({ providers }: { providers: ProviderPreset[] }) {
  const { me, patchMe } = useApp();
  const [data, setData] = useState<VoiceResponse | null>(null);
  const [saved, setSaved] = useState(false);
  const eleven = providers.find((p) => p.id === 'elevenlabs');

  const voices: Record<AgentId, import('../types').VoiceProfile> = {
    orchestrator: me?.voiceProfile?.orchestrator ?? defaultVoice('orchestrator'),
    coder: me?.voiceProfile?.coder ?? defaultVoice('coder'),
    reviewer: me?.voiceProfile?.reviewer ?? defaultVoice('reviewer'),
  };

  useEffect(() => {
    void api<VoiceResponse>('/api/voice').then(setData).catch(() => setData(null));
  }, []);

  const update = (agent: AgentId, patch: Partial<import('../types').VoiceProfile>) => {
    const next = { ...voices, [agent]: { ...voices[agent], ...patch } };
    patchMe({ voiceProfile: next });
    void api('/api/me', { method: 'PATCH', body: { voiceProfile: next } }).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  };

  return (
    <section className="panel">
      <h3>Voice — Call Mind Flayer</h3>
      <p className="muted">
        {data?.note ??
          'Each agent has its own voice: ElevenLabs voice id plus speed, and a browser pitch used by the fallback engine.'}
      </p>

      <div className="voice-grid">
        {(data?.agents ?? []).map((agent) => {
          const v = voices[agent.id] ?? agent.voice;
          return (
            <div key={agent.id} className="voice-card" style={{ ['--voice' as string]: agent.name ? '#7c8cff' : '#7c8cff' }}>
              <div className="voice-head">
                <strong>{agent.name}</strong>
                <span className="muted small">{agent.id}</span>
              </div>
              <label className="field">
                <span>ElevenLabs voice</span>
                <select
                  className="input select mono"
                  value={v.elevenVoiceId}
                  onChange={(e) => {
                    const picked = data?.catalogue.voices.find((x) => x.voiceId === e.target.value);
                    update(agent.id, {
                      elevenVoiceId: e.target.value,
                      elevenLabel: picked?.name ?? v.elevenLabel,
                    });
                  }}
                >
                  <option value={v.elevenVoiceId}>{v.elevenLabel} · {v.elevenVoiceId}</option>
                  {(data?.catalogue.voices ?? [])
                    .filter((x) => x.voiceId !== v.elevenVoiceId)
                    .map((x) => (
                      <option key={x.voiceId} value={x.voiceId}>
                        {x.name} · {x.voiceId}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <span>Browser pitch — {v.pitch.toFixed(2)}</span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={v.pitch}
                  onChange={(e) => update(agent.id, { pitch: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                <span>Speed — {v.rate.toFixed(2)}×</span>
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.02}
                  value={v.rate}
                  onChange={(e) => update(agent.id, { rate: Number(e.target.value) })}
                />
              </label>
            </div>
          );
        })}
      </div>

      <div className="form-row">
        <span className={`badge ${data?.catalogue?.ok ? 'badge-ok' : 'badge-warn'}`}>
          {data?.catalogue?.ok
            ? `${data.catalogue.voices.length} ElevenLabs voices loaded`
            : `ElevenLabs: ${data?.catalogue?.detail ?? 'browser fallback active'}`}
        </span>
        {saved ? <span className="saved-dot">saved</span> : null}
      </div>
      {eleven ? (
        <p className="muted small">
          Add an ElevenLabs key under API connectors (provider "ElevenLabs (voice)") to enable studio voices.
        </p>
      ) : null}
    </section>
  );
}

function defaultVoice(agent: AgentId): import('../types').VoiceProfile {
  const map: Record<AgentId, import('../types').VoiceProfile> = {
    orchestrator: { elevenVoiceId: '21m00Tcm4TlvDq8ikWAM', elevenLabel: 'Rachel (warm, clear)', pitch: 1.08, rate: 1 },
    coder: { elevenVoiceId: 'TxGEqnHWrfWFTfGW9XjX', elevenLabel: 'Josh (bright, quick)', pitch: 1.2, rate: 1.06 },
    reviewer: { elevenVoiceId: 'pNInz6obpgDQGcFmaJgB', elevenLabel: 'Adam (deep, measured)', pitch: 0.82, rate: 0.95 },
  };
  return map[agent];
}

/* ------------------------------------------------------------------ */

function AuthSection() {
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<AuthSettings>('/api/settings/auth')
      .then((s) => {
        setSettings(s);
        setClientId(s.google.clientId ?? '');
      })
      .catch(() => undefined);
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api('/api/settings/google', {
        method: 'POST',
        body: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      });
      setClientSecret('');
      setMessage('Google OAuth saved — the "Sign in with Google" button is now live on the sign-in screen.');
      setSettings((s) => (s ? { ...s, google: { configured: true, clientId: clientId.trim() } } : s));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save credentials');
    }
  };

  return (
    <section className="panel">
      <h3>Authentication</h3>
      <div className="kv">
        <div>
          <span className="k">Sign in with Mind Flayer</span>
          <span className={`v ${settings?.freebuff.enabled ? 'ok' : ''}`}>
            {settings?.freebuff.enabled ? '✓ enabled' : 'checking…'}
          </span>
        </div>
        <div>
          <span className="k">Google OAuth</span>
          <span className={`v ${settings?.google.configured ? 'ok' : ''}`}>
            {settings?.google.configured ? `✓ configured (${settings.google.clientId})` : 'not configured'}
          </span>
        </div>
        <div>
          <span className="k">Canonical origin</span>
          <span className="v mono small">{settings?.session.origin ?? '—'}</span>
        </div>
      </div>

      <p className="muted">
        Google sign-in uses the authorization-code flow with PKCE-free state verification on this server. Create an
        OAuth client (Web) in Google Cloud Console with callback
        <code className="inline-code"> {settings?.session.origin ?? ''}/auth/google/callback</code>, then paste the
        credentials below. They are stored encrypted and never sent to the browser.
      </p>

      <form className="connector-form" onSubmit={save}>
        <label className="field">
          <span>Google OAuth client ID</span>
          <input
            className="input mono"
            placeholder="1234567890-abc.apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Google OAuth client secret</span>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            placeholder="GOCSPX-…"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </label>
        <div className="form-row">
          <button className="btn btn-primary" type="submit" disabled={!clientId.trim()}>
            Save Google credentials
          </button>
        </div>
      </form>
      {message ? <div className="inline-note">{message}</div> : null}
      {error ? <div className="form-error">{error}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function MailSection() {
  const [emails, setEmails] = useState<MailItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ emails: MailItem[] }>('/api/outbox')
      .then((r) => setEmails(r.emails))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load outbox'));
  }, []);

  return (
    <section className="panel">
      <h3>Branded mail outbox</h3>
      <p className="muted">
        Every branded message Mind Flayer composes for your account lands here — from{' '}
        <em>Mind Flayer &lt;mind@mindflayer.ai&gt;</em>.
        Delivery through your configured provider is recorded automatically; without a provider the message stays
        rendered here.
      </p>
      {error ? <div className="form-error">{error}</div> : null}
      {emails.length === 0 && !error ? <div className="empty-hint">No mail yet — your welcome email appears here after first sign-in.</div> : null}
      <div className="mail-list">
        {emails.map((mail) => (
          <div key={mail.id} className="mail">
            <button className="mail-row" onClick={() => setOpen(open === mail.id ? null : mail.id)}>
              <span className="mail-subject">{mail.subject}</span>
              <span className="mail-meta">
                <span className={`badge ${mail.status === 'sent' ? 'badge-ok' : mail.status === 'failed' ? 'badge-danger' : 'badge-warn'}`}>
                  {mail.status}
                </span>
                <span className="muted small">{mail.created_at.slice(0, 16)}</span>
              </span>
            </button>
            <div className="mail-from muted small">
              {mail.from_email} → {mail.to_email}
              {mail.error ? ` · ${mail.error}` : ''}
            </div>
            {open === mail.id ? (
              <iframe className="mail-preview" title={mail.subject} sandbox="" srcDoc={mail.html} />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
