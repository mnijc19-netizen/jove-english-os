-- Run inside caller-owned BEGIN/ROLLBACK against dedicated Jove only. No persistent fixture approval.
do $$
declare source_key text := 'test-content-sql-'||replace(gen_random_uuid()::text,'-','');
  owner_key uuid := gen_random_uuid(); run_key uuid := gen_random_uuid(); response jsonb; config jsonb;
  item_key text:=repeat('d',64); segment_key text:='authentic-'||repeat('e',64); clip jsonb; record jsonb; base_args jsonb;
begin
  insert into auth.users(id) values(owner_key);
  insert into public.app_members(user_id) values(owner_key);
  config := jsonb_build_object('id',source_key,'name','SQL fixture','enabled',true,'verifiedAt',0,
    'rights',jsonb_build_object('status','verified','recheckAfterDays',90));
  response := public.content_worker('claim',jsonb_build_object('sourceId',source_key,'runId',run_key,'source',config,'configHash',repeat('a',64)));
  if response->>'acquired' is distinct from 'true' or response->>'rightsDue' is distinct from 'true' then raise exception 'Initial rights check not required'; end if;
  response := public.content_worker('claim',jsonb_build_object('sourceId',source_key,'runId',gen_random_uuid(),'source',config,'configHash',repeat('a',64)));
  if response->>'acquired' is distinct from 'false' then raise exception 'Lease allowed concurrent worker'; end if;
  perform public.content_worker('rights-check',jsonb_build_object('sourceId',source_key,'runId',run_key,'check',jsonb_build_object(
    'status','verified','evidence',jsonb_build_array(jsonb_build_object('url','https://fixture.example.org/policy','expectedHash',repeat('b',64),'observedHash',repeat('b',64),'bodyHash',repeat('c',64))))));
  if not exists(select 1 from public.content_sources where id=source_key and rights_status='verified' and rights_checked_at>now()-interval '1 minute') then
    raise exception 'Actual rights evidence did not renew the policy';
  end if;
  perform public.content_worker('rights-check',jsonb_build_object('sourceId',source_key,'runId',run_key,'check',jsonb_build_object('status','changed','evidence','[]'::jsonb)));
  if not exists(select 1 from public.content_sources where id=source_key and rights_status='changed') then raise exception 'Changed policy stayed available'; end if;
  if (select count(*) from public.content_rights_checks where source_id=source_key) is distinct from 2 then raise exception 'Rights audit history missing'; end if;
  perform public.content_worker('profile',jsonb_build_object('ownerId',owner_key,'profile',jsonb_build_object('targetDifficulty',0.4,'fatigue',0,'interests','[]'::jsonb)));
  if (public.content_worker('profile',jsonb_build_object('ownerId',owner_key))->>'targetDifficulty')::numeric is distinct from 0.4 then raise exception 'Profile did not persist'; end if;
  base_args:=jsonb_build_object('sourceId',source_key,'runId',run_key,'itemId',item_key,'revision',repeat('d',64),'segmentId',segment_key);
  perform public.content_worker('rights-check',base_args||jsonb_build_object('check',jsonb_build_object('status','verified','evidence',jsonb_build_array(
    jsonb_build_object('expectedHash',repeat('b',64),'observedHash',repeat('b',64),'bodyHash',repeat('c',64))))));
  perform public.content_worker('ingest',base_args||jsonb_build_object('items',jsonb_build_array(jsonb_build_object('id',item_key,'revision',repeat('d',64),
    'episode',jsonb_build_object('guid','SYNTHETIC SQL TEST ONLY','sourceId',source_key)))));
  perform public.content_worker('asset',base_args||jsonb_build_object('sha256',repeat('a',64),'objectPath','episodes/'||item_key||'/'||repeat('a',64),'bytes',1048576,'mimeType','audio/wav'));
  if not exists(select 1 from public.content_audio_assets where item_id=item_key and state='preparing') then raise exception 'Upload reservation missing'; end if;
  perform public.content_worker('asset-ready',base_args||jsonb_build_object('sha256',repeat('a',64)));
  record:=jsonb_build_object('segment',jsonb_build_object('id',segment_key,'sourceId',source_key,'contentFingerprint',repeat('e',64),'sentences','[]'::jsonb),
    'status','quarantined','quality',jsonb_build_object('status','quarantined'));
  perform public.content_worker('save-segment',base_args||jsonb_build_object('record',record));
  clip:=jsonb_build_object('objectPath','clips/'||repeat('e',64)||'/'||repeat('f',64),'audioSha256',repeat('f',64),'sourceAudioSha256',repeat('a',64),
    'byteLength',960044,'mimeType','audio/wav','clipOriginSeconds',120,'sourceStartSeconds',120,'sourceEndSeconds',180,
    'startSeconds',0,'endSeconds',60,'durationSeconds',60,'timingBasis','pcm-sample-count');
  perform public.content_worker('clip',base_args||jsonb_build_object('clip',clip));
  record:=record||jsonb_build_object('status','eligible','inspection','SYNTHETIC SQL TEST ONLY','artifact',jsonb_build_object('sha256',repeat('a',64)),
    'lesson',jsonb_build_object('test',true),'material',jsonb_build_object('approved',true),'clip',clip,
    'audioEvidence',jsonb_build_object('submittedAudioSha256',repeat('f',64)));
  begin
    perform public.content_worker('save-segment',base_args||jsonb_build_object('record',record));
    raise exception 'Unuploaded clip became eligible';
  exception when invalid_parameter_value then null; end;
  perform public.content_worker('clip-ready',base_args||jsonb_build_object('sha256',repeat('f',64)));
  perform public.content_worker('save-segment',base_args||jsonb_build_object('record',record));
  perform public.content_worker('recommend',jsonb_build_object('ownerId',owner_key,'requestId','synthetic-clip-test','lessons',jsonb_build_array(
    jsonb_build_object('segmentId',segment_key,'playback',clip,'fit',0.7))));
  -- Full episode deletion cannot break an already persisted clip's playback contract.
  update public.content_items set status='eligible' where id=item_key;
  response:=public.content_worker('retention',base_args);
  if jsonb_array_length(response) is distinct from 1 then raise exception 'Finished episode not scheduled for deletion'; end if;
  perform public.content_worker('retention-finish',base_args||jsonb_build_object('paths',response));
  if (public.content_worker('playback',jsonb_build_object('ownerId',owner_key,'segmentId',segment_key))->'clip'->>'audioSha256') is distinct from repeat('f',64) then
    raise exception 'Clip depended on deleted episode'; end if;
  update public.content_segment_audio set expires_at=now()-interval '1 second' where segment_id=segment_key;
  perform public.content_worker('retention',base_args);
  if exists(select 1 from public.content_recommendations where segment_id=segment_key and active) then raise exception 'Expired clip kept active recommendation'; end if;
  update public.content_sources set lease_until=clock_timestamp()-interval '1 second' where id=source_key;
  begin
    perform public.content_worker('heartbeat',jsonb_build_object('sourceId',source_key,'runId',run_key));
    raise exception 'Expired lease wrote data' using errcode='22023';
  exception when serialization_failure then null; end;
end $$;

set local role authenticated;
do $$ begin
  begin perform public.content_worker('status','{}'); raise exception 'Browser invoked service RPC';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.content_transcripts; raise exception 'Browser read uninspected transcript';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.content_segment_audio; raise exception 'Browser read private clip registry';
  exception when insufficient_privilege then null; end;
  begin perform public.install_content_schedule('https://abcdefghijklmnopqrst.supabase.co/functions/v1/content','jove-content-job-test'); raise exception 'Browser installed schedule';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform 1 from public.content_recommendations; raise exception 'Anonymous read recommendations';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
