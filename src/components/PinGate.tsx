import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useApp } from '../state';

/** PIN gate shown whenever chat history is locked. */
export function PinGate() {
  const { pinDialog, closePin, unlock, chatsLocked } = useApp();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!pinDialog && !chatsLocked) return null;
  if (!pinDialog) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlock(pin);
      setPin('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify PIN');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Unlock chat history">
      <form className="modal" onSubmit={submit}>
        <div className="modal-lock" aria-hidden>
          🔒
        </div>
        <h2>Unlock chat history</h2>
        <p className="muted">
          Your history is PIN-protected. Enter your 4-12 digit PIN to decrypt it for this session.
        </p>
        <input
          className="input pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          maxLength={12}
          placeholder="••••"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={closePin}>
            Later
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || pin.length < 4}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
        <p className="muted small">
          The unlock token lasts 12 hours on this device. Closing the tab locks it again.
        </p>
      </form>
    </div>
  );
}
