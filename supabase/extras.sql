-- Apply after mail.sql.
-- 1) Unpaid online orders are cancelled after 7 days.
-- 2) Weekly backup: the mailer emails all vouchers (CSV + JSON) to the salon on Mondays.
-- 3) Masters manage their password and other masters from the admin panel.

-- 1) auto-cancel
create or replace function kuponai.auto_cancel() returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  update kuponai.vouchers set doc = doc || jsonb_build_object('voided', true, 'autoCancelled', now())
    || jsonb_build_object('log', coalesce(doc->'log', '[]'::jsonb) || jsonb_build_object('at', now(), 'by', 'Sistema', 'action', 'auto_cancel'))
  where doc->>'source' = 'online' and doc->'payment'->>'status' = 'pending'
    and not coalesce((doc->>'voided')::boolean, false) and created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
select cron.unschedule(jobid) from cron.job where jobname = 'kuponai-auto-cancel';
select cron.schedule('kuponai-auto-cancel', '17 2 * * *', 'select kuponai.auto_cancel()');

-- 2) weekly backup (Monday 07:00 UTC)
create or replace function public.kp_backup_export() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(kuponai.for_master(doc) order by created_at), '[]'::jsonb) from kuponai.vouchers
$$;
select cron.unschedule(jobid) from cron.job where jobname = 'kuponai-backup';
select cron.schedule('kuponai-backup', '0 7 * * 1', $$select kuponai.mail_kick('{"backup": true}'::jsonb)$$);

-- 3) masters
create or replace function public.kp_change_password(p_token text, p_old text, p_new text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sid uuid; st kuponai.staff;
begin
  perform kuponai.require_master(p_token);
  select s.staff_id into sid from kuponai.sessions s where s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
  select * into st from kuponai.staff where id = sid;
  if st.pw_hash <> extensions.crypt(coalesce(p_old,''), st.pw_hash) then raise exception 'bad_password'; end if;
  if length(coalesce(p_new,'')) < 8 then raise exception 'short_password'; end if;
  update kuponai.staff set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf')) where id = sid;
  -- sign out every other device
  delete from kuponai.sessions where staff_id = sid and token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kp_staff_list(p_token text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare sid uuid;
begin
  perform kuponai.require_master(p_token);
  select s.staff_id into sid from kuponai.sessions s where s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'createdAt', created_at, 'me', id = sid) order by created_at)
    from kuponai.staff), '[]'::jsonb);
end $$;

create or replace function public.kp_staff_add(p_token text, p_name text, p_email text, p_password text) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare e text := lower(trim(coalesce(p_email,'')));
begin
  perform kuponai.require_master(p_token);
  if length(trim(coalesce(p_name,''))) < 2 then raise exception 'bad_name'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if length(coalesce(p_password,'')) < 8 then raise exception 'short_password'; end if;
  if exists (select 1 from kuponai.staff where email = e) then raise exception 'email_taken'; end if;
  insert into kuponai.staff(name, email, pw_hash) values (left(trim(p_name), 60), e, extensions.crypt(p_password, extensions.gen_salt('bf')));
  return public.kp_staff_list(p_token);
end $$;

create or replace function public.kp_staff_remove(p_token text, p_id uuid) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare sid uuid;
begin
  perform kuponai.require_master(p_token);
  select s.staff_id into sid from kuponai.sessions s where s.token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
  if p_id = sid then raise exception 'self'; end if;
  delete from kuponai.sessions where staff_id = p_id;
  delete from kuponai.staff where id = p_id;
  return public.kp_staff_list(p_token);
end $$;

revoke all on function kuponai.auto_cancel() from public, anon, authenticated;
revoke all on function public.kp_backup_export(), public.kp_change_password(text, text, text), public.kp_staff_list(text),
  public.kp_staff_add(text, text, text, text), public.kp_staff_remove(text, uuid) from public, anon, authenticated;
grant execute on function public.kp_backup_export() to service_role;
grant execute on function public.kp_change_password(text, text, text), public.kp_staff_list(text),
  public.kp_staff_add(text, text, text, text), public.kp_staff_remove(text, uuid) to anon, authenticated;
