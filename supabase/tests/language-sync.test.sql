-- Only isolated local fixtures, including the old-client English contract.
begin;
insert into auth.users(id,email) values
  ('00000000-0000-4000-8000-000000000091','language-a@example.invalid'),
  ('00000000-0000-4000-8000-000000000092','language-b@example.invalid');
insert into public.app_members(user_id) values ('00000000-0000-4000-8000-000000000091');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000091',true);
do $$
declare
  batch jsonb := '[{"id":"00000000-0000-4000-8000-000000000095","deviceId":"00000000-0000-4000-8000-000000000096","logicalClock":1,"entityType":"events","entityId":"same-local-id","kind":"put","schemaVersion":1,"payload":{"record":{"id":"same-local-id","type":"PRACTICE","timestamp":1788815000000,"source":"self-report"}}}]';
  japanese_cursor bigint; retry_cursor bigint; english_count bigint;
begin
  perform public.append_sync_operations(batch);
  select count(*) into english_count from public.sync_operations;
  select cursor into japanese_cursor from public.append_language_sync_operations('ja', batch);
  select cursor into retry_cursor from public.append_language_sync_operations('ja', batch);
  if japanese_cursor is distinct from retry_cursor then raise exception 'Non-idempotent Japanese retry'; end if;
  if (select count(*) from public.language_sync_operations) <> 1 then raise exception 'Duplicate Japanese operation'; end if;
  if (select count(*) from public.sync_operations) <> english_count then raise exception 'Japanese write changed English'; end if;
  if not exists(select 1 from public.language_sync_operations where learning_language='ja') then raise exception 'Missing stream binding'; end if;
  begin
    perform public.append_language_sync_operations('en',batch);
    raise exception 'English accepted by Japanese route';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_language_sync_operations(null,batch);
    raise exception 'Implicit language accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_language_sync_operations('ja',jsonb_set(batch,'{0,logicalClock}','2'));
    raise exception 'Mutable operation identity accepted';
  exception when unique_violation then null; end;
  begin
    perform public.append_language_sync_operations('ja',jsonb_set(jsonb_set(batch,'{0,id}',to_jsonb(gen_random_uuid()::text)),'{0,logicalClock}','5'));
    raise exception 'Clock jump accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_language_sync_operations('ja',jsonb_set(batch,'{0,kind}','"delete"'));
    raise exception 'Evidence deletion accepted';
  exception when invalid_parameter_value then null; end;
  begin
    delete from public.language_sync_operations;
    raise exception 'Direct deletion allowed';
  exception when insufficient_privilege then null; end;
  begin
    update public.language_sync_operations set learning_language='en';
    raise exception 'Direct relabel allowed';
  exception when insufficient_privilege then null; end;
end $$;
insert into public.recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose)
values ('00000000-0000-4000-8000-000000000091','same-audio','00000000-0000-4000-8000-000000000091/original',repeat('a',64),10,'audio/wav','draft');
insert into public.language_recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose,learning_language)
values ('00000000-0000-4000-8000-000000000091','same-audio','00000000-0000-4000-8000-000000000091/ja/original',repeat('b',64),10,'audio/wav','draft','ja');
do $$
declare latest bigint;
begin
  begin
    insert into public.language_recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose,learning_language)
    values ('00000000-0000-4000-8000-000000000091','wrong-path','00000000-0000-4000-8000-000000000091/english',repeat('a',64),10,'audio/wav','draft','ja');
    raise exception 'Japanese manifest accepted English object path';
  exception when check_violation then null; end;
  begin
    insert into public.language_recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose,learning_language)
    values ('00000000-0000-4000-8000-000000000091','encoded-path','00000000-0000-4000-8000-000000000091/ja/%2e%2e/english-original',repeat('a',64),10,'audio/wav','draft','ja');
    raise exception 'Encoded path traversal accepted';
  exception when check_violation then null; end;
  begin
    update public.language_recording_manifest set expires_at=now();
    raise exception 'Unfenced retention update accepted';
  exception when insufficient_privilege then null; end;
  if public.reconcile_language_recording_retention('ja','same-audio',0,'history',now(),'minimal') then raise exception 'Stale Japanese frontier accepted'; end if;
  select max(cursor) into latest from public.language_sync_operations;
  if not public.reconcile_language_recording_retention('ja','same-audio',latest,'history',now(),'minimal') then raise exception 'Current Japanese frontier rejected'; end if;
  if (select expires_at is not null from public.recording_manifest where audio_id='same-audio') then raise exception 'Japanese retention changed English recording'; end if;
  if not (select expires_at is not null from public.language_recording_manifest where audio_id='same-audio') then raise exception 'Japanese retention not saved'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000092',true);
do $$ begin
  if exists(select 1 from public.language_sync_operations) then raise exception 'Other account Japanese data leaked'; end if;
  if exists(select 1 from public.language_recording_manifest) then raise exception 'Other account Japanese recording leaked'; end if;
  begin
    perform public.append_language_sync_operations('ja','[]');
    raise exception 'Nonmember upload allowed';
  exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
  begin
    perform public.append_language_sync_operations('ja','[]');
    raise exception 'Anonymous upload allowed';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
