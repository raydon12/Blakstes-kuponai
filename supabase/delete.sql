-- Masters may permanently delete a voucher, but only one that was cancelled (voided) first.
create or replace function public.kp_delete(p_token text, p_code text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare m text := kuponai.require_master(p_token); d jsonb;
begin
  select doc into d from kuponai.vouchers where code = p_code for update;
  if d is null then raise exception 'not_found'; end if;
  if not coalesce((d->>'voided')::boolean, false) then raise exception 'not_void'; end if;
  delete from kuponai.vouchers where code = p_code;
  return jsonb_build_object('ok', true, 'code', p_code, 'by', m);
end $$;
revoke all on function public.kp_delete(text, text) from public, anon, authenticated;
grant execute on function public.kp_delete(text, text) to anon, authenticated;
