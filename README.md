# Mind Flayer

A mobile-first AI coding workspace: **Vecna** (the Supreme Guide), a taggable
**AI 1..AI N** pool, a **Hellfire group chat fused with a mobile coding
environment**, multi-project isolation, GitHub push/pull, a community
**Field** marketplace and the **Cerebro** sandboxed app browser — all running
on Cloudflare Workers + D1 with email/password auth.

## The six navigation tabs

| # | Tab | What it does |
|---|-----|--------------|
| 1 | **Vecna Chat** | Continuous Gemini-style thread with Vecna — text, image and file uploads, a dedicated thread per project, and the live **user ↔ Vecna voice call** (Web Speech STT/TTS with an original kids-theme-homework ringtone and config chime, all synthesized via Web Audio). The 3-agent Lab (pipeline / AI↔AI discussion) lives behind a sub-tab. |
| 2 | **Hellfire · Group Chat & File IDE** | The collaborative agent chat **plus** the mobile coding environment: a live **File Tree & File Viewer**, device-folder binding (File System Access API), GitHub pull/edit/push with optional **auto-push on save**, open-file-as-context for the AIs, and a group voice room. Worker AIs (AI 1, AI 2 …) stream their replies tagged by slot. |
| 3 | **API & Field Manager** | Unlimited API keys from any provider (OpenAI-compatible endpoints + Anthropic, xAI, DeepSeek, Groq, Mistral, OpenRouter, Google AI Studio, HuggingFace, custom…), stored AES-GCM encrypted server-side, plus the live **AI 1..AI N field assignment board** (frontend, backend, review, docs, devops …). Vecna's own key lives here too. |
| 4 | **Project Switcher** | Isolated workspaces — each with its own repo/branch, its own AI pool (e.g. 10 AIs per project) and its own dedicated Vecna thread. |
| 5 | **The Field** | Community showcase: publish apps with custom **Cerebro handles** (`1234.3456`), browse, star, copy Cerebro URLs, one-click open in Cerebro. |
| 6 | **Cerebro Search** | In-app browser for community apps: resolve a handle and run the app **read-only** (scripts disabled) or **interactive** (scripts allowed, opaque origin — no cookies, no storage, no path to your backend). |

Navigation is the classic six-button layout: a **sidebar rail** on desktop and
a fixed **bottom bar** on phones (≤980px, where the sidebar collapses and the
Hellfire IDE stacks vertically).

## Architecture

```
src/                     React 19 + Vite SPA (25 themes, dark/crimson)
  components/
    Shell.tsx            6-tab navigation, settings modal, history
    VecnaChat.tsx        Tab 1 — Vecna thread + voice call
    Hellfire.tsx         Tab 2 — group chat + File Tree/Viewer + GitHub
    ApiManager.tsx       Tab 3 — key pool + AI field board
    Projects.tsx         Tab 4 — multi-project switcher
    Field.tsx            Tab 5 — community showcase
    Cerebro.tsx          Tab 6 — sandboxed custom app browser
    Onboarding.tsx       First-login: initialize Vecna with a Gemini key
    Login.tsx            Email + password + 6-digit code
    PinGate.tsx          4-digit archive-style PIN lock
    Call.tsx             Group voice room (3 named agents)
    Settings.tsx         PIN, themes, voices, outbox
  ringtone.ts            Web Audio ringtone + alert synthesis
server/                  Hono Worker (TypeScript)
  app.ts                 Routes + bootstrap manifest
  authz.ts               Sessions, OTP codes, PIN tokens
  vecna.ts               Vecna chat (multimodal) + voice-call turns
  hellfire.ts            Pool resolution + per-slot streaming broadcast
  projects.ts            Projects CRUD + AI slot/field assignments
  field.ts               Marketplace publish/resolve (Cerebro handles)
  github.ts              PAT proxy: tree, file read, atomic multi-file push
  providers.ts           Provider presets, SSE streaming, attachments
  ai.ts                  Legacy pipeline / discussion / group call
  mail.ts                "Vecna from Mind Flayer" branded OTP mail
  schema.ts              Idempotent D1 schema (self-provisioning)
```

### Auth & security

- Email + password accounts in D1; 6-digit OTP delivered by **Vecna from Mind
  Flayer** (dark crimson avatar, casual tone) via the configured mail provider,
  rendered to the outbox when none is set.
- 4-digit **PIN lock** (Archive style) gates chat history — 5 wrong attempts
  lock for 15 minutes; unlock tokens last 12 hours.
- All API keys (providers, Vecna's Gemini key, GitHub PAT) are stored
  **AES-GCM encrypted** in D1 and never returned to the browser. GitHub traffic
  is proxied through the Worker so the PAT never reaches the client.
- Same-origin (CSRF) guards on every mutation; `Cache-Control: private,
  no-store` on personalised responses.

### AI pool model

Connectors are the unlimited key pool. Projects assign connectors to slots —
the slots are the permanent **AI 1, AI 2, AI 3 …** tags — and each slot carries
a **field**. Hellfire broadcasts each human message to every assigned slot and
streams replies independently (`ai`/`token` events per slot). With no keys the
offline **demo engine** answers, clearly labelled, so nothing dead-ends.
Vecna is deliberately separate: its own connector (`is_vecna`), initialized on
first login with a Gemini key.

## Scripts

```bash
npm ci            # install (lockfile preserved)
npm run typecheck # tsc --noEmit
npm test          # vitest — 44 tests (auth, crypto, AI surfaces, projects,
                  #   Vecna, Hellfire, Field/Cerebro, GitHub proxy)
npm run build     # Vite SPA -> build/dist + Worker -> build/worker.js + manifest
npm run dev       # build + wrangler dev on port 3002
```

## Deploy

`wrangler.jsonc` wires the D1 database (`mind-flayer`), assets and vars.
Set `MAIL_FROM` (verified domain), `APP_SECRET` and `KNOCK_API_KEY` for real
mail delivery; everything else self-provisions on first request.
