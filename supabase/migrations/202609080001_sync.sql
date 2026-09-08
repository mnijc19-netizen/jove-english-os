-- Dedicated Jove backend only. No credentials or owner identity belongs in migrations.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_members enable row level security;
create policy own_membership on public.app_members for select to authenticated using (user_id = (select auth.uid()));
grant select on public.app_members to authenticated;
revoke all on public.app_members from anon;

create table public.sync_operations (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  device_id uuid not null,
  logical_clock bigint not null check (logical_clock > 0 and logical_clock < 9007199254740991),
  entity_type text not null check (entity_type in ('settings','profiles','events','chunks','cards','errors','materials','sessions','plans','conversations','assessments','usage','audioMetadata')),
  entity_id text not null check (length(entity_id) between 1 and 1000),
  kind text not null check (kind in ('put','delete')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576),
  schema_version integer not null check (schema_version = 1),
  cursor bigint generated always as identity unique,
  received_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index sync_operations_user_cursor on public.sync_operations(user_id, cursor);
alter table public.sync_operations enable row level security;
create policy owner_read on public.sync_operations for select to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())));
revoke all on public.sync_operations from anon, authenticated;
grant select on public.sync_operations to authenticated;

-- Serialize each owner's uploads through commit; a cursor must never skip a lower
-- sequence whose transaction has not committed yet. Direct client inserts are forbidden.
create function public.append_sync_operations(operations jsonb)
returns table(id uuid, cursor bigint, received_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); op jsonb; old public.sync_operations; inserted public.sync_operations;
begin
  if caller is null or not exists (select 1 from public.app_members m where m.user_id = caller) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(operations) <> 'array' or jsonb_array_length(operations) > 100 or octet_length(operations::text) > 4194304 then
    raise exception 'Invalid sync batch' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  for op in select value from jsonb_array_elements(operations) loop
    if (op - array['id','deviceId','logicalClock','entityType','entityId','kind','payload','schemaVersion']) <> '{}'::jsonb then
      raise exception 'Unexpected sync fields' using errcode = '22023';
    end if;
    if op->>'entityType' = 'events' and op->>'kind' = 'delete' then
      raise exception 'Learning evidence is append-only' using errcode = '22023';
    end if;
    select * into old from public.sync_operations s where s.user_id = caller and s.id = (op->>'id')::uuid;
    if found then
      if old.device_id <> (op->>'deviceId')::uuid or old.logical_clock <> (op->>'logicalClock')::bigint
        or old.entity_type <> op->>'entityType' or old.entity_id <> op->>'entityId'
        or old.kind <> op->>'kind' or old.payload <> op->'payload' or old.schema_version <> (op->>'schemaVersion')::int then
        raise exception 'Operation identity collision' using errcode = '23505';
      end if;
      return query select old.id, old.cursor, old.received_at;
    else
      insert into public.sync_operations(user_id,id,device_id,logical_clock,entity_type,entity_id,kind,payload,schema_version)
      values (caller,(op->>'id')::uuid,(op->>'deviceId')::uuid,(op->>'logicalClock')::bigint,
        op->>'entityType',op->>'entityId',op->>'kind',op->'payload',(op->>'schemaVersion')::int)
      returning * into inserted;
      return query select inserted.id, inserted.cursor, inserted.received_at;
    end if;
  end loop;
end;
$$;
revoke all on function public.append_sync_operations(jsonb) from public, anon;
grant execute on function public.append_sync_operations(jsonb) to authenticated;

create table public.recording_manifest (
  user_id uuid not null references auth.users(id) on delete cascade,
  audio_id text not null,
  object_path text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 1 and 26214400),
  mime_type text not null,
  purpose text not null check (purpose in ('assessment','pronunciation','draft','history','import')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key(user_id, audio_id),
  check (object_path like user_id::text || '/%')
);
alter table public.recording_manifest enable row level security;
create policy own_recordings on public.recording_manifest for all to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())));
grant select,insert,update,delete on public.recording_manifest to authenticated;
revoke all on public.recording_manifest from anon;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('jove-recordings','jove-recordings',false,26214400,
  array['audio/webm','audio/mp4','audio/wav','audio/x-wav','audio/mpeg','audio/ogg','audio/aac'])
on conflict (id) do nothing;
create policy own_audio on storage.objects for all to authenticated
  using (bucket_id = 'jove-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())))
  with check (bucket_id = 'jove-recordings' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())));
