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
  APP_ORIGIN: string;
  /** Server-side secret used for password/OTP/PIN hashing, key encryption and cookies. */
  APP_SECRET?: string;
  APP_ENV?: string;
  /**
   * From header for Vecna mail. Must be on a domain verified with the mail
   * provider, e.g. `Vecna from Mind Flayer <vecna@yourdomain.com>`.
   */
  MAIL_FROM?: string;
  /** Optional Vecna-branded mail delivery through a Knock workflow trigger. */
  KNOCK_API_KEY?: string;
  KNOCK_WORKFLOW?: string;
  /** Optional server-wide ElevenLabs key; per-user connector key is preferred. */
  ELEVENLABS_API_KEY?: string;
}

export type RequestUser = {
  /** Primary key: `email:<normalized email>` for every Mind Flayer account. */
  sub: string;
  provider: 'email';
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
  password_hash: string | null;
  pin_hash: string | null;
  theme: string;
  voice_profile: string | null;
  welcomed: number;
  created_at: string;
  last_login_at: string;
};

export type AuthCodeRow = {
  id: string;
  email: string;
  purpose: string;
  code_hash: string;
  password_hash: string | null;
  display_name: string | null;
  attempts: number;
  consumed: number;
  expires_at: string;
  created_at: string;
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
