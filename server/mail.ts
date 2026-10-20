import { randomId } from './crypto';
import type { D1Database, Env, UserRow } from './types';

/**
 * Vecna mail.
 *
 * Every message leaves as "Vecna from Mind Flayer" and reads like a person
 * wrote it, not like a system notice. Messages are always composed and stored
 * in the outbox with the Vecna identity, then handed to the configured
 * provider (Knock workflow trigger) when a key is present. Without a key the
 * message stays fully rendered in Settings -> Outbox so nothing is lost, and
 * the API tells the caller delivery was not possible.
 */
export const VECNA_SENDER_NAME = 'Vecna from Mind Flayer';
export const VECNA_SENDER_ADDRESS = 'vecna@mindflayer.ai';
export const VECNA_REPLY_TO = 'vecna@mindflayer.ai';

/** From header, overridable per deployment because providers require a verified domain. */
export function mailFrom(env: Env): string {
  return env.MAIL_FROM?.trim() || `${VECNA_SENDER_NAME} <${VECNA_SENDER_ADDRESS}>`;
}

/** Dark Vecna sigil used as the sender avatar inside every mail body. */
export function avatarUrl(env: Env): string {
  return `${env.APP_ORIGIN.replace(/\/+$/, '')}/brand/vecna-avatar.png`;
}

export type BrandedMail = {
  to: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  code?: string;
  ctaLabel?: string;
  ctaHref?: string;
  footer?: string;
};

const BG = '#07050a';
const PANEL = '#12070d';
const EDGE = '#2a0f1c';
const TEXT = '#c9b9c4';
const BRIGHT = '#f6eef3';
const CRIMSON = '#ff2d4b';

function shell(env: Env, mail: BrandedMail): string {
  const cta =
    mail.ctaLabel && mail.ctaHref
      ? `<p style="margin:26px 0"><a href="${mail.ctaHref}" style="background:#1c0810;border:1px solid #5a1026;color:${BRIGHT};padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${mail.ctaLabel}</a></p>`
      : '';
  const code = mail.code
    ? `<div style="margin:24px 0;padding:18px 20px;background:#180910;border:1px solid #5a1026;border-radius:12px;text-align:center">
         <div style="font-size:34px;letter-spacing:.42em;font-weight:700;color:${BRIGHT};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${mail.code}</div>
       </div>`
    : '';
  const body = mail.paragraphs
    .map((p) => `<p style="margin:14px 0;color:${TEXT};line-height:1.65;font-size:15px">${p}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:${BG};padding:28px 16px;font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:${PANEL};border:1px solid ${EDGE};border-radius:18px;padding:30px 28px">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>
      <td style="padding-right:14px"><img src="${avatarUrl(env)}" width="52" height="52" alt="Vecna" style="display:block;border-radius:50%;border:1px solid #5a1026"></td>
      <td>
        <div style="font-size:15px;color:${BRIGHT};font-weight:700">Vecna from Mind Flayer</div>
        <div style="font-size:12px;color:#8b7480;letter-spacing:.06em">vecna@mindflayer.ai</div>
      </td>
    </tr></table>
    <h1 style="font-size:22px;margin:8px 0 4px;color:${BRIGHT};font-weight:700">${mail.heading}</h1>
    ${code}
    ${body}
    ${cta}
    <hr style="border:none;border-top:1px solid ${EDGE};margin:24px 0 14px">
    <div style="font-size:12px;color:#6d5a66;line-height:1.6">${mail.footer ?? `Sent by ${VECNA_SENDER_NAME}. Reply and it comes straight back to me.`}</div>
    <div style="font-size:11px;color:#4d3f49;margin-top:8px;letter-spacing:.14em;text-transform:uppercase">Mind Flayer · ${CRIMSON === '#ff2d4b' ? 'the archive' : 'the archive'}</div>
  </div>
</body></html>`;
}

function plain(env: Env, mail: BrandedMail): string {
  const lines = [mail.heading, ''];
  if (mail.code) lines.push(`Code: ${mail.code}`, '');
  lines.push(...mail.paragraphs);
  if (mail.ctaLabel && mail.ctaHref) lines.push('', `${mail.ctaLabel}: ${mail.ctaHref}`);
  lines.push('', `— ${VECNA_SENDER_NAME}`, VECNA_SENDER_ADDRESS, `Reply-to ${VECNA_REPLY_TO}`);
  void env;
  return lines.join('\n');
}

type Delivery = { id: string; status: string; provider: string; error?: string };

/**
 * Store the rendered message in the outbox and hand it to the provider.
 * `status` is `sent` only when the provider accepted it; `outbox` means it is
 * stored and readable but no mail left the building.
 */
async function deliver(
  env: Env,
  db: D1Database,
  userSub: string | null,
  mail: BrandedMail,
): Promise<Delivery> {
  const id = randomId(12);
  const from = mailFrom(env);
  const html = shell(env, mail);
  const bodyText = plain(env, mail);
  let status = 'outbox';
  let provider = 'outbox';
  let error: string | undefined;

  await db
    .prepare(
      `INSERT INTO outbox (id, user_sub, to_email, from_email, subject, html, body_text, status, provider)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(id, userSub, mail.to, from, mail.subject, html, bodyText, status, provider)
    .run();

  if (env.KNOCK_API_KEY) {
    provider = 'knock';
    try {
      const res = await fetch(
        `https://api.knock.app/v1/workflows/${encodeURIComponent(env.KNOCK_WORKFLOW || 'mindflayer-email')}/trigger`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.KNOCK_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            // The actor carries the sender identity so the Knock workflow can
            // render it as the From name and avatar.
            actor: 'vecna',
            recipients: [{ id: userSub || mail.to, data: { email: mail.to } }],
            data: {
              email: mail.to,
              from,
              from_name: VECNA_SENDER_NAME,
              from_avatar: avatarUrl(env),
              reply_to: VECNA_REPLY_TO,
              subject: mail.subject,
              heading: mail.heading,
              paragraphs: mail.paragraphs,
              code: mail.code ?? null,
              html,
              text: bodyText,
            },
          }),
        },
      );
      if (res.ok) {
        status = 'sent';
        await db
          .prepare("UPDATE outbox SET status = 'sent', provider = 'knock', sent_at = datetime('now') WHERE id = ?1")
          .bind(id)
          .run();
      } else {
        status = 'failed';
        error = `Knock HTTP ${res.status}`;
        await db
          .prepare("UPDATE outbox SET status = 'failed', provider = 'knock', error = ?2 WHERE id = ?1")
          .bind(id, error)
          .run();
      }
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
      await db
        .prepare("UPDATE outbox SET status = 'failed', provider = 'knock', error = ?2 WHERE id = ?1")
        .bind(id, error)
        .run();
    }
  }

  return { id, status, provider, error };
}

/**
 * The 6-digit code mail. Casual, first person, no robot boilerplate — Vecna
 * writes like someone texting you a code they just generated.
 */
export async function sendVecnaCode(
  env: Env,
  db: D1Database,
  to: string,
  code: string,
  purpose: 'signup' | 'login',
  userSub: string | null = null,
): Promise<Delivery> {
  const opening =
    purpose === 'signup'
      ? 'So you want in. Fine — I saved you a seat.'
      : 'You came back. I noticed.';
  return deliver(env, db, userSub, {
    to,
    subject: `${code} is your code — don't share it`,
    heading: "Hey, it's Vecna.",
    code,
    paragraphs: [
      `${opening} Here is your 6-digit code — it is good for the next 10 minutes, then it burns.`,
      "If you didn't ask for this, just ignore it. No worries, no harm done — nothing happens to your account.",
      "Don't forward this to anyone. Not even someone who says they're me.",
      'Talk soon.',
    ],
    footer: 'Sent by Vecna from Mind Flayer. Reply and it comes straight back to me.',
  });
}

/** One-time branded welcome mail carrying the user's unique tag. */
export async function sendWelcome(env: Env, db: D1Database, user: UserRow): Promise<void> {
  if (user.welcomed) return;
  const to = user.email || 'there';
  await deliver(env, db, user.sub, {
    to,
    subject: `Welcome in, ${user.tag}`,
    heading: `Your tag is ${user.tag}`,
    paragraphs: [
      `I set up your workspace, ${user.display_name || 'friend'}. Took me about a second.`,
      `Your tag <strong>${user.tag}</strong> is how I know you across chats, the 3-agent pipeline, the discussion room and Call Mind Flayer.`,
      'Lock your history with a 4-digit PIN in Settings if you want it private from prying eyes. I would.',
    ],
    ctaLabel: 'Open Mind Flayer',
    ctaHref: env.APP_ORIGIN,
    footer: `Sent by Vecna for ${user.tag}. This mailbox is your account's own record.`,
  });
  await db.prepare('UPDATE users SET welcomed = 1 WHERE sub = ?1').bind(user.sub).run();
}
