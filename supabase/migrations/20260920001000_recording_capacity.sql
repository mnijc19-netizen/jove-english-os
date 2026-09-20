-- One cloud allowance for both languages/devices. Storage metadata is read-only:
-- only the Storage API writes/deletes physical objects. Existing originals stay.
create table public.recording_storage_limits (
  singleton boolean primary key default true check (singleton),
  limit_bytes bigint not null default 209715200 check (limit_bytes between 1 and 1073741824)
);
insert into public.recording_storage_limits default values;
create table public.recording_upload_reservations (
  object_path text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  bytes bigint not null check (bytes between 1 and 26214400),
  expires_at timestamptz not null,
  check (object_path like user_id::text || '/%')
);
alter table public.recording_storage_limits enable row level security;
alter table public.recording_upload_reservations enable row level security;
revoke all on public.recording_storage_limits, public.recording_upload_reservations from public, anon, authenticated;
grant all on public.recording_storage_limits, public.recording_upload_reservations to service_role;

create function public.recording_object_bytes(metadata jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select case when metadata->>'size' ~ '^[0-9]{1,15}$' then
    case when (metadata->>'size')::numeric > 0 then (metadata->>'size')::bigint else 26214400 end
    else 26214400 end;
$$;
revoke all on function public.recording_object_bytes(jsonb) from public, anon, authenticated;

-- Called only after taking the shared transaction lock. Includes unconfirmed and
-- orphan objects; a reservation with an existing object is never counted twice.
create function public.recording_capacity_used(except_reservation text) returns bigint
language sql volatile security definer set search_path = '' as $$
  select coalesce((select sum(public.recording_object_bytes(o.metadata)) from storage.objects o
    where o.bucket_id = 'jove-recordings'),0)::bigint
    + coalesce((select sum(r.bytes) from public.recording_upload_reservations r
      where r.expires_at > clock_timestamp() and r.object_path <> except_reservation
        and not exists(select 1 from storage.objects o where o.bucket_id = 'jove-recordings' and o.name = r.object_path)),0)::bigint;
$$;
revoke all on function public.recording_capacity_used(text) from public, anon, authenticated;

create function public.reserve_recording_upload(object_path text, recording_bytes bigint) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare caller uuid := auth.uid(); prior public.recording_upload_reservations; existing_size bigint; allowed_bytes bigint;
begin
  if caller is null or not exists(select 1 from public.app_members m where m.user_id = caller) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if object_path is null or length(object_path) > 12000 or object_path not like caller::text || '/%'
    or object_path ~ '(^|/)[.]{1,2}(/|$)' or object_path ~ '[[:cntrl:]]' or position(chr(92) in object_path) > 0
    or recording_bytes is null or recording_bytes not between 1 and 26214400 then
    raise exception 'Invalid recording reservation' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('jove-recordings:budget',0));
  select public.recording_object_bytes(o.metadata) into existing_size from storage.objects o
    where o.bucket_id = 'jove-recordings' and o.name = object_path;
  if found then return existing_size = recording_bytes; end if;
  select * into prior from public.recording_upload_reservations r where r.object_path = reserve_recording_upload.object_path;
  if found and (prior.user_id <> caller or prior.bytes <> recording_bytes) then
    raise exception 'Recording reservation identity changed' using errcode = '23505';
  end if;
  select limit_bytes into allowed_bytes from public.recording_storage_limits where singleton;
  if allowed_bytes is null or public.recording_capacity_used(object_path) + recording_bytes > allowed_bytes then return false; end if;
  -- Expired reservations can be removed without touching any user audio.
  delete from public.recording_upload_reservations r where r.expires_at <= clock_timestamp();
  insert into public.recording_upload_reservations as r(object_path,user_id,bytes,expires_at)
    values (object_path,caller,recording_bytes,clock_timestamp() + interval '1 hour')
    on conflict on constraint recording_upload_reservations_pkey do update set expires_at = excluded.expires_at;
  return true;
end $$;
revoke all on function public.reserve_recording_upload(text,bigint) from public, anon;
grant execute on function public.reserve_recording_upload(text,bigint) to authenticated;

-- Final INSERT is independently fenced, including legacy clients and late
-- uploads whose reservations expired. Missing/invalid size costs a full 25 MiB.
create function public.admit_recording_object(object_path text, object_metadata jsonb) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare caller uuid := auth.uid(); incoming bigint; reserved bigint; allowed_bytes bigint;
begin
  if caller is null or object_path is null or object_path not like caller::text || '/%'
    or length(object_path) > 12000 or object_path ~ '(^|/)[.]{1,2}(/|$)' or object_path ~ '[[:cntrl:]]'
    or position(chr(92) in object_path) > 0
    or not exists(select 1 from public.app_members m where m.user_id = caller) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('jove-recordings:budget',0));
  incoming := public.recording_object_bytes(object_metadata);
  if incoming > 26214400 then return false; end if;
  select r.bytes into reserved from public.recording_upload_reservations r
    where r.object_path = admit_recording_object.object_path and r.user_id = caller and r.expires_at > clock_timestamp();
  if reserved is not null and object_metadata->>'size' ~ '^[0-9]{1,15}$'
    and incoming > reserved then return false; end if;
  select limit_bytes into allowed_bytes from public.recording_storage_limits where singleton;
  return allowed_bytes is not null and public.recording_capacity_used(object_path) + incoming <= allowed_bytes;
end $$;
revoke all on function public.admit_recording_object(text,jsonb) from public, anon;
grant execute on function public.admit_recording_object(text,jsonb) to authenticated;

drop policy own_audio on storage.objects;
create policy own_audio_read on storage.objects for select to authenticated
  using (bucket_id = 'jove-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists(select 1 from public.app_members m where m.user_id = (select auth.uid())));
create policy own_audio_delete on storage.objects for delete to authenticated
  using (bucket_id = 'jove-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists(select 1 from public.app_members m where m.user_id = (select auth.uid())));
create policy own_audio_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'jove-recordings' and public.admit_recording_object(name,metadata));
-- No UPDATE policy: an original is immutable, and clients use upsert:false.
