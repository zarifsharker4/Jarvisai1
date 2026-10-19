import { randomId } from './crypto';
import type { D1Database, Env, UserRow } from './types';

/**
 * Mind Flayer branded email. Every message is composed and stored in the outbox
 * with the Mind Flayer identity, then delivered through the configured provider
 * (Knock workflow trigger) when a key is present. Without a key the message
 * stays fully rendered in Settings -> Outbox so nothing is silently lost.
 */
export const MAIL_FROM = 'Mind Flayer <mind@mindflayer.ai>';
export const MAIL_REPLY_TO = 'hello@mindflayer.ai';

export type BrandedMail = {
  to: string;
  subject: string;
  heading: string;
  paragraphs: string[];
  ctaLabel?: string;
  ctaHref?: string;
  footer?: string;
};

function shell(mail: BrandedMail): string {
  const cta =
    mail.ctaLabel && mail.ctaHref
      ? `<p style="margin:26px 0"><a href="${mail.ctaHref}" style="background:#151922;border:1px solid #2c3242;color:#e7ecf5;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">${mail.ctaLabel}</a></p>`
      : '';
  const body = mail.paragraphs.map((p) => `<p style="margin:14px 0;color:#aab3c5;line-height:1.6">${p}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#0b0d12;padding:28px 16px;font-family:ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#11141c;border:1px solid #232833;border-radius:16px;padding:32px 28px">
    <div style="font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:#ff3b5c;font-weight:700">Mind Flayer</div>
    <h1 style="font-size:22px;margin:14px 0 6px;color:#f2f5fb">${mail.heading}</h1>
    ${body}
    ${cta}
    <hr style="border:none;border-top:1px solid #232833;margin:26px 0 14px">
    <div style="font-size:12px;color:#6b7385">${mail.footer ?? 'Sent by Mind Flayer — the Mind Flayer assistant.'}</div>
    <div style="font-size:12px;color:#6b7385;margin-top:6px">${MAIL_FROM} · reply-to ${MAIL_REPLY_TO}</div>
  </div>
</body></html>`;
}

function plain(mail: BrandedMail): string {
  const lines = [mail.heading, '', ...mail.paragraphs];
  if (mail.ctaLabel && mail.ctaHref) lines.push('', `${mail.ctaLabel}: ${mail.ctaHref}`);
  lines.push('', 'Sent by Mind Flayer — the Mind Flayer assistant.', MAIL_FROM);
  return lines.join('\n');
}

/**
 * Compose, store and attempt delivery. Returns the outbox row id plus the
 * delivery status; `outbox` means it is stored and visible but not sent.
 */
export async function sendBranded(
  env: Env,
  db: D1Database,
  userSub: string | null,
  mail: BrandedMail,
): Promise<{ id: string; status: string; provider: string; error?: string }> {
  const id = randomId(12);
  const html = shell(mail);
  const bodyText = plain(mail);
  let status = 'outbox';
  let provider = 'outbox';
  let error: string | undefined;

  await db
    .prepare(
      `INSERT INTO outbox (id, user_sub, to_email, from_email, subject, html, body_text, status, provider)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(id, userSub, mail.to, MAIL_FROM, mail.subject, html, bodyText, status, provider)
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
            actor: 'mindflayer',
            recipients: [{ id: userSub || 'anonymous', data: { email: mail.to } }],
            data: {
              email: mail.to,
              from: MAIL_FROM,
              reply_to: MAIL_REPLY_TO,
              subject: mail.subject,
              heading: mail.heading,
              paragraphs: mail.paragraphs,
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

/** One-time branded welcome email carrying the user's unique tag. */
export async function sendWelcome(env: Env, db: D1Database, user: UserRow): Promise<void> {
  if (user.welcomed) return;
  const to = user.email || 'there';
  await sendBranded(env, db, user.sub, {
    to,
    subject: `Welcome to Mind Flayer, ${user.tag}`,
    heading: `Your tag is ${user.tag}`,
    paragraphs: [
      `Hi ${user.display_name || user.tag}, Mind Flayer has provisioned your workspace.`,
      `Your unique tag <strong>${user.tag}</strong> identifies you across chats, the 3-agent pipeline, the AI discussion space and Call Mind Flayer.`,
      'Lock your chat history with a PIN in Settings, and connect your own model API keys (Google AI Studio, OpenRouter, Groq, Together AI, Mistral, OpenLLM, HuggingFace) whenever you are ready.',
    ],
    ctaLabel: 'Open Mind Flayer',
    ctaHref: env.APP_ORIGIN,
    footer: `Delivered by Mind Flayer for ${user.tag}. This mailbox is your account's branded record.`,
  });
  await db.prepare('UPDATE users SET welcomed = 1 WHERE sub = ?1').bind(user.sub).run();
}
