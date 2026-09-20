-- Storage checks client RLS in a rolled-back preflight, then commits using its
-- own privileged role. RLS alone therefore cannot enforce a concurrent quota.
-- This scoped trigger verifies actual metadata at commit, including that role.
-- It never writes/deletes Storage rows itself or touches another bucket.
create function public.enforce_recording_storage_capacity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare incoming bigint; reserved bigint; allowed_bytes bigint;
begin
  if tg_op = 'UPDATE' then
    if old.bucket_id = 'jove-recordings' or new.bucket_id = 'jove-recordings' then
      if row(old.bucket_id,old.name,old.owner_id,old.version,old.metadata->>'size')
        is distinct from row(new.bucket_id,new.name,new.owner_id,new.version,new.metadata->>'size') then
        raise exception 'Recording originals are immutable' using errcode = '23505';
      end if;
    end if;
    return new;
  end if;
  if new.bucket_id <> 'jove-recordings' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('jove-recordings:budget',0));
  -- INSERT ... ON CONFLICT will run the immutable UPDATE guard next. An
  -- existing object's unchanged metadata does not consume additional capacity.
  if exists(select 1 from storage.objects o where o.bucket_id=new.bucket_id and o.name=new.name) then return new; end if;
  incoming := public.recording_object_bytes(new.metadata);
  if incoming > 26214400 then raise exception 'Recording exceeds per-file allowance' using errcode = '22023'; end if;
  select r.bytes into reserved from public.recording_upload_reservations r
    where r.object_path=new.name and r.expires_at > clock_timestamp();
  if reserved is not null and new.metadata->>'size' ~ '^[0-9]{1,15}$' and incoming > reserved then
    raise exception 'Recording exceeds reserved bytes' using errcode = '22023';
  end if;
  select limit_bytes into allowed_bytes from public.recording_storage_limits where singleton;
  if allowed_bytes is null or public.recording_capacity_used(new.name) + incoming > allowed_bytes then
    raise exception 'Shared cloud recording storage is full' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.enforce_recording_storage_capacity() from public, anon, authenticated;
create trigger enforce_recording_storage_capacity before insert or update on storage.objects
  for each row execute function public.enforce_recording_storage_capacity();
