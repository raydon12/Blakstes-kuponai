-- Blakstės studija gift vouchers — full schema for its own Supabase project.
-- Private schema "kuponai" (not exposed to the API). The site uses only the public kp_* functions.
-- Masters log in with their own email + password (bcrypt) and get a 30-day session token.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists kuponai;
revoke all on schema kuponai from public, anon, authenticated;

create table if not exists kuponai.vouchers (
  code text primary key,
  doc jsonb not null,
  created_at timestamptz not null default now()
);
alter table kuponai.vouchers enable row level security;

-- helpers (not callable from the API)
create or replace function kuponai.new_code() returns text language plpgsql as $$
declare abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea := extensions.gen_random_bytes(8); s text := ''; i int;
begin
  for i in 0..7 loop s := s || substr(abc, (get_byte(b, i) % 32) + 1, 1); end loop;
  return 'GIFT-' || substr(s,1,4) || '-' || substr(s,5,4);
end $$;

create or replace function kuponai.balance(d jsonb) returns numeric language sql immutable as $$
  select round((d->>'amount')::numeric - coalesce((select sum((r->>'amount')::numeric) from jsonb_array_elements(coalesce(d->'redemptions','[]'::jsonb)) r), 0), 2)
$$;

create or replace function kuponai.status(d jsonb) returns text language sql stable as $$
  select case
    when coalesce((d->>'voided')::boolean, false) then 'void'
    when d->'payment'->>'status' = 'pending' then 'unpaid'
    when kuponai.balance(d) <= 0 then 'used'
    when (d->>'validUntil')::date < (now() at time zone 'Europe/Vilnius')::date then 'expired'
    else 'active' end
$$;

create or replace function kuponai.for_master(d jsonb) returns jsonb language sql stable as $$
  select d || jsonb_build_object('balance', kuponai.balance(d), 'status', kuponai.status(d))
$$;

create or replace function kuponai.clean_text(v jsonb, maxlen int) returns text language sql immutable as $$
  select left(coalesce(v #>> '{}', ''), maxlen)
$$;


alter function kuponai.new_code() set search_path = '';
alter function kuponai.balance(jsonb) set search_path = '';
alter function kuponai.clean_text(jsonb, int) set search_path = '';
alter function kuponai.status(jsonb) set search_path = '';
alter function kuponai.for_master(jsonb) set search_path = '';

-- Public balance check by code
create or replace function public.kp_lookup(p_code text) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code', doc->'code', 'title', doc->'title', 'amount', doc->'amount', 'balance', kuponai.balance(doc),
    'status', kuponai.status(doc), 'validUntil', doc->'validUntil', 'recipient', doc->'recipient', 'from', doc->'from',
    'message', doc->'message', 'design', doc->'design')
  from kuponai.vouchers where code = upper(trim(p_code))
$$;

create table if not exists kuponai.staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  pw_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists kuponai.sessions (
  token_hash text primary key,
  staff_id uuid not null references kuponai.staff(id),
  expires_at timestamptz not null
);
create table if not exists kuponai.login_fails (
  email text primary key,
  n int not null default 0,
  locked_until timestamptz
);
alter table kuponai.staff enable row level security;
alter table kuponai.sessions enable row level security;
alter table kuponai.login_fails enable row level security;

create or replace function kuponai.me(p_token text) returns text language sql stable security definer set search_path = '' as $$
  select st.name from kuponai.sessions s join kuponai.staff st on st.id = s.staff_id
  where s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex') and s.expires_at > now()
$$;
create or replace function kuponai.require_master(p_token text) returns text language plpgsql stable security definer set search_path = '' as $$
declare n text := kuponai.me(p_token);
begin if n is null then raise exception 'not_master' using errcode = '42501'; end if; return n; end $$;

-- Login: returns {token, name} or {error}. 5 wrong passwords lock the email for 10 minutes.
create or replace function public.kp_login(p_email text, p_password text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare e text := lower(trim(coalesce(p_email,''))); st kuponai.staff; f kuponai.login_fails; tok text; newn int;
begin
  select * into f from kuponai.login_fails where email = e;
  if f.locked_until is not null and f.locked_until > now() then return jsonb_build_object('error','too_many'); end if;
  select * into st from kuponai.staff where email = e;
  if st.id is null or st.pw_hash <> extensions.crypt(coalesce(p_password,''), st.pw_hash) then
    newn := case when f.locked_until is not null then 1 else coalesce(f.n, 0) + 1 end;
    insert into kuponai.login_fails(email, n, locked_until) values (e, newn, case when newn >= 5 then now() + interval '10 minutes' end)
      on conflict (email) do update set n = excluded.n, locked_until = excluded.locked_until;
    return jsonb_build_object('error','bad_login');
  end if;
  update kuponai.login_fails set n = 0, locked_until = null where email = e;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into kuponai.sessions(token_hash, staff_id, expires_at) values (encode(extensions.digest(tok, 'sha256'), 'hex'), st.id, now() + interval '30 days');
  return jsonb_build_object('token', tok, 'name', st.name);
end $$;

create or replace function public.kp_logout(p_token text) returns void language sql volatile security definer set search_path = '' as $$
  update kuponai.sessions set expires_at = now() where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
$$;


create or replace function public.kp_me(p_token text default null) returns text language sql stable security definer set search_path = '' as $$
  select kuponai.me(p_token)
$$;

create or replace function public.kp_create(p jsonb, p_token text default null) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m text := kuponai.me(p_token); amt numeric; months int; d jsonb; c text; dl jsonb := null;
begin
  amt := round((p->>'amount')::numeric, case when m is null then 0 else 2 end);
  if m is null and not (amt between 40 and 1000) then raise exception 'bad_amount'; end if;
  if m is not null and not (amt between 1 and 5000) then raise exception 'bad_amount'; end if;
  if m is null and coalesce(p->>'buyerEmail','') !~ '^[^@\s]+@[^@\s]+$' then raise exception 'bad_email'; end if;
  months := case when m is null then 12 else least(36, greatest(1, coalesce((p->>'validMonths')::int, 12))) end;
  if m is null and p->'delivery'->>'mode' = 'recipient' then
    dl := jsonb_build_object('mode','recipient',
      'email', case when p->'delivery'->>'email' ~ '^[^@\s]+@[^@\s]+$' then left(p->'delivery'->>'email',120) end,
      'date', case when p->'delivery'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then p->'delivery'->>'date' end, 'sent', false);
  elsif m is null then dl := jsonb_build_object('mode','me');
  end if;
  loop
    c := kuponai.new_code();
    exit when not exists (select 1 from kuponai.vouchers where code = c);
  end loop;
  d := jsonb_build_object(
    'id', gen_random_uuid(), 'code', c, 'title', 'Dovanų kuponas', 'amount', amt, 'serviceId', null,
    'recipient', kuponai.clean_text(p->'recipient', 80), 'from', kuponai.clean_text(p->'from', 80),
    'message', kuponai.clean_text(p->'message', 300),
    'design', case when p->>'design' in ('noir','blush','bone','mocha') then p->>'design' else 'noir' end,
    'buyerEmail', left(coalesce(p->>'buyerEmail',''), 120),
    'payment', jsonb_build_object('provider', case when m is null then 'online' else 'salon' end, 'status', case when m is null then 'pending' else 'paid' end),
    'source', case when m is null then 'online' else 'salon' end,
    'payMethod', case when m is null then 'online' when p->>'payMethod' in ('cash','card','gift') then p->>'payMethod' else 'cash' end,
    'soldBy', m, 'delivery', dl,
    'createdAt', to_jsonb(now()),
    'validUntil', to_char((now() at time zone 'Europe/Vilnius')::date + make_interval(months => months), 'YYYY-MM-DD'),
    'redemptions', '[]'::jsonb, 'log', '[]'::jsonb);
  insert into kuponai.vouchers(code, doc) values (c, d);
  if m is null then return public.kp_lookup(c); end if;
  return kuponai.for_master(d);
end $$;

create or replace function public.kp_list(p_token text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform kuponai.require_master(p_token);
  return coalesce((select jsonb_agg(kuponai.for_master(doc) order by created_at desc) from kuponai.vouchers), '[]'::jsonb);
end $$;

create or replace function public.kp_get(p_token text, p_code text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d jsonb;
begin
  perform kuponai.require_master(p_token);
  select doc into d from kuponai.vouchers where code = upper(trim(p_code));
  if d is null then raise exception 'not_found'; end if;
  return kuponai.for_master(d);
end $$;

create or replace function public.kp_redeem(p_token text, p_code text, p_amount numeric, p_note text default '') returns jsonb language plpgsql security definer set search_path = '' as $$
declare m text := kuponai.require_master(p_token); d jsonb; a numeric := round(p_amount, 2); st text;
begin
  if not (a > 0) then raise exception 'bad_amount'; end if;
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then raise exception 'not_found'; end if;
  st := kuponai.status(d);
  if st <> 'active' then raise exception '%', st; end if;
  if a > kuponai.balance(d) then raise exception 'insufficient'; end if;
  d := jsonb_set(d, '{redemptions}', coalesce(d->'redemptions','[]'::jsonb) || jsonb_build_object(
    'id', gen_random_uuid(), 'amount', a, 'note', left(coalesce(p_note,''),140), 'by', m, 'at', now()));
  update kuponai.vouchers set doc = d where code = p_code;
  return kuponai.for_master(d);
end $$;

create or replace function public.kp_undo(p_token text, p_code text, p_rid text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m text := kuponai.require_master(p_token); d jsonb; r jsonb;
begin
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then raise exception 'not_found'; end if;
  select x into r from jsonb_array_elements(coalesce(d->'redemptions','[]'::jsonb)) x where x->>'id' = p_rid;
  if r is null then raise exception 'not_found'; end if;
  d := jsonb_set(d, '{redemptions}', coalesce((select jsonb_agg(x) from jsonb_array_elements(d->'redemptions') x where x->>'id' <> p_rid), '[]'::jsonb));
  d := jsonb_set(d, '{log}', coalesce(d->'log','[]'::jsonb) || jsonb_build_object('at', now(), 'by', m, 'action', 'undo', 'redemption', r));
  update kuponai.vouchers set doc = d where code = p_code;
  return kuponai.for_master(d);
end $$;

create or replace function public.kp_edit(p_token text, p_code text, p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m text := kuponai.require_master(p_token); d jsonb; act text := 'edit';
begin
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then raise exception 'not_found'; end if;
  if p ? 'recipient' then d := d || jsonb_build_object('recipient', kuponai.clean_text(p->'recipient', 80)); end if;
  if p ? 'from' then d := d || jsonb_build_object('from', kuponai.clean_text(p->'from', 80)); end if;
  if p ? 'message' then d := d || jsonb_build_object('message', kuponai.clean_text(p->'message', 300)); end if;
  if p ? 'validUntil' then
    if p->>'validUntil' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad_date'; end if;
    d := d || jsonb_build_object('validUntil', p->>'validUntil');
  end if;
  if jsonb_typeof(p->'voided') = 'boolean' then d := d || jsonb_build_object('voided', p->'voided'); act := case when (p->>'voided')::boolean then 'void' else 'restore' end; end if;
  if (p->>'paid')::boolean is true then d := jsonb_set(d, '{payment,status}', '"paid"'); act := 'paid'; end if;
  d := jsonb_set(d, '{log}', coalesce(d->'log','[]'::jsonb) || jsonb_build_object('at', now(), 'by', m, 'action', act));
  update kuponai.vouchers set doc = d where code = p_code;
  return kuponai.for_master(d);
end $$;


revoke all on all functions in schema kuponai from public, anon, authenticated;
revoke all on function public.kp_login(text, text), public.kp_logout(text), public.kp_me(text), public.kp_create(jsonb, text),
  public.kp_list(text), public.kp_get(text, text), public.kp_redeem(text, text, numeric, text), public.kp_undo(text, text, text),
  public.kp_edit(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.kp_login(text, text), public.kp_logout(text), public.kp_me(text), public.kp_create(jsonb, text),
  public.kp_list(text), public.kp_get(text, text), public.kp_redeem(text, text, numeric, text), public.kp_undo(text, text, text),
  public.kp_edit(text, text, jsonb), public.kp_lookup(text) to anon, authenticated;
