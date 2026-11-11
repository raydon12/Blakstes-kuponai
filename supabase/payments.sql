-- Online card payments (Stripe). Only the Edge Functions (service_role) can call these.
create or replace function public.kp_pay_info(p_code text) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code', code, 'amount', (doc->>'amount')::numeric, 'status', kuponai.status(doc),
    'email', doc->>'buyerEmail', 'source', doc->>'source')
  from kuponai.vouchers where code = upper(trim(p_code));
$$;

create or replace function public.kp_mark_paid(p_code text, p_session text, p_cents bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare d jsonb;
begin
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then raise exception 'not_found'; end if;
  if d->'payment'->>'status' = 'paid' then return jsonb_build_object('ok', true, 'already', true); end if;
  if round((d->>'amount')::numeric * 100) <> p_cents then raise exception 'amount_mismatch'; end if;
  d := jsonb_set(d, '{payment}', jsonb_build_object('provider', 'stripe', 'status', 'paid', 'session', p_session, 'paidAt', now()));
  d := jsonb_set(d, '{log}', coalesce(d->'log', '[]'::jsonb) || jsonb_build_object('at', now(), 'by', 'Stripe', 'action', 'paid'));
  update kuponai.vouchers set doc = d where code = p_code;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.kp_pay_info(text), public.kp_mark_paid(text, text, bigint) from public, anon, authenticated;
grant execute on function public.kp_pay_info(text), public.kp_mark_paid(text, text, bigint) to service_role;
