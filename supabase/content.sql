-- Editable site content: price list and work gallery, edited by masters in the admin panel.
-- Run after schema.sql. Safe to run again.
-- Photos are stored in the public Storage bucket "works". The browser uploads with the publishable key, but only to a
-- file name a logged-in master got from kp_photo_ticket (random, valid for 1 hour).

create table if not exists kuponai.site_content (
  key text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table kuponai.site_content enable row level security;

create table if not exists kuponai.upload_tickets (
  name text primary key,
  staff text,
  created_at timestamptz not null default now()
);
alter table kuponai.upload_tickets enable row level security;

-- Public: everything the home page needs ({menu, works}; a missing key means "use the built-in default").
create or replace function public.kp_site() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, data), '{}'::jsonb) from kuponai.site_content where key in ('menu', 'works')
$$;

-- Masters: replace the price list ('menu') or the gallery ('works').
create or replace function public.kp_site_save(p_token text, p_key text, p_data jsonb) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare n text := kuponai.require_master(p_token);
begin
  if p_key not in ('menu', 'works') then raise exception 'bad_key'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 200000 then raise exception 'bad_data'; end if;
  if p_key = 'menu' then
    if jsonb_typeof(p_data->'categories') is distinct from 'array' then raise exception 'bad_data'; end if;
    if exists (select 1 from jsonb_array_elements(p_data->'categories') c
               where jsonb_typeof(c) <> 'object' or jsonb_typeof(c->'services') is distinct from 'array' or length(trim(coalesce(c->>'name', ''))) = 0) then
      raise exception 'bad_category'; end if;
    if exists (select 1 from jsonb_array_elements(p_data->'categories') c, jsonb_array_elements(c->'services') s
               where jsonb_typeof(s) <> 'object' or length(trim(coalesce(s->>'name', ''))) = 0 or length(coalesce(s->>'id', '')) = 0
                  or jsonb_typeof(s->'price') is distinct from 'number' or (s->>'price')::numeric < 0 or (s->>'price')::numeric > 10000) then
      raise exception 'bad_service'; end if;
  else
    if jsonb_typeof(p_data->'photos') is distinct from 'array' then raise exception 'bad_data'; end if;
    if exists (select 1 from jsonb_array_elements(p_data->'photos') ph
               where jsonb_typeof(ph) <> 'object' or coalesce(ph->>'src', '') !~ '^(/works/[A-Za-z0-9._-]+|https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/works/[A-Za-z0-9/._-]+)$') then
      raise exception 'bad_photo'; end if;
    if p_data ? 'reviews' and jsonb_typeof(p_data->'reviews') <> 'array' then raise exception 'bad_data'; end if;
  end if;
  insert into kuponai.site_content(key, data, updated_at, updated_by) values (p_key, p_data, now(), n)
    on conflict (key) do update set data = excluded.data, updated_at = now(), updated_by = n;
  return public.kp_site();
end $$;

-- Masters: get a file name to upload one photo to Storage (bucket "works").
create or replace function public.kp_photo_ticket(p_token text) returns text language plpgsql volatile security definer set search_path = '' as $$
declare n text := kuponai.require_master(p_token); f text;
begin
  if (select count(*) from kuponai.upload_tickets where created_at > now() - interval '1 hour') >= 200 then raise exception 'too_many'; end if;
  delete from kuponai.upload_tickets where created_at < now() - interval '2 days';
  f := to_char(now(), 'YYYY-MM') || '/' || replace(gen_random_uuid()::text, '-', '') || '.jpg';
  insert into kuponai.upload_tickets(name, staff) values (f, n);
  return f;
end $$;

-- Used by the Storage policy below: may this file name be uploaded now?
create or replace function public.kp_photo_ok(p_name text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from kuponai.upload_tickets where name = p_name and created_at > now() - interval '1 hour')
$$;

revoke all on function public.kp_site(), public.kp_site_save(text, text, jsonb), public.kp_photo_ticket(text), public.kp_photo_ok(text) from public, anon, authenticated;
grant execute on function public.kp_site(), public.kp_site_save(text, text, jsonb), public.kp_photo_ticket(text), public.kp_photo_ok(text) to anon, authenticated;

-- Storage: public bucket for gallery photos (max 6 MB, images only). Uploads only with a ticket; no overwrite, no delete via the API.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('works', 'works', true, 6291456, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "kp works upload" on storage.objects;
create policy "kp works upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'works' and public.kp_photo_ok(name));
