-- Runs against the dedicated LOCAL Jove database only; all fixtures roll back.
begin;
insert into auth.users(id,email) values
  ('00000000-0000-4000-8000-000000000011','jove-local-a@example.invalid'),
  ('00000000-0000-4000-8000-000000000012','jove-local-b@example.invalid'),
  ('00000000-0000-4000-8000-000000000013','jove-local-nonmember@example.invalid');
insert into public.app_members(user_id) values
  ('00000000-0000-4000-8000-000000000011'),('00000000-0000-4000-8000-000000000012');

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000011',true);
do $$
declare batch jsonb := '[{"id":"00000000-0000-4000-8000-000000000021","deviceId":"00000000-0000-4000-8000-000000000031","logicalClock":1,"entityType":"events","entityId":"attempt-a","kind":"put","schemaVersion":1,"payload":{"record":{"id":"attempt-a","type":"SPEAK_ATTEMPT","timestamp":1788815000000,"source":"objective"},"changed":["[\"id\"]","[\"type\"]","[\"timestamp\"]","[\"source\"]"]}}]';
first_cursor bigint; retry_cursor bigint; candidate jsonb; before_count bigint;
begin
  select cursor into first_cursor from public.append_sync_operations(batch);
  select cursor into retry_cursor from public.append_sync_operations(batch);
  if first_cursor is distinct from retry_cursor then raise exception 'Retry was not idempotent'; end if;
  if (select count(*) from public.sync_operations) <> 1 then raise exception 'Duplicate evidence'; end if;
  select count(*) into before_count from public.sync_operations;
  candidate := jsonb_set(batch,'{0,id}',to_jsonb(gen_random_uuid()::text));
  begin
    perform public.append_sync_operations(jsonb_set(candidate,'{0,logicalClock}','9007199254740990'));
    raise exception 'Poison clock accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_sync_operations(jsonb_set(candidate,'{0,logicalClock}','2') ||
      jsonb_set(jsonb_set(candidate,'{0,id}',to_jsonb(gen_random_uuid()::text)),'{0,logicalClock}','4'));
    raise exception 'Skipped clock batch accepted';
  exception when invalid_parameter_value then null; end;
  if (select count(*) from public.sync_operations) <> before_count then raise exception 'Failed batch was not atomic'; end if;
  perform public.append_sync_operations(jsonb_set(candidate,'{0,logicalClock}','2'));
  perform public.append_sync_operations(jsonb_set(jsonb_set(candidate,'{0,id}',to_jsonb(gen_random_uuid()::text)),'{0,logicalClock}','3'));
  -- A different offline device can still submit clock 1; gaps in cursor are legal.
  perform public.append_sync_operations(jsonb_set(jsonb_set(batch,'{0,id}',to_jsonb(gen_random_uuid()::text)),
    '{0,deviceId}','"00000000-0000-4000-8000-000000000032"'));
  if exists(select 1 from public.sync_operations where logical_clock > cursor) then raise exception 'Impossible receipt accepted'; end if;
  begin
    perform public.append_sync_operations(jsonb_set(batch,'{0,deviceId}','null'));
    raise exception 'Null retry identity accepted';
  exception when unique_violation then null; end;
  begin
    perform public.append_sync_operations(jsonb_set(batch,'{0,logicalClock}','2'));
    raise exception 'Identity collision accepted';
  exception when unique_violation then null; end;
  begin
    perform public.append_sync_operations(jsonb_set(batch,'{0,userId}','"00000000-0000-4000-8000-000000000012"'));
    raise exception 'Caller identity accepted from payload';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_sync_operations(jsonb_set(batch,'{0,kind}','"delete"'));
    raise exception 'Evidence deletion accepted';
  exception when invalid_parameter_value then null; end;
  begin
    delete from public.sync_operations;
    raise exception 'Direct operation deletion allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.sync_operations set logical_clock = 999;
    raise exception 'Direct evidence update allowed';
  exception when insufficient_privilege then null; end;
end $$;

insert into storage.objects(bucket_id,name,owner) values ('jove-recordings',
  '00000000-0000-4000-8000-000000000011/recording.wav','00000000-0000-4000-8000-000000000011');
insert into public.recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose)
values ('00000000-0000-4000-8000-000000000011','recording',
  '00000000-0000-4000-8000-000000000011/recording.wav',repeat('a',64),1000,'audio/wav','draft');
do $$ begin
  begin
    update public.recording_manifest set expires_at = now();
    raise exception 'Unfenced retention update accepted';
  exception when insufficient_privilege then null; end;
  if public.reconcile_recording_retention('recording',0,'history',now(),'minimal') then
    raise exception 'Stale metadata frontier shortened recording retention';
  end if;
  if exists(select 1 from public.recording_manifest where expires_at is not null) then raise exception 'Draft expiry changed'; end if;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000012',true);
do $$ begin
  if exists(select 1 from public.sync_operations) then raise exception 'Other owner evidence leaked'; end if;
  if exists(select 1 from public.recording_manifest) then raise exception 'Other owner metadata leaked'; end if;
  if exists(select 1 from storage.objects where bucket_id='jove-recordings') then raise exception 'Other owner audio leaked'; end if;
  if public.reconcile_recording_retention('recording',0,'history',now(),'minimal') then
    raise exception 'Other owner retention changed';
  end if;
  begin
    insert into storage.objects(bucket_id,name,owner) values ('jove-recordings',
      '00000000-0000-4000-8000-000000000011/stolen.wav','00000000-0000-4000-8000-000000000012');
    raise exception 'Cross-owner audio upload allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose)
    values ('00000000-0000-4000-8000-000000000011','stolen',
      '00000000-0000-4000-8000-000000000011/stolen.wav',repeat('b',64),100,'audio/wav','draft');
    raise exception 'Cross-owner manifest accepted';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000013',true);
do $$ begin
  begin
    perform public.append_sync_operations('[]');
    raise exception 'Nonmember accessed sync RPC';
  exception when insufficient_privilege then null; end;
  begin
    perform public.reconcile_recording_retention('recording',0,'history',now(),'minimal');
    raise exception 'Nonmember changed recording retention';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.app_members(user_id) values ('00000000-0000-4000-8000-000000000013');
    raise exception 'Member self-enrollment allowed';
  exception when insufficient_privilege then null; end;
end $$;

set local role anon;
do $$ begin
  begin
    perform public.append_sync_operations('[]');
    raise exception 'Unauthenticated sync accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.sync_operations;
    raise exception 'Unauthenticated evidence read allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'PASS: real Postgres RLS, owner isolation, private audio, idempotency, immutable evidence, unauthorized RPC, no member self-enrollment';
