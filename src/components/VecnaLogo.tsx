import { useId } from 'react';

/**
 * The Mind Flayer sigil: a crimson core ringed by blades, with a slit pupil.
 * Rendered as SVG so it stays sharp at any size and inherits the glow from CSS.
 */
export function VecnaLogo({
  size = 48,
  className = '',
  title = 'Mind Flayer',
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const core = `vecnaCore-${uid}`;
  const halo = `vecnaHalo-${uid}`;
  const blade = `vecnaBlade-${uid}`;

  const blades = Array.from({ length: 8 }, (_, i) => i * 45);

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`vecna-logo ${className}`.trim()}
      role="img"
      aria-label={title}
    >
      <defs>
        <radialGradient id={core} cx="50%" cy="42%" r="62%">
          <stop offset="0%" stopColor="#ff6a7f" />
          <stop offset="38%" stopColor="#ff1e3c" />
          <stop offset="72%" stopColor="#9c0424" />
          <stop offset="100%" stopColor="#37000e" />
        </radialGradient>
        <radialGradient id={halo} cx="50%" cy="50%" r="50%">
          <stop offset="45%" stopColor="#ff1e3c" stopOpacity="0.55" />
          <stop offset="75%" stopColor="#8a0018" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#1a0006" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={blade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff8d7a" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#c2103a" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#4a0012" stopOpacity="0.2" />
        </linearGradient>
      </defs>

      <circle cx="32" cy="32" r="31" fill={`url(#${halo})`} />

      <g className="vecna-blades">
        {blades.map((angle) => (
          <path
            key={angle}
            d="M32 1.5 L35.6 12.4 L32 16 L28.4 12.4 Z"
            fill={`url(#${blade})`}
            transform={`rotate(${angle} 32 32)`}
          />
        ))}
      </g>

      <circle cx="32" cy="31" r="17.5" fill={`url(#${core})`} />
      <circle cx="32" cy="31" r="17.5" fill="none" stroke="#ff3b5c" strokeOpacity="0.55" strokeWidth="0.9" />

      {/* slit pupil — Vecna, not a friendly robot */}
      <ellipse cx="32" cy="31" rx="4" ry="9.5" fill="#fff1f2" fillOpacity="0.94" />
      <ellipse cx="32" cy="31" rx="1.5" ry="7.5" fill="#140005" />
      <ellipse cx="29.4" cy="26.6" rx="1.1" ry="1.9" fill="#ffffff" fillOpacity="0.7" />
    </svg>
  );
}
