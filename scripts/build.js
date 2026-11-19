#!/usr/bin/env node
// Builds a salon's site from the template.
//   node scripts/build.js [path/to/salon.config.json]
// Reads salon.config.json, fills the {{tokens}} and writes:
//   dist/            — the website (Vercel serves this folder)
//   build/supabase/  — SQL and functions for this salon's Supabase project
// No dependencies, Node 18+.
//
// Token syntax: {{key.path}} or {{key.path|filter}}
//   (none) HTML-escaped      js   inside a JS/JSON string      json  JSON value
//   url    encodeURIComponent sql inside a SQL '…' string      raw   as is
//   ph     HTML-escaped, or a yellow [PLACEHOLDER] when empty (legal pages)
// An unknown key stops the build, so typos are caught.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const cfgPath = path.resolve(process.argv[2] || path.join(ROOT, 'salon.config.json'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

/* ---------- checks ---------- */
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const hex = v => /^#[0-9a-f]{6}$/i.test(v || '');
need(cfg.brand?.name?.trim(), 'brand.name пустой');
need(/^https:\/\/[^/]+/.test(cfg.site?.url || ''), 'site.url должен начинаться с https://');
need(/^https:\/\//.test(cfg.booking?.url || ''), 'booking.url должен начинаться с https://');
['accent', 'accent2', 'accentInk'].forEach(k => need(hex(cfg.colors?.[k]), `colors.${k} должен быть вида #aabbcc`));
const V = cfg.vouchers || {};
need(Number.isInteger(V.min) && V.min > 0, 'vouchers.min — целое число > 0');
need(Number.isInteger(V.max) && V.max >= V.min, 'vouchers.max — целое число ≥ min');
need(Number.isInteger(V.validMonths) && V.validMonths >= 1 && V.validMonths <= 36, 'vouchers.validMonths — от 1 до 36');
need(Array.isArray(V.amounts) && V.amounts.length && V.amounts.every(a => Number.isInteger(a) && a >= V.min && a <= V.max), 'vouchers.amounts — целые суммы между min и max');
if (cfg.supabase?.url) need(/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(cfg.supabase.url), 'supabase.url вида https://xxxx.supabase.co (без / в конце)');
if (cfg.supabase?.url) need(/^sb_publishable_/.test(cfg.supabase.key || ''), 'supabase.key — publishable-ключ (sb_publishable_…)');
if (errors.length) { console.error('Ошибки в ' + path.relative(process.cwd(), cfgPath) + ':\n  - ' + errors.join('\n  - ')); process.exit(1); }

/* ---------- derived values ---------- */
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = a => '#' + a.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
const mix = (h, w, t) => toHex(rgb(h).map((c, i) => c + (rgb(w)[i] - c) * t));
const C = cfg.colors;
const site = cfg.site.url.replace(/\/$/, '');
const ig = String(cfg.contacts?.instagram || '').replace(/^@/, '').trim();
const strip = o => Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, strip(v)])) : o;

const data = strip({
  ...cfg,
  brand: { ...cfg.brand, initial: [...cfg.brand.name.trim()][0].toUpperCase() },
  seller: { ...cfg.seller, vatLine: cfg.seller?.vat ? `, PVM mokėtojo kodas ${cfg.seller.vat}` : '' },
  site: { ...cfg.site, url: site, host: site.replace(/^https:\/\//, '') },
  contacts: { ...cfg.contacts, instagram: ig, instagramUrl: ig ? `https://www.instagram.com/${ig}/` : '' },
  colors: {
    ...C,
    accentRgb: rgb(C.accent).join(','),
    accentLight: mix(C.accent, '#ffffff', 0.55),
    accentDeep: mix(C.accent, '#000000', 0.12),
    accentDark: mix(C.accent, '#000000', 0.45),
    accentInkRgb: rgb(C.accentInk).join(','),
    designName: C.designName || 'Color'
  },
  supabase: { url: cfg.supabase?.url || '', key: cfg.supabase?.key || '', host: (cfg.supabase?.url || '').replace(/^https:\/\//, '') },
  // JSON blocks the page reads at runtime
  menuData: { salon: { name: cfg.brand.name, address: cfg.contacts?.address || '', bookingUrl: cfg.booking.url }, categories: cfg.menu?.categories || [] },
  teamData: { barbers: (cfg.team?.barbers || []).map(b => ({ photos: [], ...b })) },
  supaConfig: cfg.supabase?.url ? { url: cfg.supabase.url, key: cfg.supabase.key } : {},
  runtime: { vouchers: V, texts: cfg.texts || {}, booking: cfg.booking, instagram: ig, designName: C.designName || 'Color' },
  ldJson: {
    '@context': 'https://schema.org', '@type': cfg.brand.schemaType || 'LocalBusiness', name: cfg.brand.name,
    url: site + '/', image: site + '/og.png', description: cfg.site.description?.lt || '',
    ...(ig ? { sameAs: [`https://www.instagram.com/${ig}/`] } : {}),
    ...(cfg.contacts?.address ? { address: cfg.contacts.address } : {})
  },
  year: new Date().getFullYear()
});

/* ---------- token rendering ---------- */
const get = (key, file) => {
  const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
  if (v === undefined) throw new Error(`${file}: неизвестный ключ {{${key}}}`);
  return v;
};
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PH = { 'seller.name': 'ĮMONĖS PAVADINIMAS', 'seller.code': 'KODAS', 'seller.address': 'ADRESAS', 'seller.email': 'EL. PAŠTAS', 'seller.phone': 'TELEFONAS', 'seller.mailService': 'EL. PAŠTO PASLAUGA' };
const FILTERS = {
  html: escHtml,
  js: v => JSON.stringify(String(v ?? '')).slice(1, -1).replace(/</g, '\\u003c'),
  json: v => JSON.stringify(v).replace(/</g, '\\u003c'),
  url: v => encodeURIComponent(String(v ?? '')),
  sql: v => String(v ?? '').replace(/'/g, "''"),
  raw: v => String(v ?? ''),
  ph: (v, key) => String(v ?? '').trim() ? escHtml(v) : `<span class="ph">[${PH[key] || key}]</span>`
};
const render = (text, file) => text.replace(/\{\{\s*([\w.]+)(?:\|(\w+))?\s*\}\}/g, (_, key, f = 'html') => {
  if (!FILTERS[f]) throw new Error(`${file}: неизвестный фильтр |${f}`);
  return FILTERS[f](get(key, file), key);
});

/* ---------- copy ---------- */
const TEXT = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.xml', '.txt', '.svg', '.sql', '.ts']);
const SKIP_RENDER = /(^|\/)vendor\//; // minified libraries: copy as is
function copyDir(src, dst, rel = '') {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name), r = rel + e.name;
    if (e.isDirectory()) { copyDir(s, d, r + '/'); continue; }
    if (TEXT.has(path.extname(e.name)) && !SKIP_RENDER.test(r)) fs.writeFileSync(d, render(fs.readFileSync(s, 'utf8'), r));
    else fs.copyFileSync(s, d);
  }
}
const out = (...p) => path.join(ROOT, ...p);
for (const d of ['dist', 'build']) fs.rmSync(out(d), { recursive: true, force: true });
try {
  copyDir(out('public'), out('dist'));
  copyDir(out('supabase'), out('build', 'supabase'));
} catch (e) { console.error(e.message); process.exit(1); }

const left = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else if (TEXT.has(path.extname(e.name)) && /\{\{\s*[\w.]+(\|\w+)?\s*\}\}/.test(fs.readFileSync(p, 'utf8'))) left.push(path.relative(ROOT, p));
  }
})(out('dist'));
if (left.length) { console.error('Остались незаполненные {{…}} в: ' + left.join(', ')); process.exit(1); }

console.log(`✓ ${cfg.brand.name}: сайт → dist/, Supabase → build/supabase/` + (cfg.supabase?.url ? '' : '  (Supabase не задан — демо-режим)'));
