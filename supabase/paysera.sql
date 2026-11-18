-- Online payments via Paysera. Only the Edge Functions (service_role) can call these. Safe to run again.
-- Replaces the earlier Stripe version (kp_mark_paid with 3 arguments).
drop function if exists public.kp_mark_paid(text, text, bigint);

create or replace function public.kp_pay_info(p_code text) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code', code, 'amount', (doc->>'amount')::numeric, 'status', kuponai.status(doc),
    'email', doc->>'buyerEmail', 'source', doc->>'source', 'lang', doc->>'lang')
  from kuponai.vouchers where code = upper(trim(p_code));
$$;

-- Marks an online order paid. Checks the amount in cents. Repeated callbacks are harmless.
-- An order that the nightly job cancelled as unpaid, but which the buyer paid later, is restored.
create or replace function public.kp_mark_paid(p_code text, p_provider text, p_ref text, p_cents bigint, p_test boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d jsonb; restored boolean := false;
begin
  select doc into d from kuponai.vouchers where code = upper(trim(p_code)) for update;
  if d is null then raise exception 'not_found'; end if;
  if d->'payment'->>'status' = 'paid' then return jsonb_build_object('ok', true, 'already', true); end if;
  if round((d->>'amount')::numeric * 100) <> p_cents then raise exception 'amount_mismatch'; end if;
  if coalesce((d->>'voided')::boolean, false) and (d->'log'->-1->>'action') = 'auto_cancel' then
    d := d || jsonb_build_object('voided', false); restored := true;
  end if;
  d := jsonb_set(d, '{payment}', jsonb_build_object('provider', p_provider, 'status', 'paid', 'ref', p_ref, 'paidAt', now())
    || case when p_test then jsonb_build_object('test', true) else '{}'::jsonb end);
  d := jsonb_set(d, '{log}', coalesce(d->'log', '[]'::jsonb) || (jsonb_build_object('at', now(), 'by', initcap(p_provider), 'action', 'paid')
    || case when restored then jsonb_build_object('restored', true) else '{}'::jsonb end
    || case when p_test then jsonb_build_object('test', true) else '{}'::jsonb end));
  update kuponai.vouchers set doc = d where code = upper(trim(p_code));
  return jsonb_build_object('ok', true, 'restored', restored);
end $$;

revoke all on function public.kp_pay_info(text), public.kp_mark_paid(text, text, text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.kp_pay_info(text), public.kp_mark_paid(text, text, text, bigint, boolean) to service_role;
