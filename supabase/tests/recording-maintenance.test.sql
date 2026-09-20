-- LOCAL transactional metadata fixtures only; no actual object-store files.
begin;
-- These rows have no physical files. Permit only this rolled-back fixture's
-- metadata transitions; production code always uses version-pinned Storage API.
set local storage.allow_delete_query='true';
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000083','maintenance@example.invalid');
insert into public.app_members(user_id) values('00000000-0000-4000-8000-000000000083');
insert into public.service_preferences(user_id) values('00000000-0000-4000-8000-000000000083');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000083',true);
insert into storage.objects(bucket_id,name,owner,version,metadata) values
  ('jove-recordings','00000000-0000-4000-8000-000000000083/english','00000000-0000-4000-8000-000000000083','old-en','{"size":8}');
insert into public.recording_manifest(user_id,audio_id,object_path,sha256,bytes,mime_type,purpose,created_at,expires_at,
  retention_cursor,retention_policy,cleanup_version,recovery_pending)
values(auth.uid(),'english',auth.uid()::text || '/english',repeat('a',64),8,'audio/wav','history',now()-interval '10 days',now()-interval '1 day',
  0,'minimal','forged',true);
do $$
declare reply jsonb; frontier bigint; path text:=auth.uid()::text || '/english';
begin
  if exists(select 1 from public.recording_manifest where retention_cursor is not null or retention_policy is not null or cleanup_version is not null or recovery_pending) then
    raise exception 'Client forged a retention/cleanup receipt'; end if;
  if public.recording_cleanup_allowed(path,'old-en') is true then raise exception 'Unstamped original deletable'; end if;
  if not public.reconcile_recording_retention('english',0,'history',now()-interval '1 day','minimal') then raise exception 'Receipt not stamped'; end if;
  reply:=public.recording_maintenance('prepare-cleanup','en','{"cursor":1,"policy":"minimal"}');
  if reply->>'pending'<>'true' or jsonb_array_length(reply->'candidates')<>0 then raise exception 'Stale frontier admitted'; end if;
  reply:=public.recording_maintenance('prepare-cleanup','en','{"cursor":0,"policy":"minimal"}');
  if jsonb_array_length(reply->'candidates')<>1 or reply#>>'{candidates,0,version}'<>'old-en' then raise exception 'No version-pinned candidate'; end if;
  if public.recording_cleanup_allowed(path,'old-en') is not true then raise exception 'Eligible candidate denied'; end if;
  update public.service_preferences set recording_retention='more-history' where user_id=auth.uid();
  if public.recording_cleanup_allowed(path,'old-en') is true then raise exception 'Policy change ignored'; end if;
  update public.service_preferences set recording_retention='minimal' where user_id=auth.uid();
  perform public.append_sync_operations('[{"id":"00000000-0000-4000-8000-000000000084","deviceId":"00000000-0000-4000-8000-000000000085","logicalClock":1,"entityType":"events","entityId":"new-evidence","kind":"put","schemaVersion":1,"payload":{"record":{"id":"new-evidence","type":"PRACTICE","timestamp":1788815000000,"source":"self-report"}}}]');
  if public.recording_cleanup_allowed(path,'old-en') is true then raise exception 'New evidence ignored'; end if;
  select max(cursor) into frontier from public.sync_operations;
  perform public.reconcile_recording_retention('english',frontier,'assessment',null,'minimal');
  if public.recording_cleanup_allowed(path,'old-en') is true then raise exception 'Assessment deletable'; end if;
  perform public.reconcile_recording_retention('english',frontier,'import',null,'minimal');
  if public.recording_cleanup_allowed(path,'old-en') is true then raise exception 'Import deletable'; end if;
  perform public.reconcile_recording_retention('english',frontier,'draft',null,'minimal');
  if public.recording_cleanup_allowed(path,'old-en') is true then raise exception 'Draft deletable'; end if;
  perform public.reconcile_recording_retention('english',frontier,'history',now()-interval '1 day','minimal');
  reply:=public.recording_maintenance('prepare-recovery','en',jsonb_build_object('audioId','english','version','old-en','sha256',repeat('a',64),'bytes',8));
  if reply->>'state'<>'remove-old' then raise exception 'Recovery not prepared'; end if;
  perform public.reconcile_recording_retention('english',frontier,'history',now()-interval '1 day','minimal');
  if not exists(select 1 from public.recording_manifest where purpose='draft' and expires_at is null and recovery_pending) then
    raise exception 'Legacy reconcile downgraded recovery protection'; end if;
  -- Test-only rows represent the real Storage delete/upload sequence.
  delete from storage.objects where bucket_id='jove-recordings' and name=path and version='old-en';
  reply:=public.recording_maintenance('prepare-recovery','en',jsonb_build_object('audioId','english','version','old-en','sha256',repeat('a',64),'bytes',8));
  if reply->>'state'<>'upload' then raise exception 'Already-deleted version cannot resume'; end if;
  -- Delayed ordinary RPC retries cannot downgrade the durable repair hold.
  if not public.reserve_recording_upload(path,8) then raise exception 'Matching reservation replay denied'; end if;
  insert into storage.objects(bucket_id,name,owner,version,metadata) values('jove-recordings',path,auth.uid(),'new-en','{"size":8}');
  reply:=public.recording_maintenance('finish-cleanup','en','{"audioId":"english","version":"old-en"}');
  if reply->>'state'<>'pending' then raise exception 'Late finalize removed replacement manifest'; end if;
  reply:=public.recording_maintenance('prepare-recovery','en',jsonb_build_object('audioId','english','version','old-en','sha256',repeat('a',64),'bytes',8));
  if reply->>'state'<>'verify-new' then raise exception 'Replacement scheduled for another delete'; end if;
  reply:=public.recording_maintenance('finish-recovery','en',jsonb_build_object('audioId','english','version','old-en','sha256',repeat('a',64),'bytes',8));
  if reply->>'state'<>'recovered' then raise exception 'Recovery not confirmed'; end if;
  delete from storage.objects where bucket_id='jove-recordings' and name=path and version='old-en';
  reply:=public.recording_maintenance('finish-cleanup','en','{"audioId":"english","version":"old-en"}');
  if reply->>'state'<>'unchanged' or not exists(select 1 from public.recording_manifest where audio_id='english') then
    raise exception 'Late cleanup removed restored identity'; end if;
  if not exists(select 1 from storage.objects where name=path and version='new-en') then raise exception 'Replacement lost'; end if;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.recording_upload_reservations where user_id='00000000-0000-4000-8000-000000000083') then raise exception 'Confirmed recovery leaked its hold'; end if;
end $$;

-- Japanese has an independent frontier and the same account policy/capacity.
set local role authenticated;
insert into storage.objects(bucket_id,name,owner,version,metadata) values
  ('jove-recordings',auth.uid()::text || '/ja/ja-id-' || repeat('b',64),auth.uid(),'old-ja','{"size":8}');
insert into public.language_recording_manifest(learning_language,user_id,audio_id,object_path,sha256,bytes,mime_type,purpose,created_at,expires_at)
values('ja',auth.uid(),'ja-id',auth.uid()::text || '/ja/ja-id-' || repeat('b',64),repeat('b',64),8,'audio/wav','history',now()-interval '10 days',now()-interval '1 day');
do $$ declare reply jsonb; begin
  if not public.reconcile_language_recording_retention('ja','ja-id',0,'history',now()-interval '1 day','minimal') then raise exception 'Japanese frontier blended'; end if;
  reply:=public.recording_maintenance('prepare-cleanup','ja','{"cursor":0,"policy":"minimal"}');
  if jsonb_array_length(reply->'candidates')<>1 then raise exception 'Japanese candidate missing'; end if;
end $$;
reset role;
-- Force insufficient recovery headroom; old object must stay intact.
update public.recording_storage_limits set limit_bytes=public.recording_capacity_used('');
set local role authenticated;
do $$ declare reply jsonb; begin
  reply:=public.recording_maintenance('prepare-recovery','ja',jsonb_build_object('audioId','ja-id','version','old-ja','sha256',repeat('b',64),'bytes',8));
  if reply->>'state'<>'capacity' then raise exception 'Unsafe recovery without replacement hold'; end if;
  if not exists(select 1 from storage.objects where version='old-ja') then raise exception 'Old copy removed before reservation'; end if;
  if exists(select 1 from public.language_recording_manifest where recovery_pending) then raise exception 'Failed hold authorized recovery deletion'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000086',true);
do $$ begin
  begin
    perform public.recording_maintenance('prepare-cleanup','en','{"cursor":0,"policy":"minimal"}');
    raise exception 'Nonmember maintenance permitted';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
