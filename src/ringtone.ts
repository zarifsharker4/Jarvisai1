/**
 * Ringtone + alert audio for the Vecna voice call, synthesized live with the
 * Web Audio API — no assets needed, works offline.
 *
 * `playRingtone` is an original 80s-analog-style homage in the spirit of the
 * Stranger Things kids theme (pulsing saw bass under a brooding minor
 * arpeggio) written from scratch for this app; `playConfigAlert` is a short
 * two-tone chime for configuration warnings (e.g. Vecna has no API key yet).
 */

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Pulse notes: low brooding root pulse + minor arpeggio (E minor register). */
const PULSE_HZ = 82.41; // E2 — the heartbeat pulse
const ARP_HZ = [164.81, 196.0, 246.94, 196.0]; // E3 G3 B3 G3 — the kids-theme mood

export type RingHandle = { stop: () => void };

/**
 * Loop the ringtone until stop() is called. Used while the call is ringing
 * and for incoming configuration alerts that should feel impossible to ignore.
 */
export function playRingtone(options: { loop?: boolean } = {}): RingHandle {
  const ac = audio();
  if (!ac) return { stop: () => undefined };
  const loop = options.loop !== false;
  const master = ac.createGain();
  master.gain.value = 0.18;
  master.connect(ac.destination);

  let step = 0;
  let timer: number | null = null;
  let stopped = false;

  const hit = () => {
    if (stopped) return;
    const now = ac.currentTime;

    // Pulsing saw bass — the countdown feeling.
    const bass = ac.createOscillator();
    const bassGain = ac.createGain();
    bass.type = 'sawtooth';
    bass.frequency.value = PULSE_HZ;
    bassGain.gain.setValueAtTime(0.0001, now);
    bassGain.gain.exponentialRampToValueAtTime(0.7, now + 0.02);
    bassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    bass.connect(bassGain).connect(master);
    bass.start(now);
    bass.stop(now + 0.45);

    // Arpeggio pluck every beat.
    const lead = ac.createOscillator();
    const leadGain = ac.createGain();
    lead.type = 'triangle';
    lead.frequency.value = ARP_HZ[step % ARP_HZ.length];
    leadGain.gain.setValueAtTime(0.0001, now + 0.04);
    leadGain.gain.exponentialRampToValueAtTime(0.4, now + 0.07);
    leadGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    lead.connect(leadGain).connect(master);
    lead.start(now + 0.04);
    lead.stop(now + 0.6);

    step += 1;
    if (loop || step < 6) {
      timer = window.setTimeout(hit, 620);
    }
  };

  hit();
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      try {
        master.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}

/** Short two-tone chime: a configuration alert, not an error buzz. */
export function playConfigAlert(): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const master = ac.createGain();
  master.gain.value = 0.16;
  master.connect(ac.destination);
  [523.25, 698.46].forEach((hz, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const start = now + i * 0.16;
    osc.type = 'square';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + 0.32);
  });
}

/** Single soft blip for call connect / disconnect. */
export function playCallTone(kind: 'connect' | 'disconnect'): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(kind === 'connect' ? 440 : 330, now);
  if (kind === 'connect') osc.frequency.exponentialRampToValueAtTime(660, now + 0.18);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.38);
}
