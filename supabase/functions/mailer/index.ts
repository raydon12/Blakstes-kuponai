// Sends voucher emails. Called by the database (trigger + pg_cron, see supabase/mail.sql) with header x-mailer-key.
// Deploy with JWT verification OFF (it checks the x-mailer-key header itself).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   (auth: the x-mailer-key header must equal vault secret "mailer_key", read via kp_mailer_key)
//   NOTIFY_EMAIL    where "new order" notes go (the salon)
//   one provider:
//     Gmail / any SMTP:  SMTP_USER, SMTP_PASS (Google app password), optional SMTP_HOST (smtp.gmail.com), SMTP_PORT (465)
//     Brevo:             BREVO_API_KEY
//     Resend:            RESEND_API_KEY
//   MAIL_FROM       sender address (default SMTP_USER); shown as "Grin Lashes <MAIL_FROM>"
//   optional: BACKUP_EMAIL (weekly backup, default NOTIFY_EMAIL), SITE_URL, SALON_CONTACT (phone/address line for the email footer), MAIL_PROVIDER (smtp|brevo|resend)
import nodemailer from 'nodemailer';
import { backupCsv, buildBackupMail, buildMail, voucherPdf, type Ctx, type Fonts, type Voucher } from './render.ts';

const env = (k: string, d = '') => Deno.env.get(k) || d;
const ctx: Ctx = {
  site: env('SITE_URL', 'https://blakstes-kuponai.vercel.app').replace(/\/$/, ''),
  salon: 'Grin Lashes', master: 'Meistrė Viktorija', address: 'Blakstės studija, Algirdo g. 9',
  booking: 'https://book.treatwell.lt/salonas/397163/meniu', instagram: 'https://www.instagram.com/grin_lashes/',
  contact: env('SALON_CONTACT'),
};

function provider() {
  const p = env('MAIL_PROVIDER');
  if (p) return p;
  if (env('SMTP_PASS')) return 'smtp';
  if (env('BREVO_API_KEY')) return 'brevo';
  if (env('RESEND_API_KEY')) return 'resend';
  return '';
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

type Att = { name: string; data: Uint8Array; type: string };
type Out = { to: string; subject: string; html: string; text: string; files?: Att[] };
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

// PDF fonts: TTF files from public/fonts/pdf, fetched once per instance.
const FONT_FILES = { anton: 'anton.ttf', bodoni: 'bodoni.ttf', bodoniItalic: 'bodoni-italic.ttf', mono: 'spacemono.ttf', serifFallback: 'serif-fallback-italic.ttf' } as const;
const FONT_BASES = [env('FONT_BASE'), `${ctx.site}/fonts/pdf/`, 'https://cdn.jsdelivr.net/gh/raydon12/Blakstes-kuponai@ae86f6719e0b10b5281b9e38fdb40a60a4706f92/public/fonts/pdf/'].filter(Boolean);
let fontsP: Promise<Fonts> | null = null;
function loadFonts(): Promise<Fonts> {
  fontsP ??= (async () => {
    for (const base of FONT_BASES) {
      try {
        const out = {} as Fonts;
        for (const [k, f] of Object.entries(FONT_FILES)) {
          const r = await fetch(base.replace(/\/?$/, '/') + f);
          if (!r.ok) throw new Error(`${f} ${r.status}`);
          out[k as keyof Fonts] = new Uint8Array(await r.arrayBuffer());
        }
        return out;
      } catch (e) { console.error('fonts', base, String(e)); }
    }
    throw new Error('fonts_unavailable');
  })().catch((e) => { fontsP = null; throw e; });
  return fontsP;
}

let mailerKey = '';
async function keyOk(h: string | null) {
  if (!h) return false;
  if (!mailerKey) mailerKey = String((await rpc('kp_mailer_key', {})) || '');
  return !!mailerKey && h.length === mailerKey.length && h === mailerKey;
}

// Cached per credentials, so a changed secret takes effect without waiting for a cold start.
let smtp: { key: string; t: ReturnType<typeof nodemailer.createTransport> } | null = null;
async function send(m: Out) {
  const fromAddr = env('MAIL_FROM', env('SMTP_USER')).trim();
  const fromName = ctx.salon, replyTo = env('NOTIFY_EMAIL') || fromAddr;
  const p = provider();
  if (p === 'smtp') {
    // Google shows app passwords in groups of four; spaces pasted with them are dropped.
    const user = env('SMTP_USER').trim(), pass = env('SMTP_PASS').replace(/\s+/g, ''), key = `${user}:${pass}`;
    if (smtp?.key !== key) smtp = { key, t: nodemailer.createTransport({
      host: env('SMTP_HOST', 'smtp.gmail.com'), port: Number(env('SMTP_PORT', '465')), secure: env('SMTP_PORT', '465') === '465',
      auth: { user, pass },
    }) };
    try {
      await smtp.t.sendMail({ from: { name: fromName, address: fromAddr }, to: m.to, replyTo, subject: m.subject, html: m.html, text: m.text,
        attachments: (m.files || []).map((f) => ({ filename: f.name, content: b64(f.data), encoding: 'base64', contentType: f.type })) });
    } catch (e) {
      // Says which login was tried and how long the password is (never the password), so a bad secret is easy to spot.
      if (/535|Invalid login/i.test(String(e))) throw new Error(`${String((e as Error)?.message || e).split('\n')[0]} [user=${user}, password length ${pass.length}]`);
      throw e;
    }
    return;
  }
  if (p === 'brevo') {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': env('BREVO_API_KEY'), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: fromName, email: fromAddr }, to: [{ email: m.to }], replyTo: { email: replyTo }, subject: m.subject,
        htmlContent: m.html, textContent: m.text, attachment: m.files?.length ? m.files.map((f) => ({ name: f.name, content: b64(f.data) })) : undefined }),
    });
    if (!r.ok) throw new Error(`brevo ${r.status} ${await r.text()}`);
    return;
  }
  if (p === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${fromAddr}>`, to: [m.to], reply_to: replyTo, subject: m.subject, html: m.html, text: m.text,
        attachments: m.files?.length ? m.files.map((f) => ({ filename: f.name, content: b64(f.data) })) : undefined }),
    });
    if (!r.ok) throw new Error(`resend ${r.status} ${await r.text()}`);
    return;
  }
  throw new Error('no_provider');
}

async function run() {
  const jobs: { kind: string; to: string | null; voucher: Voucher }[] = (await rpc('kp_mail_claim', { p_limit: 20 })) || [];
  const res: { code: string; kind: string; ok: boolean; err?: string }[] = [];
  for (const j of jobs) {
    const v = j.voucher;
    try {
      const to = j.kind === 'staff' ? env('NOTIFY_EMAIL') : j.to;
      if (!to) { await rpc('kp_mail_done', { p_code: v.code, p_kind: j.kind, p_ok: true, p_err: 'no_address' }); res.push({ code: v.code, kind: j.kind, ok: true, err: 'skipped' }); continue; }
      const m = buildMail(j.kind, v, ctx);
      const files = m.attach ? [{ name: `${v.code}.pdf`, data: await voucherPdf(v, await loadFonts(), ctx), type: 'application/pdf' }] : [];
      await send({ to, subject: m.subject, html: m.html, text: m.text, files });
      await rpc('kp_mail_done', { p_code: v.code, p_kind: j.kind, p_ok: true });
      res.push({ code: v.code, kind: j.kind, ok: true });
    } catch (e) {
      const err = String((e as Error)?.message || e).slice(0, 300);
      console.error('mail', v.code, j.kind, err);
      await rpc('kp_mail_done', { p_code: v.code, p_kind: j.kind, p_ok: false, p_err: err }).catch((x) => console.error(x));
      res.push({ code: v.code, kind: j.kind, ok: false, err });
    }
  }
  return res;
}

// Weekly backup: every voucher as CSV (opens in Excel) and as full JSON, to BACKUP_EMAIL or NOTIFY_EMAIL.
async function backup() {
  const to = env('BACKUP_EMAIL') || env('NOTIFY_EMAIL');
  if (!to) return { skipped: 'no_address' };
  const list: Voucher[] = (await rpc('kp_backup_export', {})) || [];
  const enc = new TextEncoder(), day = new Date().toISOString().slice(0, 10);
  const files: Att[] = [
    { name: `kuponai-${day}.csv`, data: enc.encode(backupCsv(list)), type: 'text/csv' },
    { name: `kuponai-${day}.json`, data: enc.encode(JSON.stringify(list, null, 1)), type: 'application/json' },
  ];
  const m = buildBackupMail(list, ctx);
  await send({ to, subject: m.subject, html: m.html, text: m.text, files });
  return { backup: list.length };
}

let busy: Promise<unknown> | null = null;
Deno.serve(async (req) => {
  if (!(await keyOk(req.headers.get('x-mailer-key')).catch(() => false))) return new Response('forbidden', { status: 403 });
  // Not configured yet: leave the jobs waiting so nothing is lost.
  if (!provider()) return Response.json({ skipped: 'no_provider' });
  // Preview a PDF without sending: POST {"preview": {...voucher}}
  const body = await req.json().catch(() => ({}));
  if (body?.preview) return new Response(await voucherPdf(body.preview, await loadFonts(), ctx), { headers: { 'content-type': 'application/pdf' } });
  if (body?.backup) { try { return Response.json(await backup()); } catch (e) { console.error('backup', e); return Response.json({ error: String(e) }, { status: 500 }); } }
  if (busy) await busy.catch(() => {});
  const p = run(); busy = p;
  try { return Response.json({ sent: await p }); } catch (e) { console.error(e); return Response.json({ error: String(e) }, { status: 500 }); } finally { if (busy === p) busy = null; }
});
