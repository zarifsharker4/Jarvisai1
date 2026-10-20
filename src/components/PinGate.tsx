import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { useApp } from '../state';
import { VecnaLogo } from './VecnaLogo';

const LENGTH = 4;

/** Archive-style 4-digit PIN gate shown whenever chat history is locked. */
export function PinGate() {
  const { pinDialog, closePin, unlock } = useApp();
  const [digits, setDigits] = useState<string[]>(Array(LENGTH).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const inFlight = useRef(false);

  // Reset and focus whenever the gate opens.
  useEffect(() => {
    if (!pinDialog) return;
    setDigits(Array(LENGTH).fill(''));
    setError(null);
    setBusy(false);
    inFlight.current = false;
    const timer = window.setTimeout(() => inputs.current[0]?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [pinDialog]);

  const submit = useCallback(
    async (pin: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        await unlock(pin);
        setDigits(Array(LENGTH).fill(''));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not verify PIN');
        setShake(true);
        window.setTimeout(() => setShake(false), 420);
        setDigits(Array(LENGTH).fill(''));
        inputs.current[0]?.focus();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [unlock],
  );

  const write = (index: number, raw: string) => {
    const clean = raw.replace(/\D/g, '');
    if (!clean) {
      setDigits((prev) => prev.map((d, i) => (i === index ? '' : d)));
      return;
    }
    // Pasting the whole PIN fills every box at once.
    const next = [...digits];
    let cursor = index;
    for (const ch of clean.slice(0, LENGTH - index)) {
      next[cursor] = ch;
      cursor += 1;
    }
    setDigits(next);
    if (cursor < LENGTH) inputs.current[cursor]?.focus();
    else inputs.current[LENGTH - 1]?.blur();
    const pin = next.join('');
    if (pin.length === LENGTH) void submit(pin);
  };

  const onKeyDown = (index: number, key: string) => {
    if (key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
    if (key === 'ArrowLeft' && index > 0) inputs.current[index - 1]?.focus();
    if (key === 'ArrowRight' && index < LENGTH - 1) inputs.current[index + 1]?.focus();
  };

  if (!pinDialog) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Unlock chat history">
      <div className={`modal pin-modal ${shake ? 'shake' : ''}`}>
        <div className="modal-lock vecna-lock" aria-hidden>
          <VecnaLogo size={40} />
        </div>
        <h2>Unlock the archive</h2>
        <p className="muted">Enter your 4-digit PIN to open chat history for this session.</p>

        <div className={`pin-boxes ${busy ? 'busy' : ''}`}>
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(el) => {
                inputs.current[index] = el;
              }}
              className="pin-box"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label={`PIN digit ${index + 1}`}
              maxLength={LENGTH}
              value={digit}
              disabled={busy}
              onChange={(e) => write(index, e.target.value)}
              onKeyDown={(e) => onKeyDown(index, e.key)}
              onFocus={(e) => e.currentTarget.select()}
            />
          ))}
        </div>

        {error ? <div className="form-error">{error}</div> : null}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={closePin}>
            Later
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || digits.join('').length !== LENGTH}
            onClick={() => void submit(digits.join(''))}
          >
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
        <p className="muted small">
          The unlock lasts 12 hours on this device. Five wrong attempts lock it for 15 minutes.
        </p>
      </div>
    </div>
  );
}
