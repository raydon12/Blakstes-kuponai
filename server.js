// Gift voucher shop server: static site + JSON API + master (staff) area.
// - The service list lives in data/menu.json and is edited by hand; booking goes to Treatwell via links.
// - Payments are mocked: no money moves. Vouchers are stored in data/orders.json.
// - Each voucher has a code, a QR (rendered in the browser) and a balance. Staff ("masters")
//   log in at /#admin (admin panel), see every voucher, scan the QR, deduct, edit, undo.
// - Masters live in data/masters.json; add one with: node scripts/add-master.js <name> <password>
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const MENU = path.join(DATA, 'menu.json');
const ORDERS = path.join(DATA, 'orders.json');
const MASTERS = path.join(DATA, 'masters.json');
const SESSION_HOURS = 12;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
function writeJson(f, v) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); }
const readMenu = () => readJson(MENU, { salon: {}, categories: [] });
const readOrders = () => readJson(ORDERS, []);
const round2 = n => Math.round(n * 100) / 100;

// One write at a time so two masters redeeming at once can't overspend a voucher.
let queue = Promise.resolve();
const serial = fn => (queue = queue.then(fn, fn));

function voucherCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(crypto.randomBytes(4), b => abc[b % abc.length]).join('');
  return `GIFT-${part()}-${part()}`;
}
const normCode = s => String(s || '').toUpperCase().match(/GIFT-[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] || null;

function balanceOf(v) {
  return round2(v.amount - (v.redemptions || []).reduce((s, r) => s + r.amount, 0));
}
function statusOf(v) {
  if (v.voided) return 'void';
  if (balanceOf(v) <= 0) return 'used';
  if (v.validUntil && new Date(v.validUntil + 'T23:59:59') < new Date()) return 'expired';
  return 'active';
}
const forMaster = v => ({ ...v, balance: balanceOf(v), status: statusOf(v) });
const forPublic = v => ({ code: v.code, title: v.title, amount: v.amount, balance: balanceOf(v), status: statusOf(v), validUntil: v.validUntil, recipient: v.recipient, from: v.from, message: v.message, design: v.design });

function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
  });
}

// ---- masters & sessions ----
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}
function checkPassword(m, password) {
  const { hash } = hashPassword(password, m.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(m.hash, 'hex'));
}
const sessions = new Map(); // token -> { name, expires }
const loginFails = new Map(); // ip -> { n, until }
function sessionOf(req) {
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)msid=([a-f0-9]{64})/)?.[1];
  const s = token && sessions.get(token);
  if (!s || s.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return { ...s, token };
}

async function login(req, res) {
  const ip = req.socket.remoteAddress;
  const f = loginFails.get(ip);
  if (f && f.until > Date.now()) return json(res, 429, { error: 'too_many_attempts' });
  let b; try { b = await readBody(req); } catch { return json(res, 400, { error: 'bad_json' }); }
  const m = readJson(MASTERS, []).find(x => x.name.toLowerCase() === String(b.name || '').trim().toLowerCase());
  if (!m || !checkPassword(m, b.password || '')) {
    const n = (f?.n || 0) + 1;
    loginFails.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    return json(res, 401, { error: 'bad_credentials' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name: m.name, expires: Date.now() + SESSION_HOURS * 3600e3 });
  json(res, 200, { name: m.name }, { 'Set-Cookie': `msid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}` });
}

// ---- vouchers ----
const isEmail = s => /^[^@\s]+@[^@\s]+$/.test(String(s || ''));
function cleanDelivery(d) {
  if (!d || d.mode !== 'recipient') return { mode: 'me' };
  return { mode: 'recipient', email: isEmail(d.email) ? String(d.email).slice(0, 120) : null, date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null, sent: false };
}

// Online purchase (customer) or, with master set, a sale at the salon desk.
async function createOrder(req, res, master) {
  let b; try { b = await readBody(req); } catch { return json(res, 400, { error: 'Bad JSON' }); }
  const services = readMenu().categories.flatMap(c => c.services);
  let amount, title;
  if (b.serviceId) {
    const s = services.find(x => x.id === b.serviceId);
    if (!s) return json(res, 400, { error: 'Unknown service' });
    amount = s.price; title = s.name;
  } else {
    amount = master ? round2(Number(b.amount)) : Math.round(Number(b.amount));
    if (!(amount >= (master ? 1 : 40) && amount <= (master ? 5000 : 1000))) return json(res, 400, { error: 'bad_amount' });
    title = 'Dovanų kuponas';
  }
  if (!master && !isEmail(b.buyerEmail)) return json(res, 400, { error: 'Email required' });
  if (master && b.buyerEmail && !isEmail(b.buyerEmail)) return json(res, 400, { error: 'bad_email' });
  const months = master ? Math.min(36, Math.max(1, Number(b.validMonths) || 12)) : 12;
  const until = new Date(); until.setMonth(until.getMonth() + months);
  const order = await serial(() => {
    const orders = readOrders();
    const v = {
      id: crypto.randomUUID(),
      code: voucherCode(),
      title, amount, serviceId: b.serviceId || null,
      recipient: String(b.recipient || '').slice(0, 80),
      from: String(b.from || '').slice(0, 80),
      message: String(b.message || '').slice(0, 300),
      design: String(b.design || 'noir'),
      buyerEmail: b.buyerEmail || '',
      payment: { provider: master ? 'salon' : 'mock', status: 'paid' },
      source: master ? 'salon' : 'online',
      payMethod: master ? (['cash', 'card', 'gift'].includes(b.payMethod) ? b.payMethod : 'cash') : 'online',
      soldBy: master ? master.name : null,
      delivery: master ? null : cleanDelivery(b.delivery),
      createdAt: new Date().toISOString(),
      validUntil: until.toISOString().slice(0, 10),
      redemptions: [],
    };
    orders.push(v);
    writeJson(ORDERS, orders);
    return v;
  });
  json(res, 201, master ? forMaster(order) : forPublic(order));
}

async function redeem(req, res, code, master) {
  let b; try { b = await readBody(req); } catch { return json(res, 400, { error: 'bad_json' }); }
  const amount = round2(Number(b.amount));
  if (!(amount > 0)) return json(res, 400, { error: 'bad_amount' });
  const result = await serial(() => {
    const orders = readOrders();
    const v = orders.find(x => x.code === code);
    if (!v) return [404, { error: 'not_found' }];
    const st = statusOf(v);
    if (st !== 'active') return [409, { error: st }];
    if (amount > balanceOf(v)) return [409, { error: 'insufficient', balance: balanceOf(v) }];
    v.redemptions = v.redemptions || [];
    v.redemptions.push({ id: crypto.randomUUID(), amount, note: String(b.note || '').slice(0, 140), by: master.name, at: new Date().toISOString() });
    writeJson(ORDERS, orders);
    return [200, forMaster(v)];
  });
  json(res, ...result);
}

// Staff may correct who the voucher is for, the wish and the expiry date. The face value is fixed.
async function editVoucher(req, res, code, master) {
  let b; try { b = await readBody(req); } catch { return json(res, 400, { error: 'bad_json' }); }
  if (b.validUntil !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(b.validUntil)) return json(res, 400, { error: 'bad_date' });
  const result = await serial(() => {
    const orders = readOrders();
    const v = orders.find(x => x.code === code);
    if (!v) return [404, { error: 'not_found' }];
    for (const [k, max] of [['recipient', 80], ['from', 80], ['message', 300]]) if (b[k] !== undefined) v[k] = String(b[k]).slice(0, max);
    if (b.validUntil) v.validUntil = b.validUntil;
    if (typeof b.voided === 'boolean') v.voided = b.voided;
    (v.log = v.log || []).push({ at: new Date().toISOString(), by: master.name, action: typeof b.voided === 'boolean' ? (b.voided ? 'void' : 'restore') : 'edit' });
    writeJson(ORDERS, orders);
    return [200, forMaster(v)];
  });
  json(res, ...result);
}

// Undo a mistaken deduction; the amount goes back on the balance and the undo is logged.
async function undoRedemption(res, code, rid, master) {
  if (!code) return json(res, 400, { error: 'bad_code' });
  const result = await serial(() => {
    const orders = readOrders();
    const v = orders.find(x => x.code === code);
    if (!v) return [404, { error: 'not_found' }];
    const r = (v.redemptions || []).find(x => x.id === rid);
    if (!r) return [404, { error: 'not_found' }];
    v.redemptions = v.redemptions.filter(x => x.id !== rid);
    (v.log = v.log || []).push({ at: new Date().toISOString(), by: master.name, action: 'undo', redemption: r });
    writeJson(ORDERS, orders);
    return [200, forMaster(v)];
  });
  json(res, ...result);
}

async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/menu') return json(res, 200, readMenu());
  if (p === '/api/orders' && req.method === 'POST') return createOrder(req, res);
  if (p.startsWith('/api/voucher/')) {
    const code = normCode(decodeURIComponent(p.slice(13)));
    const v = code && readOrders().find(x => x.code === code);
    return v ? json(res, 200, forPublic(v)) : json(res, 404, { error: 'not_found' });
  }
  if (p === '/api/master/login' && req.method === 'POST') return login(req, res);
  const s = sessionOf(req);
  if (p === '/api/master/logout' && req.method === 'POST') {
    if (s) sessions.delete(s.token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'msid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (p.startsWith('/api/master/')) {
    if (!s) return json(res, 401, { error: 'login_required' });
    if (p === '/api/master/me') return json(res, 200, { name: s.name });
    if (p === '/api/master/vouchers' && req.method === 'POST') return createOrder(req, res, s);
    if (p === '/api/master/vouchers' && req.method === 'GET') {
      return json(res, 200, readOrders().reverse().map(forMaster));
    }
    const u = p.match(/^\/api\/master\/vouchers\/([^/]+)\/redemptions\/([\w-]+)$/);
    if (u && req.method === 'DELETE') return undoRedemption(res, normCode(decodeURIComponent(u[1])), u[2], s);
    const m = p.match(/^\/api\/master\/vouchers\/([^/]+)(\/redeem)?$/);
    if (m) {
      const code = normCode(decodeURIComponent(m[1]));
      if (!code) return json(res, 400, { error: 'bad_code' });
      if (m[2] && req.method === 'POST') return redeem(req, res, code, s);
      if (!m[2] && req.method === 'PATCH') return editVoucher(req, res, code, s);
      const v = readOrders().find(x => x.code === code);
      return v ? json(res, 200, forMaster(v)) : json(res, 404, { error: 'not_found' });
    }
  }
  json(res, 404, { error: 'not_found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try { return await api(req, res, url); } catch (e) { console.error(e); return json(res, 500, { error: 'server_error' }); }
  }
  if (['/admin', '/master', '/master.html'].includes(url.pathname)) { res.writeHead(302, { Location: '/#admin' }); return res.end(); }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

module.exports = { hashPassword, MASTERS, readJson, writeJson };

if (require.main === module) {
  if (!readJson(MASTERS, []).length) console.warn('No masters yet. Add one: node scripts/add-master.js <name> <password>');
  server.listen(PORT, () => console.log(`Gift voucher shop on http://localhost:${PORT}  ·  admin: /#admin`));
}
