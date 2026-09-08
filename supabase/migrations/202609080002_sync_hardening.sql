-- Additive hardening: never rewrite or delete an existing operation or owner record.
-- A historical impossible clock aborts migration for explicit recovery, not silent loss.
alter table public.sync_operations add constraint sync_clock_receipt_bound
  check (logical_clock <= cursor and cursor < 9007199254740991);
create index sync_operations_owner_clock on public.sync_operations(user_id, logical_clock desc);

create or replace function public.append_sync_operations(operations jsonb)
returns table(id uuid, cursor bigint, received_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); op jsonb; old public.sync_operations; inserted public.sync_operations;
  known_clock bigint; incoming_clock bigint;
begin
  if caller is null or not exists (select 1 from public.app_members m where m.user_id = caller) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if operations is null or jsonb_typeof(operations) is distinct from 'array' then
    raise exception 'Invalid sync batch' using errcode = '22023';
  end if;
  if jsonb_array_length(operations) > 100 or octet_length(operations::text) > 4194304 then
    raise exception 'Invalid sync batch' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select coalesce(max(s.logical_clock), 0) into known_clock from public.sync_operations s where s.user_id = caller;
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
    select * into old from public.sync_operations s where s.user_id = caller and s.id = (op->>'id')::uuid;
    if found then
      if old.device_id is distinct from (op->>'deviceId')::uuid or old.logical_clock is distinct from incoming_clock
        or old.entity_type is distinct from op->>'entityType' or old.entity_id is distinct from op->>'entityId'
        or old.kind is distinct from op->>'kind' or old.payload is distinct from op->'payload'
        or old.schema_version is distinct from (op->>'schemaVersion')::int then
        raise exception 'Operation identity collision' using errcode = '23505';
      end if;
      return query select old.id, old.cursor, old.received_at;
    else
      -- Offline devices can submit older clocks. Advancing the maximum requires
      -- each intervening operation in order, all under the existing owner lock.
      if incoming_clock > known_clock + 1 then
        raise exception 'Logical clock jump; reconcile and recover the pending journal' using errcode = '22023';
      end if;
      insert into public.sync_operations(user_id,id,device_id,logical_clock,entity_type,entity_id,kind,payload,schema_version)
      values (caller,(op->>'id')::uuid,(op->>'deviceId')::uuid,incoming_clock,
        op->>'entityType',op->>'entityId',op->>'kind',op->'payload',(op->>'schemaVersion')::int)
      returning * into inserted;
      known_clock := greatest(known_clock, incoming_clock);
      return query select inserted.id, inserted.cursor, inserted.received_at;
    end if;
  end loop;
end;
$$;
revoke all on function public.append_sync_operations(jsonb) from public, anon;
grant execute on function public.append_sync_operations(jsonb) to authenticated;

-- Retention decisions are valid only for a complete owner metadata frontier.
-- A concurrent draft upload takes the same lock and invalidates an older view.
create function public.reconcile_recording_retention(recording_id text, expected_cursor bigint,
  retention_purpose text, retention_expires_at timestamptz, expected_policy text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); current_cursor bigint; current_policy text;
begin
  if caller is null or not exists(select 1 from public.app_members m where m.user_id = caller) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if expected_cursor is null or expected_cursor < 0 or recording_id is null
    or retention_purpose is null or retention_purpose not in ('assessment','pronunciation','draft','history','import')
    or (retention_purpose in ('assessment','draft','import') and retention_expires_at is not null) then
    raise exception 'Invalid recording retention' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select coalesce(max(s.cursor),0) into current_cursor from public.sync_operations s where s.user_id = caller;
  if current_cursor <> expected_cursor then return false; end if;
  -- 003 owns this table. Until that migration exists, retain every original.
  if to_regclass('public.service_preferences') is null then return false; end if;
  execute 'insert into public.service_preferences(user_id) values ($1) on conflict do nothing' using caller;
  execute 'select recording_retention from public.service_preferences where user_id=$1 for update'
    into current_policy using caller;
  if current_policy is distinct from expected_policy then return false; end if;
  update public.recording_manifest set purpose = retention_purpose, expires_at = retention_expires_at
    where user_id = caller and audio_id = recording_id;
  return found;
end $$;
revoke all on function public.reconcile_recording_retention(text,bigint,text,timestamptz,text) from public, anon;
grant execute on function public.reconcile_recording_retention(text,bigint,text,timestamptz,text) to authenticated;

-- An existing audio ID always identifies the same original bytes. Policy changes
-- go through the frontier-checked RPC; keep service-role cleanup privileges.
revoke update on public.recording_manifest from authenticated;
create function public.preserve_recording_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if row(new.user_id,new.audio_id,new.object_path,new.sha256,new.bytes,new.mime_type,new.created_at)
    is distinct from row(old.user_id,old.audio_id,old.object_path,old.sha256,old.bytes,old.mime_type,old.created_at) then
    raise exception 'Recording identity is immutable' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger preserve_recording_identity before update on public.recording_manifest
  for each row execute function public.preserve_recording_identity();
