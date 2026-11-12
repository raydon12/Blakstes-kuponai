-- Emails: voucher to the buyer once paid, to the recipient on the chosen day, a "new order" note to the salon,
-- and a reminder 30 days before the voucher expires. The Edge Function "mailer" sends them.
-- State lives in doc->'mail'->{staff|buyer|recipient|reminder} = {state: sending|sent|failed, at, tries, err}.
-- A trigger pokes the mailer when a voucher has something to send; pg_cron pokes it every 15 minutes for dated jobs.
-- One-time setup (not in this file, holds secrets):
--   select vault.create_secret('<random key>', 'mailer_key');  and the same value as Edge Function secret MAILER_KEY.
create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function kuponai.mail_due(d jsonb, k text) returns boolean language sql stable set search_path = '' as $$
  select case
    when d->'mail'->k is null then true
    when d->'mail'->k->>'state' = 'sending' then (d->'mail'->k->>'at')::timestamptz < now() - interval '15 minutes'
    when d->'mail'->k->>'state' = 'failed' then coalesce((d->'mail'->k->>'tries')::int, 0) < 6
      and (d->'mail'->k->>'at')::timestamptz < now() - make_interval(mins => 10 * coalesce((d->'mail'->k->>'tries')::int, 1))
    else false end
$$;

create or replace function kuponai.email_ok(e text) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(e, '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
$$;

-- Jobs a voucher is waiting for: [{kind, to}]. Recipient mail goes out from 9:00 Vilnius time on the chosen day.
create or replace function kuponai.mail_jobs(d jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare j jsonb := '[]'::jsonb; st text := kuponai.status(d); paid boolean := d->'payment'->>'status' = 'paid';
  live boolean := not coalesce((d->>'voided')::boolean, false); vil timestamp := now() at time zone 'Europe/Vilnius';
  dd date := case when d->'delivery'->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then (d->'delivery'->>'date')::date end;
  rec boolean := d->'delivery'->>'mode' = 'recipient' and kuponai.email_ok(d->'delivery'->>'email');
  owner text;
begin
  if not live then return j; end if;
  if d->>'source' = 'online' and kuponai.mail_due(d, 'staff') then j := j || jsonb_build_object('kind', 'staff', 'to', null); end if;
  if paid and kuponai.email_ok(d->>'buyerEmail') and kuponai.mail_due(d, 'buyer') then
    j := j || jsonb_build_object('kind', 'buyer', 'to', d->>'buyerEmail'); end if;
  if paid and rec and not coalesce((d->'delivery'->>'sent')::boolean, false) and kuponai.mail_due(d, 'recipient')
     and (dd is null or dd < vil::date or (dd = vil::date and extract(hour from vil) >= 9)) then
    j := j || jsonb_build_object('kind', 'recipient', 'to', d->'delivery'->>'email'); end if;
  owner := case when rec and coalesce((d->'delivery'->>'sent')::boolean, false) then d->'delivery'->>'email' else d->>'buyerEmail' end;
  if st = 'active' and kuponai.email_ok(owner) and kuponai.mail_due(d, 'reminder')
     and (d->>'validUntil')::date - vil::date between 0 and 30
     and (d->>'createdAt')::timestamptz < now() - interval '45 days' then
    j := j || jsonb_build_object('kind', 'reminder', 'to', owner); end if;
  return j;
end $$;

-- Claim up to p_limit jobs (marks them "sending"). Called by the mailer with the service role.
create or replace function public.kp_mail_claim(p_limit int default 20) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; job jsonb; out jsonb := '[]'::jsonb; d jsonb; n int := 0;
begin
  for r in select code, doc from kuponai.vouchers where jsonb_array_length(kuponai.mail_jobs(doc)) > 0 order by created_at for update skip locked loop
    d := r.doc;
    for job in select * from jsonb_array_elements(kuponai.mail_jobs(r.doc)) loop
      exit when n >= p_limit;
      d := jsonb_set(d, '{mail}', coalesce(d->'mail', '{}'::jsonb) || jsonb_build_object(job->>'kind', jsonb_build_object(
        'state', 'sending', 'at', now(), 'tries', coalesce((r.doc->'mail'->(job->>'kind')->>'tries')::int, 0) + 1)));
      out := out || jsonb_build_object('kind', job->>'kind', 'to', job->>'to', 'voucher', kuponai.for_master(r.doc));
      n := n + 1;
    end loop;
    update kuponai.vouchers set doc = d where code = r.code;
    exit when n >= p_limit;
  end loop;
  return out;
end $$;

create or replace function public.kp_mail_done(p_code text, p_kind text, p_ok boolean, p_err text default null) returns void language plpgsql volatile security definer set search_path = '' as $$
declare d jsonb;
begin
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then return; end if;
  d := jsonb_set(d, '{mail}', coalesce(d->'mail', '{}'::jsonb) || jsonb_build_object(p_kind,
    coalesce(d->'mail'->p_kind, '{}'::jsonb) || jsonb_build_object('state', case when p_ok then 'sent' else 'failed' end, 'at', now(), 'err', left(p_err, 300))));
  if p_ok and p_kind = 'recipient' then
    d := jsonb_set(d, '{delivery}', d->'delivery' || jsonb_build_object('sent', true, 'sentAt', now()));
  end if;
  if p_ok then
    d := jsonb_set(d, '{log}', coalesce(d->'log', '[]'::jsonb) || jsonb_build_object('at', now(), 'by', 'El. paštas', 'action', 'mail_' || p_kind));
  end if;
  update kuponai.vouchers set doc = d where code = p_code;
end $$;

-- Master: send the voucher email again (to the buyer, or to the recipient right now).
create or replace function public.kp_mail_resend(p_token text, p_code text, p_kind text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare m text := kuponai.require_master(p_token); d jsonb;
begin
  if p_kind not in ('buyer', 'recipient') then raise exception 'bad_kind'; end if;
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then raise exception 'not_found'; end if;
  d := jsonb_set(d, '{mail}', coalesce(d->'mail', '{}'::jsonb) - p_kind);
  if p_kind = 'recipient' and d->'delivery'->>'mode' = 'recipient' then
    d := jsonb_set(d, '{delivery}', d->'delivery' || jsonb_build_object('sent', false,
      'date', least(coalesce(d->'delivery'->>'date', '9999-12-31'), to_char(now() at time zone 'Europe/Vilnius' - interval '1 day', 'YYYY-MM-DD'))));
  end if;
  d := jsonb_set(d, '{log}', coalesce(d->'log', '[]'::jsonb) || jsonb_build_object('at', now(), 'by', m, 'action', 'resend_' || p_kind));
  update kuponai.vouchers set doc = d where code = p_code;
  return kuponai.for_master(d);
end $$;

-- Poke the mailer over HTTP (async, pg_net).
create or replace function kuponai.mail_kick() returns void language plpgsql volatile security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'mailer_key';
  if k is null then return; end if;
  perform net.http_post(url := 'https://hermojruniqfvxksunrj.supabase.co/functions/v1/mailer',
    headers := jsonb_build_object('content-type', 'application/json', 'x-mailer-key', k), body := '{}'::jsonb, timeout_milliseconds := 20000);
end $$;

create or replace function kuponai.mail_trigger() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_array_length(kuponai.mail_jobs(new.doc)) > 0 then perform kuponai.mail_kick(); end if;
  return null;
end $$;
drop trigger if exists vouchers_mail on kuponai.vouchers;
create trigger vouchers_mail after insert or update on kuponai.vouchers for each row execute function kuponai.mail_trigger();

create or replace function kuponai.mail_cron() returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from kuponai.vouchers where jsonb_array_length(kuponai.mail_jobs(doc)) > 0) then perform kuponai.mail_kick(); end if;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'kuponai-mail';
select cron.schedule('kuponai-mail', '*/15 * * * *', 'select kuponai.mail_cron()');

-- Remember the buyer's language for emails.
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
    'lang', case when p->>'lang' = 'ru' then 'ru' else 'lt' end,
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

revoke all on function kuponai.mail_due(jsonb, text), kuponai.email_ok(text), kuponai.mail_jobs(jsonb), kuponai.mail_kick(),
  kuponai.mail_trigger(), kuponai.mail_cron() from public, anon, authenticated;
revoke all on function public.kp_mail_claim(int), public.kp_mail_done(text, text, boolean, text), public.kp_mail_resend(text, text, text) from public, anon, authenticated;
grant execute on function public.kp_mail_claim(int), public.kp_mail_done(text, text, boolean, text) to service_role;
grant execute on function public.kp_mail_resend(text, text, text) to anon, authenticated;
