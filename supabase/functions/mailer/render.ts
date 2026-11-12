// Voucher PDF and email texts. Pure functions: no network, no Deno APIs, so they can be tested with Node too.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import qrcode from 'qrcode-generator';

export type Voucher = {
  code: string; title?: string; amount: number; balance?: number; status?: string; recipient?: string; from?: string; message?: string;
  design?: string; buyerEmail?: string; validUntil?: string; createdAt?: string; lang?: string; source?: string;
  delivery?: { mode?: string; email?: string; date?: string } | null;
};
export type Fonts = Record<'anton' | 'bodoni' | 'bodoniItalic' | 'mono' | 'serifFallback', Uint8Array>;
export type Ctx = { site: string; salon: string; master: string; booking: string; instagram: string; contact: string };
export type Mail = { subject: string; html: string; text: string; attach?: boolean };

// Same palettes as the site: [from, to, text, amount].
const DESIGNS: Record<string, string[]> = {
  noir: ['#2a2524', '#0b0a0a', '#f3eee9', '#f2b9cc'], blush: ['#f6c9d8', '#d98ba6', '#2a1219', '#2a1219'],
  bone: ['#f6f2ed', '#d9cfc5', '#151313', '#151313'], mocha: ['#6e5e57', '#2e2522', '#f3eee9', '#f3eee9'],
};
const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const mix = (a: string, b: string, t: number) => {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return rgb(...([0, 1, 2].map((i) => (p(a, i) * (1 - t) + p(b, i) * t) / 255) as [number, number, number]));
};

export const money = (n: number) => {
  const v = Math.round(Number(n) * 100) / 100;
  return (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',')) + ' €';
};
const MONTHS = {
  lt: ['sausio', 'vasario', 'kovo', 'balandžio', 'gegužės', 'birželio', 'liepos', 'rugpjūčio', 'rugsėjo', 'spalio', 'lapkričio', 'gruodžio'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
};
export const fmtDate = (iso: string | undefined, lang: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return lang === 'ru' ? `${d} ${MONTHS.ru[m - 1]} ${y} г.` : `${y} m. ${MONTHS.lt[m - 1]} ${d} d.`;
};
export const qrUrl = (ctx: Ctx, code: string) => `${ctx.site}/#admin/${code}`;
export const checkUrl = (ctx: Ctx, code: string) => `${ctx.site}/?kodas=${encodeURIComponent(code)}#check`;

/* ---------------- PDF ---------------- */
export async function voucherPdf(v: Voucher, fonts: Fonts, ctx: Ctx): Promise<Uint8Array> {
  const lang = v.lang === 'ru' ? 'ru' : 'lt';
  const L = lang === 'ru'
    ? { title: 'Подарочный сертификат', valid: 'Действует до', forWhom: 'Кому', code: 'Код', how: 'Покажите этот QR-код или назовите код мастеру. Сертификат можно использовать частями.', book: 'Запись' }
    : { title: 'Dovanų kuponas', valid: 'Galioja iki', forWhom: 'Kam', code: 'Kodas', how: 'Parodykite šį QR kodą arba pasakykite kodą meistrei. Kuponą galima naudoti dalimis.', book: 'Registracija' };
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${L.title} ${v.code}`); doc.setAuthor(ctx.salon); doc.setCreator(ctx.salon); doc.setProducer(ctx.salon);
  const F = {
    anton: await doc.embedFont(fonts.anton, { subset: true }),
    bodoni: await doc.embedFont(fonts.bodoni, { subset: true }),
    italic: await doc.embedFont(fonts.bodoniItalic, { subset: true }),
    mono: await doc.embedFont(fonts.mono, { subset: true }),
    fb: await doc.embedFont(fonts.serifFallback, { subset: true }),
  };
  // Bodoni has no Cyrillic: use the fallback serif for any text it cannot draw.
  const sets = new Map<unknown, Set<number>>();
  const can = (font: typeof F.italic, s: string) => {
    if (!sets.has(font)) sets.set(font, new Set(font.getCharacterSet()));
    const cs = sets.get(font)!;
    return [...s].every((ch) => ch === ' ' || cs.has(ch.codePointAt(0)!));
  };
  const pick = (font: typeof F.italic, s: string) => (can(font, s) ? font : F.fb);

  // A4 portrait; the voucher card sits on top, a short "how to use" block below.
  const W = 595.28, H = 841.89, page = doc.addPage([W, H]);
  const D = DESIGNS[v.design || 'noir'] || DESIGNS.noir;
  const cx = 40, cw = W - 80, ch = cw * 988 / 1600, cy = H - 40 - ch; // same ratio as the PNG
  // gradient: horizontal bands
  const steps = 60;
  for (let i = 0; i < steps; i++) {
    page.drawRectangle({ x: cx, y: cy + ch - (i + 1) * ch / steps, width: cw, height: ch / steps + 0.6, color: mix(D[0], D[1], i / (steps - 1)) });
  }
  const ink = hex(D[2]), accent = hex(D[3]);
  page.drawRectangle({ x: cx + 11, y: cy + 11, width: cw - 22, height: ch - 22, borderColor: ink, borderWidth: 0.6, opacity: 0, borderOpacity: 0.3 });
  const s = cw / 1600; // canvas px -> pt
  const X = (px: number) => cx + px * s, Y = (px: number) => cy + ch - px * s;
  const spaced = (txt: string, x: number, y: number, size: number, font: typeof F.mono, color: ReturnType<typeof rgb>, spacing: number, opacity = 1) => {
    let xx = x;
    for (const c of txt) { page.drawText(c, { x: xx, y, size, font, color, opacity }); xx += font.widthOfTextAtSize(c, size) + spacing; }
    return xx - x;
  };
  const spacedWidth = (txt: string, size: number, font: typeof F.mono, spacing: number) => [...txt].reduce((a, c) => a + font.widthOfTextAtSize(c, size) + spacing, 0);

  spaced(ctx.salon.toUpperCase(), X(90), Y(140), 44 * s, F.bodoni, ink, 8 * s);
  spaced(ctx.master.toUpperCase(), X(90), Y(178), 20 * s, F.mono, ink, 7 * s, 0.7);

  const amt = money(v.amount), amtSize = 190 * s;
  page.drawText(amt, { x: X(1600 - 90) - F.anton.widthOfTextAtSize(amt, amtSize), y: Y(500), size: amtSize, font: F.anton, color: accent });

  const title = v.source === 'online' || !v.title ? L.title : v.title;
  const tf = pick(F.italic, title), tSize = 70 * s;
  const lines: string[] = []; let line = '';
  for (const w of title.split(' ')) { if (line && tf.widthOfTextAtSize(line + w, tSize) > 760 * s) { lines.push(line.trim()); line = ''; } line += w + ' '; }
  lines.push(line.trim());
  lines.slice(0, 3).forEach((l, i) => page.drawText(l, { x: X(90), y: Y(440 + i * 82 - (lines.length - 1) * 41), size: tSize, font: tf, color: ink }));

  if (v.message) {
    const msg = '“' + String(v.message).slice(0, 70) + (String(v.message).length > 70 ? '…' : '') + '”';
    const mf = pick(F.italic, msg); let size = 40 * s;
    while (mf.widthOfTextAtSize(msg, size) > 1000 * s && size > 9) size -= 0.5;
    page.drawText(msg, { x: X(90), y: Y(988 - 170), size, font: mf, color: ink, opacity: 0.9 });
  }
  const who = [v.recipient ? `${L.forWhom}: ${v.recipient}` : '', v.from || ''].filter(Boolean).join(' · ').toUpperCase();
  if (who) {
    const wf = pick(F.mono, who);
    let size = 24 * s; while (spacedWidth(who, size, wf, 4 * s) > 1000 * s && size > 6) size -= 0.5;
    spaced(who, X(90), Y(988 - 110), size, wf, ink, 4 * s, 0.75);
  }
  spaced(`${L.valid}: ${fmtDate(v.validUntil, lang)}`.toUpperCase(), X(90), Y(988 - 66), 24 * s, pick(F.mono, L.valid), ink, 3 * s, 0.75);

  // QR (white tile, black modules)
  const q = qrcode(0, 'M'); q.addData(qrUrl(ctx, v.code)); q.make();
  const n = q.getModuleCount(), size = 250 * s, pad = 14 * s, qx = X(1600 - 90) - size, qy = Y(988 - 140);
  page.drawRectangle({ x: qx, y: qy, width: size, height: size, color: rgb(1, 1, 1) });
  const cell = (size - pad * 2) / n;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (q.isDark(r, c)) page.drawRectangle({ x: qx + pad + c * cell, y: qy + size - pad - (r + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: rgb(0, 0, 0) });
  }
  const codeSize = 28 * s, cwid = spacedWidth(v.code, codeSize, F.mono, 5 * s);
  spaced(v.code, X(1600 - 90) - cwid, Y(988 - 80), codeSize, F.mono, ink, 5 * s);

  // below the card
  const dark = rgb(0.08, 0.07, 0.07), grey = rgb(0.42, 0.4, 0.39);
  let y = cy - 46;
  const howF = pick(F.bodoni, L.how);
  for (const l of wrap(L.how, howF, 14, cw)) { page.drawText(l, { x: cx, y, size: 14, font: howF, color: dark }); y -= 20; }
  y -= 10;
  const rows: [string, string][] = [[L.code, v.code], [L.valid, fmtDate(v.validUntil, lang)], [L.book, ctx.booking.replace(/^https?:\/\//, '')], ['', ctx.site.replace(/^https?:\/\//, '')]];
  for (const [k, val] of rows) {
    if (k) spaced(k.toUpperCase(), cx, y, 8, pick(F.mono, k), grey, 1.4);
    page.drawText(val, { x: cx + 130, y, size: 10, font: pick(F.mono, val), color: dark });
    y -= 18;
  }
  return doc.save();
}
function wrap(txt: string, font: { widthOfTextAtSize: (s: string, n: number) => number }, size: number, max: number) {
  const out: string[] = []; let line = '';
  for (const w of txt.split(' ')) { if (line && font.widthOfTextAtSize(line + w, size) > max) { out.push(line.trim()); line = ''; } line += w + ' '; }
  out.push(line.trim()); return out;
}

/* ---------------- emails ---------------- */
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function layout(ctx: Ctx, lang: string, heading: string, paras: string[], card: { amount: string; code: string; valid: string } | null, cta: { href: string; label: string } | null, foot: string) {
  const p = paras.map((x) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:#2a2524">${x}</p>`).join('');
  const c = card ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;background:#151313;border-radius:12px"><tr><td style="padding:22px 24px;color:#f3eee9">
      <div style="font:12px/1.4 'Courier New',monospace;letter-spacing:3px;text-transform:uppercase;opacity:.7">${esc(ctx.salon)}</div>
      <div style="font:400 44px/1.1 Georgia,'Times New Roman',serif;color:#f2b9cc;margin:10px 0 8px">${esc(card.amount)}</div>
      <div style="font:15px/1.5 'Courier New',monospace;letter-spacing:2px">${esc(card.code)}</div>
      <div style="font:12px/1.5 'Courier New',monospace;opacity:.7;margin-top:4px">${esc(card.valid)}</div></td></tr></table>` : '';
  const b = cta ? `<p style="margin:4px 0 22px"><a href="${esc(cta.href)}" style="display:inline-block;background:#f2b9cc;color:#151313;text-decoration:none;font:600 15px/1 Arial,sans-serif;padding:14px 22px;border-radius:999px">${esc(cta.label)}</a></p>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(heading)}</title></head>
<body style="margin:0;background:#f6f2ed;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px"><tr><td style="padding:30px 28px">
<div style="font:400 22px/1.2 Georgia,'Times New Roman',serif;letter-spacing:4px;text-transform:uppercase;color:#151313">${esc(ctx.salon)}</div>
<div style="font:11px/1.4 'Courier New',monospace;letter-spacing:3px;text-transform:uppercase;color:#8a817c;margin:4px 0 26px">${esc(ctx.master)}</div>
<h1 style="font:400 28px/1.2 Georgia,'Times New Roman',serif;color:#151313;margin:0 0 16px">${esc(heading)}</h1>
${p}${c}${b}
<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#8a817c">${foot}</p>
</td></tr></table>
<p style="font-size:12px;color:#8a817c;margin:14px 0 0"><a href="${esc(ctx.site)}" style="color:#8a817c">${esc(ctx.site.replace(/^https?:\/\//, ''))}</a> · <a href="${esc(ctx.instagram)}" style="color:#8a817c">Instagram</a></p>
</td></tr></table></body></html>`;
}
const strip = (html: string) => html.replace(/<head>[\s\S]*?<\/head>/, '').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2: $1')
  .replace(/<\/(p|h1|div|tr)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .split('\n').map((l) => l.trim()).filter(Boolean).join('\n\n');

export function buildMail(kind: string, v: Voucher, ctx: Ctx): Mail {
  const lang = kind === 'staff' ? 'lt' : v.lang === 'ru' ? 'ru' : 'lt';
  const ru = lang === 'ru';
  const amount = money(v.amount), valid = (ru ? 'Действует до ' : 'Galioja iki ') + fmtDate(v.validUntil, lang);
  const card = { amount, code: v.code, valid };
  const check = { href: checkUrl(ctx, v.code), label: ru ? 'Проверить остаток' : 'Patikrinti likutį' };
  const book = { href: ctx.booking, label: ru ? 'Записаться на процедуру' : 'Registruotis procedūrai' };
  const foot = (ru
    ? 'Сертификат во вложении (PDF) — его можно распечатать или показать с телефона. Покажите QR-код или назовите код мастеру. Сертификат можно использовать частями. Вопросы: ответьте на это письмо'
    : 'Kuponas prisegtas (PDF) — galite jį atsispausdinti arba parodyti telefone. Parodykite QR kodą arba pasakykite kodą meistrei. Kuponą galima naudoti dalimis. Klausimai: atsakykite į šį laišką') + (ctx.contact ? ` · ${esc(ctx.contact)}` : '') + '.';
  let subject = '', heading = '', paras: string[] = [], cta: { href: string; label: string } | null = book, attach = true, footer = foot;

  if (kind === 'buyer') {
    const toRec = v.delivery?.mode === 'recipient' && v.delivery.email;
    subject = ru ? `Ваш подарочный сертификат ${amount} — ${ctx.salon}` : `Jūsų dovanų kuponas ${amount} — ${ctx.salon}`;
    heading = ru ? 'Спасибо за покупку!' : 'Ačiū už pirkinį!';
    paras = [ru ? `Оплата получена, сертификат на <b>${esc(amount)}</b> активен.` : `Apmokėjimas gautas, <b>${esc(amount)}</b> kuponas aktyvus.`];
    if (toRec) {
      const when = v.delivery!.date ? fmtDate(v.delivery!.date, lang) : (ru ? 'сегодня' : 'šiandien');
      paras.push(ru ? `Мы отправим его на <b>${esc(v.delivery!.email)}</b> ${esc(when)}. Копия для вас во вложении.`
        : `Išsiųsime jį adresu <b>${esc(v.delivery!.email)}</b> ${esc(when)}. Jūsų kopija prisegta.`);
    }
    cta = check;
  } else if (kind === 'recipient') {
    const from = v.from ? esc(v.from) : (ru ? 'Вам' : 'Jums');
    subject = v.from
      ? (ru ? `${v.from} дарит вам подарочный сертификат — ${ctx.salon}` : `${v.from} jums dovanoja dovanų kuponą — ${ctx.salon}`)
      : (ru ? `Вам подарили сертификат — ${ctx.salon}` : `Jums padovanotas dovanų kuponas — ${ctx.salon}`);
    heading = ru ? 'Вам подарок!' : 'Jums dovana!';
    paras = [v.from
      ? (ru ? `${from} дарит вам подарочный сертификат на <b>${esc(amount)}</b>.` : `${from} jums dovanoja <b>${esc(amount)}</b> dovanų kuponą.`)
      : (ru ? `Вам подарили сертификат на <b>${esc(amount)}</b>.` : `Jums padovanotas <b>${esc(amount)}</b> dovanų kuponas.`)];
    if (v.message) paras.push(`<i>“${esc(v.message)}”</i>`);
  } else if (kind === 'reminder') {
    const bal = money(v.balance ?? v.amount);
    subject = ru ? `Срок вашего сертификата заканчивается ${fmtDate(v.validUntil, lang)}` : `Jūsų kupono galiojimas baigiasi ${fmtDate(v.validUntil, lang)}`;
    heading = ru ? 'Не забудьте про сертификат' : 'Nepamirškite kupono';
    paras = [ru ? `На сертификате <b>${esc(v.code)}</b> осталось <b>${esc(bal)}</b>. Он действует до <b>${esc(fmtDate(v.validUntil, lang))}</b>, продлить срок нельзя.`
      : `Kupone <b>${esc(v.code)}</b> liko <b>${esc(bal)}</b>. Jis galioja iki <b>${esc(fmtDate(v.validUntil, lang))}</b>, galiojimas nepratęsiamas.`,
      ru ? 'Запишитесь заранее, пока есть свободное время.' : 'Užsiregistruokite iš anksto, kol yra laisvo laiko.'];
    card.amount = bal; attach = false;
    footer = ru ? 'Вопросы: ответьте на это письмо.' : 'Klausimai: atsakykite į šį laišką.';
  } else if (kind === 'staff') {
    subject = `Naujas užsakymas: ${amount} · ${v.code}`;
    heading = 'Naujas kupono užsakymas';
    const rows = [['Suma', amount], ['Pirkėjas', v.buyerEmail || '—'], ['Kam', v.recipient || '—'], ['Nuo ko', v.from || '—'],
      ['Pristatymas', v.delivery?.mode === 'recipient' ? `gavėjui ${v.delivery.email || ''}${v.delivery.date ? ', ' + fmtDate(v.delivery.date, 'lt') : ''}` : 'pirkėjui'],
      ['Būsena', v.status === 'unpaid' ? 'laukia apmokėjimo' : 'apmokėtas']];
    paras = [rows.map(([k, val]) => `${esc(k)}: <b>${esc(val)}</b>`).join('<br>'),
      v.status === 'unpaid' ? 'Kai klientas sumokės, atidarykite kuponą administravime ir paspauskite „Pažymėti apmokėtu“. Tada kuponas automatiškai išsiųs pirkėjui.' : ''].filter(Boolean);
    cta = { href: `${ctx.site}/#admin/${v.code}`, label: 'Atidaryti administravime' };
    attach = false; footer = 'Šis laiškas išsiųstas automatiškai iš kuponų svetainės.';
    const h = layout(ctx, 'lt', heading, paras, null, cta, footer);
    return { subject, html: h, text: strip(h), attach };
  }
  const html = layout(ctx, lang, heading, paras, card, cta, footer);
  return { subject, html, text: strip(html), attach };
}
