-- English table/RPC/cursors remain untouched, including access by old clients.
-- Japanese reuses the operation contract in a separate, owner-isolated stream.
create table public.language_sync_operations (
  like public.sync_operations including defaults including generated including identity including constraints,
  learning_language text not null check (learning_language = 'ja'),
  primary key (user_id, id), unique (cursor),
  foreign key (user_id) references auth.users(id) on delete cascade
);
create index language_sync_owner_cursor on public.language_sync_operations(user_id, learning_language, cursor);
create index language_sync_owner_clock on public.language_sync_operations(user_id, logical_clock desc);
alter table public.language_sync_operations enable row level security;
create policy owner_read on public.language_sync_operations for select to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())));
revoke all on public.language_sync_operations from public, anon, authenticated;
grant select on public.language_sync_operations to authenticated;
grant all on public.language_sync_operations to service_role;

create function public.append_language_sync_operations(learning_language text, operations jsonb)
returns table(id uuid, cursor bigint, received_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); op jsonb; old public.language_sync_operations; inserted public.language_sync_operations;
  known_clock bigint; incoming_clock bigint;
begin
  if caller is null or not exists (select 1 from public.app_members m where m.user_id = caller) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if learning_language is distinct from 'ja' then
    raise exception 'Unsupported learning stream' using errcode = '22023';
  end if;
  if operations is null or jsonb_typeof(operations) is distinct from 'array' then
    raise exception 'Invalid sync batch' using errcode = '22023';
  end if;
  if jsonb_array_length(operations) > 100 or octet_length(operations::text) > 4194304 then
    raise exception 'Invalid sync batch' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text || ':ja', 0));
  select coalesce(max(s.logical_clock), 0) into known_clock from public.language_sync_operations s where s.user_id = caller;
  for op in select value from jsonb_array_elements(operations) loop
    if jsonb_typeof(op) is distinct from 'object'
      or not (op ?& array['id','deviceId','logicalClock','entityType','entityId','kind','payload','schemaVersion'])
      or (op - array['id','deviceId','logicalClock','entityType','entityId','kind','payload','schemaVersion']) <> '{}'::jsonb
      or jsonb_typeof(op->'logicalClock') is distinct from 'number'
      or (op->>'logicalClock') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(op->'payload') is distinct from 'object' then
      raise exception 'Invalid sync operation' using errcode = '22023';
    end if;
    if (op->>'entityType' = 'events' and op->>'kind' = 'delete')
      or (op->>'kind' = 'delete' and op->'payload' <> '{}'::jsonb) then
      raise exception 'Invalid evidence deletion' using errcode = '22023';
    end if;
    incoming_clock := (op->>'logicalClock')::bigint;
    select * into old from public.language_sync_operations s where s.user_id = caller and s.id = (op->>'id')::uuid;
    if found then
      if old.device_id is distinct from (op->>'deviceId')::uuid or old.logical_clock is distinct from incoming_clock
        or old.entity_type is distinct from op->>'entityType' or old.entity_id is distinct from op->>'entityId'
        or old.kind is distinct from op->>'kind' or old.payload is distinct from op->'payload'
        or old.schema_version is distinct from (op->>'schemaVersion')::int then
        raise exception 'Operation identity collision' using errcode = '23505';
      end if;
      return query select old.id, old.cursor, old.received_at;
    else
      if incoming_clock > known_clock + 1 then
        raise exception 'Logical clock jump; reconcile the pending journal' using errcode = '22023';
      end if;
      insert into public.language_sync_operations(user_id,learning_language,id,device_id,logical_clock,entity_type,entity_id,kind,payload,schema_version)
      values (caller,learning_language,(op->>'id')::uuid,(op->>'deviceId')::uuid,incoming_clock,
        op->>'entityType',op->>'entityId',op->>'kind',op->'payload',(op->>'schemaVersion')::int)
      returning * into inserted;
      known_clock := greatest(known_clock, incoming_clock);
      return query select inserted.id, inserted.cursor, inserted.received_at;
    end if;
  end loop;
end;
$$;
revoke all on function public.append_language_sync_operations(text,jsonb) from public, anon;
grant execute on function public.append_language_sync_operations(text,jsonb) to authenticated;

-- Shared private bucket, distinct language path and manifest: even equal local
-- recording IDs cannot resolve to another language's original bytes.
create table public.language_recording_manifest (
  like public.recording_manifest including defaults including constraints,
  learning_language text not null check (learning_language = 'ja'),
  primary key (user_id, audio_id), unique (object_path),
  foreign key (user_id) references auth.users(id) on delete cascade,
  check (left(object_path, length(user_id::text || '/ja/')) = user_id::text || '/ja/'),
  check (strpos(substring(object_path from length(user_id::text || '/ja/') + 1), '/') = 0
    and strpos(object_path, chr(92)) = 0 and object_path !~ '[[:cntrl:]]'
    and object_path !~* '%(2e|2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)')
);
alter table public.language_recording_manifest enable row level security;
create policy own_recordings on public.language_recording_manifest for all to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())));
revoke all on public.language_recording_manifest from public, anon, authenticated;
grant select, insert, delete on public.language_recording_manifest to authenticated;
grant all on public.language_recording_manifest to service_role;
create trigger preserve_recording_identity before update on public.language_recording_manifest
  for each row execute function public.preserve_recording_identity();

create function public.reconcile_language_recording_retention(learning_language text, recording_id text, expected_cursor bigint,
  retention_purpose text, retention_expires_at timestamptz, expected_policy text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); current_cursor bigint; current_policy text;
begin
  if caller is null or not exists(select 1 from public.app_members m where m.user_id = caller) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if learning_language is distinct from 'ja' or expected_cursor is null or expected_cursor < 0 or recording_id is null
    or retention_purpose is null or retention_purpose not in ('assessment','pronunciation','draft','history','import')
    or (retention_purpose in ('assessment','draft','import') and retention_expires_at is not null) then
    raise exception 'Invalid recording retention' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text || ':ja', 0));
  select coalesce(max(s.cursor),0) into current_cursor from public.language_sync_operations s where s.user_id = caller;
  if current_cursor <> expected_cursor then return false; end if;
  insert into public.service_preferences(user_id) values (caller) on conflict do nothing;
  select recording_retention into current_policy from public.service_preferences where user_id=caller for update;
  if current_policy is distinct from expected_policy then return false; end if;
  update public.language_recording_manifest set purpose = retention_purpose, expires_at = retention_expires_at
    where user_id = caller and audio_id = recording_id;
  return found;
end $$;
revoke all on function public.reconcile_language_recording_retention(text,text,bigint,text,timestamptz,text) from public, anon;
grant execute on function public.reconcile_language_recording_retention(text,text,bigint,text,timestamptz,text) to authenticated;
