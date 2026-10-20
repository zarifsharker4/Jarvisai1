# Mind Flayer

Full-stack, production multi-agent coding workspace: a Cloudflare Worker (Hono)
backend with D1 storage, a React (Vite) frontend, email + password accounts with
6-digit email codes, a 4-digit PIN lock on history, an unlimited API-connector
registry, a 3-agent collaborative pipeline, a live AI-to-AI discussion space and
a group voice call — wrapped in 25 themes.

## Feature map

| Requirement | Where it lives |
| --- | --- |
| Email + password accounts | `POST /api/auth/signup`, `/api/auth/login`, `/api/auth/verify`, `/api/auth/resend`, `/api/auth/signout` (`server/app.ts`). Passwords are PBKDF2-SHA256 hashed; every account gets a unique `@mindflayer-xxxxxx` tag. No third-party identity provider. |
| 6-digit OTP codes | Codes are 6 digits, valid for 10 minutes, single use, hashed at rest, with a 5-guess budget and a 60-second resend cooldown (`server/authz.ts`, `auth_codes` table). |
| "Vecna from Mind Flayer" mail | Every code mail leaves as `Vecna from Mind Flayer <vecna@mindflayer.ai>`, carries the crimson sigil avatar (`/brand/vecna-avatar.png`) and is written in first person, not as a system notice (`server/mail.ts`). |
| 4-digit PIN lock | Exactly 4 digits, PBKDF2 (100k iterations) at rest, 12-hour HMAC unlock token, 423 responses on every history read, 15-minute lockout after 5 wrong attempts (`/api/pin/*`, `/api/chats/*`, `src/components/PinGate.tsx`). |
| Branding | Crimson Vecna/Mind Flayer sigil as the in-app logo, hero, favicon and mail avatar (`src/components/VecnaLogo.tsx`, `public/favicon.svg`, `public/brand/vecna-avatar.png`, regenerable with `node scripts/make-brand-assets.mjs`). |
| Unlimited API connectors | Any number of Google AI Studio / OpenRouter / Groq / Together AI / Mistral / OpenLLM / HuggingFace / custom connectors. Keys are AES-256-GCM encrypted at rest and never returned to the browser (`server/providers.ts`, Settings → API connectors). |
| 3-agent pipeline | Orchestrator → Coder → Reviewer with streamed stage events and one automatic revision round when Reviewer returns `REVISE` (`server/agents.ts`, Chat → 3-Agent Pipeline). |
| Live AI-to-AI discussion | Agents talk to each other turn-by-turn over SSE (`runDiscussion`, Chat → AI ↔ AI Discussion). |
| Call Mind Flayer group voice | Call room UI with per-agent tiles, speech recognition input, keyword/score-based speaker routing, and per-agent voices: ElevenLabs voice ids + speed, browser pitch fallback (`server/voice.ts`, `src/components/Call.tsx`). |
| 25 themes | CSS variable sets switched by `data-theme`, persisted per account (`src/styles.css`, Settings → Appearance). |

## Architecture

```
src/            React 19 + Vite client (chat, discussion, call, settings, themes)
  components/   Login (email → OTP), PinGate (4 boxes), VecnaLogo, Shell, Chat, Call, Settings
server/         Hono app bundled to a single ESM Worker (esbuild)
  index.ts      entry: app -> static assets
  app.ts        email/OTP auth, PIN, connectors, chats, settings, mail routes
  authz.ts      accounts, OTP codes, revocable sessions, PIN tokens
  mail.ts       Vecna-branded mail (code + welcome) and the D1 outbox
  crypto.ts     AES-GCM secrets, PBKDF2 hashing, HMAC tokens, cookies
  ai.ts         chat / pipeline / discussion / call / TTS (SSE + binary)
  agents.ts     the three personas, pipeline, discussion, call routing
  providers.ts  connector registry, OpenAI-compatible client, offline demo engine
  voice.ts      ElevenLabs TTS + voice profiles, browser fallback
  schema.ts     idempotent D1 migrations (executed via D1 batch)
tests/          vitest: crypto units + full HTTP integration over real SQL
build/          deploy output: worker.js + dist assets + manifest.json
```

The app has no hard dependency on any API key: with no connector configured it
runs on a clearly-labelled **offline demo engine**, so every surface stays
usable. Adding a connector switches chat, pipeline, discussion and calls to the
live model.

## Local development

```sh
npm ci            # or npm install
npm run typecheck # tsc --noEmit
npm test          # vitest (crypto + HTTP integration against SQLite)
npm run build     # vite build + esbuild worker + deploy manifest
npm run dev       # build + wrangler dev on http://localhost:3002 (local D1)
```

Without a mail provider key the code is returned in the API response as
`devCode` (outside `APP_ENV=production`) and the full message is stored in
Settings → Mail outbox, so signup works end to end locally.

## Deployment

Built with `npm run build` and published from `build/manifest.json` (ESM Worker
+ static assets, compatibility date `2026-10-19`). Bindings/vars: `DB` (D1),
`APP_SECRET` (HMAC + encryption key), `APP_ORIGIN`, `APP_ENV`, optional
`MAIL_FROM`, and the mail provider secret.

## Configuration you can add later

- **Mail delivery** — set `KNOCK_API_KEY` (and optionally `KNOCK_WORKFLOW`) as a
  Worker secret so Vecna's mail actually leaves; `MAIL_FROM` must be an address
  on a domain verified with the connected provider. Inbox avatars for a new
  sender are chosen by the recipient's mail client (Gravatar/BIMI), which is why
  the sigil also ships inside every message body.
- **Model keys** — Settings → API connectors (any number; AES-GCM at rest).
- **ElevenLabs** — add the `ElevenLabs (voice)` connector for studio voices in
  Call Mind Flayer; otherwise the browser voice (with per-agent pitch) is used.

## Security notes

- Every protected route resolves the account from a signed session cookie whose
  id is stored in D1, so signing out revokes the session server-side instead of
  leaving a valid stateless token behind.
- Email codes are hashed, single-use, expire in 10 minutes and allow 5 guesses;
  the PIN allows 5 guesses before a 15-minute lockout.
- State-changing requests require a same-origin `Origin` (or `Sec-Fetch-Site`)
  and are rejected with 403 otherwise.
- Personalised responses send `Cache-Control: private, no-store`.
- Connector keys are encrypted with AES-256-GCM under `APP_SECRET`; passwords,
  codes and PINs are PBKDF2-hashed (100k iterations, the workerd ceiling);
  session and PIN tokens are HMAC-signed.
