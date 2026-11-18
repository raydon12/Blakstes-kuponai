// Paysera Checkout (WebToPay, spec v1.6): building a signed payment request and checking a callback.
// https://developers.paysera.com/en/checkout/integrations/integration-specification
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

export const PAY_URL = 'https://bank.paysera.com/pay/';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

// base64 of the query string, with "+" → "-" and "/" → "_" (Paysera's "url-safe" base64, padding kept).
export function encode(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return Buffer.from(q.toString(), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function decode(data: string): Record<string, string> {
  const raw = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

export const sign = (data: string, password: string) => md5(data + password);

// ss1 = md5(data + sign password). Only Paysera and we know the password.
export function verifySs1(data: string, ss1: string, password: string) {
  const want = Buffer.from(sign(data, password));
  const got = Buffer.from(String(ss1 || '').toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

export function payUrl(params: Record<string, string | number | undefined>, password: string) {
  const data = encode({ version: '1.6', ...params });
  return `${PAY_URL}?${new URLSearchParams({ data, sign: sign(data, password) })}`;
}
