-- Retention receipts and durable deletion intent. An object-store delete and
-- SQL commit are not a distributed transaction; preserve intent across retries.
alter table public.recording_upload_reservations add column held_bytes bigint
  check (held_bytes is null or held_bytes between bytes and 26214400);
create or replace function public.recording_capacity_used(except_reservation text) returns bigint
language sql volatile security definer set search_path = '' as $$
  select coalesce((select sum(public.recording_object_bytes(o.metadata)) from storage.objects o
    where o.bucket_id='jove-recordings'),0)::bigint
    + coalesce((select sum(greatest(coalesce(r.held_bytes,r.bytes)-coalesce((select public.recording_object_bytes(o.metadata)
      from storage.objects o where o.bucket_id='jove-recordings' and o.name=r.object_path),0),0))
      from public.recording_upload_reservations r where r.expires_at>clock_timestamp() and r.object_path<>except_reservation),0)::bigint;
$$;
-- A delayed ordinary-upload RPC must not shorten a recovery's durable hold.
create or replace function public.reserve_recording_upload(object_path text, recording_bytes bigint) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare caller uuid:=auth.uid(); prior public.recording_upload_reservations; existing_size bigint; allowed_bytes bigint;
begin
  if caller is null or not exists(select 1 from public.app_members m where m.user_id=caller) then
    raise exception 'Not authorized' using errcode='42501'; end if;
  if object_path is null or length(object_path)>12000 or object_path not like caller::text || '/%'
    or object_path ~ '(^|/)[.]{1,2}(/|$)' or object_path ~ '[[:cntrl:]]' or position(chr(92) in object_path)>0
    or recording_bytes is null or recording_bytes not between 1 and 26214400 then
    raise exception 'Invalid recording reservation' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('jove-recordings:budget',0));
  select public.recording_object_bytes(o.metadata) into existing_size from storage.objects o
    where o.bucket_id='jove-recordings' and o.name=object_path;
  if found then return existing_size=recording_bytes; end if;
  select * into prior from public.recording_upload_reservations r where r.object_path=reserve_recording_upload.object_path;
  if found and (prior.user_id<>caller or prior.bytes<>recording_bytes) then
    raise exception 'Recording reservation identity changed' using errcode='23505'; end if;
  select limit_bytes into allowed_bytes from public.recording_storage_limits where singleton;
  if allowed_bytes is null or public.recording_capacity_used(object_path)+recording_bytes>allowed_bytes then return false; end if;
  delete from public.recording_upload_reservations r where r.expires_at<=clock_timestamp();
  insert into public.recording_upload_reservations as r(object_path,user_id,bytes,expires_at)
    values(object_path,caller,recording_bytes,clock_timestamp()+interval '1 hour')
    on conflict on constraint recording_upload_reservations_pkey do update set expires_at=greatest(r.expires_at,excluded.expires_at);
  return true;
end $$;
alter table public.recording_manifest
  add column retention_cursor bigint,
  add column retention_policy text,
  add column cleanup_version text,
  add column recovery_pending boolean not null default false;
alter table public.language_recording_manifest
  add column retention_cursor bigint,
  add column retention_policy text,
  add column cleanup_version text,
  add column recovery_pending boolean not null default false;

create function public.lock_recording_owner(caller uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- A single order also prevents mixed-language cleanup/policy deadlocks.
  perform pg_advisory_xact_lock(hashtextextended(caller::text,0));
  perform pg_advisory_xact_lock(hashtextextended(caller::text || ':ja',0));
  insert into public.service_preferences(user_id) values(caller) on conflict do nothing;
  perform 1 from public.service_preferences where user_id=caller for update;
end $$;
revoke all on function public.lock_recording_owner(uuid) from public,anon,authenticated;

create function public.recording_metadata_cursor(caller uuid, learning_language text) returns bigint
language sql volatile security definer set search_path = '' as $$
  select case when learning_language='en' then
    (select coalesce(max(cursor),0) from public.sync_operations where user_id=caller)
  else (select coalesce(max(cursor),0) from public.language_sync_operations where user_id=caller) end;
$$;
revoke all on function public.recording_metadata_cursor(uuid,text) from public,anon,authenticated;

create function public.stamp_recording_retention() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' then
    -- Defaults alone would still permit forged client-supplied receipts/intents.
    new.retention_cursor:=null; new.retention_policy:=null;
    new.cleanup_version:=null; new.recovery_pending:=false;
  elsif new.recovery_pending then
    new.purpose:='draft'; new.expires_at:=null;
    new.retention_cursor:=null; new.retention_policy:=null;
  elsif auth.uid()=new.user_id then
    -- Existing reconcile RPCs hold this language's owner lock and policy row.
    new.retention_cursor:=public.recording_metadata_cursor(new.user_id,
      case when tg_table_name='recording_manifest' then 'en' else 'ja' end);
    select recording_retention into new.retention_policy from public.service_preferences where user_id=new.user_id;
  else
    new.retention_cursor:=null; new.retention_policy:=null;
  end if;
  return new;
end $$;
revoke all on function public.stamp_recording_retention() from public,anon,authenticated;
create trigger stamp_recording_retention before insert or update of purpose,expires_at on public.recording_manifest
  for each row execute function public.stamp_recording_retention();
create trigger stamp_recording_retention before insert or update of purpose,expires_at on public.language_recording_manifest
  for each row execute function public.stamp_recording_retention();

create function public.recording_cleanup_allowed(object_path text, object_version text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare caller uuid:=auth.uid(); language_id text; table_id text; entry record; policy text;
begin
  if caller is null or object_path not like caller::text || '/%'
    or not exists(select 1 from public.app_members where user_id=caller) then return false; end if;
  perform public.lock_recording_owner(caller);
  language_id:=case when object_path like caller::text || '/ja/%' then 'ja' else 'en' end;
  table_id:=case when language_id='en' then 'recording_manifest' else 'language_recording_manifest' end;
  execute format('select * from public.%I where user_id=$1 and object_path=$2 for update',table_id)
    into entry using caller,object_path;
  if entry.user_id is null or entry.cleanup_version is null or entry.cleanup_version is distinct from object_version then return false; end if;
  -- Repair is explicitly authorized only after this owner supplies the original
  -- identity. The old version stays pinned even after a new copy is uploaded.
  if entry.recovery_pending then return true; end if;
  select recording_retention into policy from public.service_preferences where user_id=caller;
  return entry.purpose in ('history','pronunciation') and entry.expires_at<=clock_timestamp()
    and entry.retention_policy=policy
    and entry.retention_cursor=public.recording_metadata_cursor(caller,language_id);
end $$;
revoke all on function public.recording_cleanup_allowed(text,text) from public,anon;
grant execute on function public.recording_cleanup_allowed(text,text) to authenticated;
drop policy own_audio_delete on storage.objects;
create policy own_audio_delete on storage.objects for delete to authenticated
  using (bucket_id='jove-recordings' and public.recording_cleanup_allowed(name,version));

create function public.recording_maintenance(action text, learning_language text, request jsonb default '{}') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare caller uuid:=auth.uid(); table_id text; entry record; candidate record; policy text; capacity bigint;
  frontier bigint; current_version text; current_bytes bigint; candidates jsonb:='[]'; pending boolean:=false; removed integer:=0;
begin
  if caller is null or not exists(select 1 from public.app_members where user_id=caller) then
    raise exception 'Not authorized' using errcode='42501'; end if;
  if learning_language is null or learning_language not in ('en','ja') or action is null
    or action not in ('prepare-cleanup','finish-cleanup','prepare-recovery','finish-recovery')
    or request is null or jsonb_typeof(request)<>'object' or octet_length(request::text)>20000
    or request-array['audioId','version','sha256','bytes','cursor','policy']<>'{}'::jsonb then
    raise exception 'Invalid recording maintenance request' using errcode='22023'; end if;
  perform public.lock_recording_owner(caller);
  table_id:=case when learning_language='en' then 'recording_manifest' else 'language_recording_manifest' end;
  select recording_retention into policy from public.service_preferences where user_id=caller;
  frontier:=public.recording_metadata_cursor(caller,learning_language);
  if action='prepare-cleanup' then
    if (request->>'cursor')::bigint is distinct from frontier or request->>'policy' is distinct from policy then
      return jsonb_build_object('candidates','[]'::jsonb,'pending',true,'removed',0); end if;
    for candidate in execute format('select * from public.%I where user_id=$1 and purpose in (''history'',''pronunciation'')
      and expires_at<=clock_timestamp() and not recovery_pending order by expires_at,audio_id limit 20 for update',table_id) using caller loop
      if candidate.retention_cursor is distinct from frontier or candidate.retention_policy is distinct from policy then pending:=true; continue; end if;
      -- Old English manifests must not acquire rights to Japanese paths.
      if learning_language='en' and candidate.object_path like caller::text || '/ja/%%' then pending:=true; continue; end if;
      select o.version,public.recording_object_bytes(o.metadata) into current_version,current_bytes from storage.objects o
        where o.bucket_id='jove-recordings' and o.name=candidate.object_path;
      if not found then
        -- No Storage row exists: only retire an already-expired app manifest.
        -- No physical file deletion or freed-provider-bytes claim is made here.
        execute format('delete from public.%I where user_id=$1 and audio_id=$2',table_id) using caller,candidate.audio_id;
        removed:=removed+1; continue;
      end if;
      if current_version is null or current_bytes<>candidate.bytes
        or (candidate.cleanup_version is not null and candidate.cleanup_version<>current_version) then pending:=true; continue; end if;
      execute format('update public.%I set cleanup_version=$3 where user_id=$1 and audio_id=$2',table_id)
        using caller,candidate.audio_id,current_version;
      candidates:=candidates || jsonb_build_array(jsonb_build_object('audioId',candidate.audio_id,'path',candidate.object_path,'version',current_version));
    end loop;
    return jsonb_build_object('candidates',candidates,'pending',pending,'removed',removed);
  end if;
  if request->>'audioId' is null or length(request->>'audioId')>1000 then
    raise exception 'Missing recording identity' using errcode='22023'; end if;
  execute format('select * from public.%I where user_id=$1 and audio_id=$2 for update',table_id)
    into entry using caller,request->>'audioId';
  if entry.user_id is null then return jsonb_build_object('state','absent'); end if;
  if entry.cleanup_version is null then return jsonb_build_object('state','unchanged'); end if;
  if request->>'version' is distinct from entry.cleanup_version then return jsonb_build_object('state','conflict'); end if;
  select o.version,public.recording_object_bytes(o.metadata) into current_version,current_bytes from storage.objects o
    where o.bucket_id='jove-recordings' and o.name=entry.object_path;
  if action='finish-cleanup' then
    if entry.recovery_pending or current_version is not null then return jsonb_build_object('state','pending'); end if;
    execute format('delete from public.%I where user_id=$1 and audio_id=$2',table_id) using caller,entry.audio_id;
    delete from public.recording_upload_reservations where object_path=entry.object_path;
    return jsonb_build_object('state','removed');
  end if;
  if request->>'sha256' is distinct from entry.sha256 or (request->>'bytes')::bigint is distinct from entry.bytes then
    raise exception 'Recording recovery identity mismatch' using errcode='23505'; end if;
  if action='prepare-recovery' then
    perform pg_advisory_xact_lock(hashtextextended('jove-recordings:budget',0));
    select o.version,public.recording_object_bytes(o.metadata) into current_version,current_bytes from storage.objects o
      where o.bucket_id='jove-recordings' and o.name=entry.object_path;
    if current_version is null or current_version=entry.cleanup_version then
      select limit_bytes into capacity from public.recording_storage_limits where singleton;
      -- Hold enough for conservative multipart preflight BEFORE deleting V1.
      -- The excess over an existing object is counted, without double counting.
      if capacity is null or public.recording_capacity_used(entry.object_path)-coalesce(current_bytes,0)+26214400>capacity then
        return jsonb_build_object('state','capacity'); end if;
      if exists(select 1 from public.recording_upload_reservations r where r.object_path=entry.object_path and (r.user_id<>caller or r.bytes<>entry.bytes)) then
        raise exception 'Recovery reservation identity mismatch' using errcode='23505'; end if;
      insert into public.recording_upload_reservations as r(object_path,user_id,bytes,expires_at,held_bytes)
        values(entry.object_path,caller,entry.bytes,'infinity',26214400)
        on conflict(object_path) do update set held_bytes=excluded.held_bytes,expires_at=excluded.expires_at;
    end if;
    execute format('update public.%I set recovery_pending=true,purpose=''draft'',expires_at=null,retention_cursor=null,retention_policy=null where user_id=$1 and audio_id=$2',table_id)
      using caller,entry.audio_id;
    return jsonb_build_object('state',case when current_version is null then 'upload' when current_version=entry.cleanup_version then 'remove-old' else 'verify-new' end,
      'path',entry.object_path,'version',entry.cleanup_version,'currentVersion',current_version);
  end if;
  if not entry.recovery_pending or current_version is null or current_version=entry.cleanup_version or current_bytes<>entry.bytes then
    return jsonb_build_object('state','pending'); end if;
  execute format('update public.%I set recovery_pending=false,cleanup_version=null,retention_cursor=null,retention_policy=null where user_id=$1 and audio_id=$2',table_id)
    using caller,entry.audio_id;
  delete from public.recording_upload_reservations where object_path=entry.object_path;
  return jsonb_build_object('state','recovered');
end $$;
revoke all on function public.recording_maintenance(text,text,jsonb) from public,anon;
grant execute on function public.recording_maintenance(text,text,jsonb) to authenticated;
