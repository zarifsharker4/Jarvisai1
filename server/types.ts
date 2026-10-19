/**
 * Structural types for the Cloudflare runtime pieces this project uses.
 * Declared locally so the codebase type-checks against the DOM lib without
 * pulling @cloudflare/workers-types into the same program (they conflict).
 */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(sql: string): Promise<unknown>;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB?: D1Database;
  ASSETS?: Fetcher;
  /** Public, injected on deploy by the platform. */
  FREEBUFF_CLIENT_ID?: string;
  FREEBUFF_ISSUER?: string;
  APP_ORIGIN: string;
  /** Keep TEST builds happy when env names drift. */
  MINDFLOAYER_CLIENT_ID?: string;
  MINDFLOAYER_ISSUER?: string;
  /** Server-side secret used for PIN hashing, connector key encryption and cookies. */
  APP_SECRET?: string;
  APP_ENV?: string;
  /** Optional Mind Flayer branded mail delivery (Knock workflow trigger). */
  KNOCK_API_KEY?: string;
  KNOCK_WORKFLOW?: string;
  /** Optional server-wide ElevenLabs key; per-user connector key is preferred. */
  ELEVENLABS_API_KEY?: string;
}

export type RequestUser = {
  /** Primary key: freebuff `sub`, or `google:<sub>` for Google accounts. */
  sub: string;
  provider: 'freebuff' | 'google';
  email?: string;
  name?: string;
  picture?: string;
};

export type UserRow = {
  sub: string;
  provider: string;
  tag: string;
  display_name: string | null;
  email: string | null;
  picture: string | null;
  pin_hash: string | null;
  theme: string;
  voice_profile: string | null;
  welcomed: number;
  created_at: string;
  last_login_at: string;
};

export type ConnectorRow = {
  id: string;
  user_sub: string;
  provider: string;
  name: string;
  base_url: string | null;
  api_key_enc: string | null;
  model: string | null;
  is_default: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type ChatRow = {
  id: string;
  user_sub: string;
  title: string;
  mode: string;
  locked: number;
  created_at: string;
  updated_at: string;
};
