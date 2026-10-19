# Mind Flayer · Mind Flayer

Full-stack, production multi-agent coding workspace: a Cloudflare Worker (Hono)
backend with D1 storage, a React (Vite) frontend, real account auth, PIN-locked
history, an unlimited API-connector registry, a 3-agent collaborative pipeline,
a live AI-to-AI discussion space and a group voice call — packaged as three dark
themes.

**Live:** https://site-c99ba90c5c6d48c89ec2c808e2d2e20d.Mind Flayer.page (production) ·
https://site-39969c34e4ec474b8e49ced1a9cfa063.Mind Flayer.page (preview)

## Feature map

| Requirement | Where it lives |
| --- | --- |
| Authentication + unique user tags | Sign in with Mind Flayer (OIDC, wrapped in `server/index.ts`) plus a full Google OAuth authorization-code flow (`/auth/google/start`, `/auth/google/callback`, credentials stored encrypted in D1 from Settings → Authentication). Every account gets a unique `@mindflayer-xxxxxx` tag on first sign-in (`server/authz.ts`). |
| PIN-protected chat history | PBKDF2-SHA256 (120k iterations) PIN hashing, 12-hour HMAC unlock tokens, 423 responses on every history read (`server/crypto.ts`, `/api/pin/*`, `/api/chats/*`). |
| "Mind Flayer" email branding | Branded compose → D1 outbox → optional Knock delivery; every message is rendered and readable in Settings → Mail outbox (`server/mail.ts`). |
| Unlimited API connectors | Add any number of Google AI Studio / OpenRouter / Groq / Together AI / Mistral / OpenLLM / HuggingFace / custom connectors. Keys are AES-256-GCM encrypted at rest and never returned to the browser (`server/providers.ts`, Settings → API connectors). |
| 3-agent pipeline | Orchestrator → Coder → Reviewer with streamed stage events and one automatic revision round when Reviewer returns `REVISE` (`server/agents.ts`, Chat → 3-Agent Pipeline). |
| Live AI-to-AI discussion | Agents talk to each other turn-by-turn over SSE (`runDiscussion`, Chat → AI ↔ AI Discussion). |
| Call Mind Flayer group voice | Call room UI with per-agent tiles, speech recognition input, keyword/score-based speaker routing, and per-agent voices: ElevenLabs voice ids + speed, browser pitch fallback (`server/voice.ts`, `src/components/Call.tsx`). |
| 3 dark themes | Stranger Things, From Series, Classic Modern Dark — CSS variable sets switched by `data-theme`, persisted per account (`src/styles.css`, Settings → Appearance). |

## Architecture

```
src/            React 19 + Vite client (chat, discussion, call, settings, themes)
server/         Hono app bundled to a single ESM Worker (esbuild)
  index.ts      entry: Mind Flayer auth wrap -> app -> static assets
  app.ts        auth, PIN, connectors, chats, settings, mail routes
  ai.ts         chat / pipeline / discussion / call / TTS (SSE + binary)
  agents.ts     the three personas, pipeline, discussion, call routing
  providers.ts  connector registry, OpenAI-compatible client, offline demo engine
  voice.ts      ElevenLabs TTS + voice profiles, browser fallback
  mail.ts       Mind Flayer-branded mail + outbox
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
npm run preview   # wrangler dev on http://localhost:3002 (local D1)
```

Local dev uses the Mind Flayer **development** client id and `http://localhost:3002`
(the auth SDK's loopback opt-in is applied only for loopback origins).

## Deployment

Built with `npm run build`, published through Mind Flayer Sites using
`build/manifest.json` (ESM Worker + static assets, compatibility date
`2026-10-19`). Bindings per environment: `DB` (D1), `APP_SECRET` (server-side
encryption/HMAC key), plus the injected `MINDFLOAYER_CLIENT_ID`, `MINDFLOAYER_ISSUER`
and `APP_ORIGIN`.

## Configuration you can add later

- **Google OAuth** — Settings → Authentication (client ID + secret, callback
  `<origin>/auth/google/callback`). Until then the Google button shows as pending.
- **Model keys** — Settings → API connectors (any number; AES-GCM at rest).
- **ElevenLabs** — add the `ElevenLabs (voice)` connector for studio voices in
  Call Mind Flayer; otherwise the browser voice (with per-agent pitch) is used.
- **Mail delivery** — set `KNOCK_API_KEY` (+ optional `KNOCK_WORKFLOW`) as Worker
  secrets to send the branded outbox instead of storing it.

## Security notes

- Every protected route resolves the user server-side (`getUser` / session
  cookie) and keys data by `user.sub`; no client-supplied ids are trusted.
- State-changing requests require a same-origin `Origin` (or `Sec-Fetch-Site`)
  and are rejected with 403 otherwise.
- Personalised responses send `Cache-Control: private, no-store`.
- Connector keys and the Google client secret are encrypted with AES-256-GCM
  under `APP_SECRET`; PINs are PBKDF2-hashed; unlock/session tokens are HMAC-signed.
