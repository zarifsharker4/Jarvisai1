import { checkPinToken } from './authz';
import { randomId } from './crypto';
import { jsonError } from './http';
import type { ChatRow, Env, UserRow } from './types';

/** Persist one chat message and bump the chat's activity timestamp. */
export async function saveMessage(
  env: Env,
  chatId: string,
  sub: string,
  role: string,
  content: string,
  agent: string | null,
  meta: Record<string, unknown> | null,
): Promise<void> {
  await env.DB!.prepare(
    'INSERT INTO messages (id, chat_id, user_sub, role, agent, content, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(randomId(12), chatId, sub, role, agent, content, meta ? JSON.stringify(meta) : null)
    .run();
  await env.DB!.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?1")
    .bind(chatId)
    .run();
}

/** Create a chat row, optionally scoped to a project. */
export async function createChat(
  env: Env,
  sub: string,
  title: string,
  mode: string,
  projectId: string | null = null,
): Promise<string> {
  const id = randomId(12);
  await env.DB!.prepare(
    'INSERT INTO chats (id, user_sub, title, mode, project_id) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(id, sub, title.slice(0, 80), mode, projectId)
    .run();
  return id;
}

/**
 * PIN gate for touching an existing chat when history is locked.
 * Returns a ready-to-send error response, or null when access is allowed.
 */
export async function unlockCheck(
  env: Env,
  user: UserRow,
  chatId: string,
  header: string | undefined,
): Promise<Response | null> {
  const chat = await env.DB!.prepare('SELECT * FROM chats WHERE id = ?1 AND user_sub = ?2')
    .bind(chatId, user.sub)
    .first<ChatRow>();
  if (!chat) return jsonError('Chat not found', 404);
  if (user.pin_hash || chat.locked) {
    const ok = await checkPinToken(env, header, user.sub);
    if (!ok) {
      return jsonError('PIN required to unlock chat history', 423, { reason: 'pin_required' });
    }
  }
  return null;
}
