-- Run inside caller-owned BEGIN/ROLLBACK against dedicated Jove only. No persistent fixture approval.
do $$
declare source_key text := 'test-content-sql-'||replace(gen_random_uuid()::text,'-','');
  owner_key uuid := gen_random_uuid(); run_key uuid := gen_random_uuid(); response jsonb; pending_response jsonb; config jsonb;
  reconciliation_item jsonb; reconciliation_history bigint;
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
  -- Waiting for an allowance/provider is resumable even after a year of polling.
  update public.content_items set attempts=1000 where id=item_key;
  perform public.content_worker('finish-item',base_args||jsonb_build_object('status','awaiting-analysis','processVersion','long-running-fixture'));
  if not exists(select 1 from public.content_items where id=item_key and attempts=1001 and status='awaiting-analysis') then
    raise exception 'Long-lived content could not checkpoint';
  end if;
  pending_response:=public.content_worker('pending',base_args||jsonb_build_object('canAnalyze',true,'processVersion','long-running-fixture'));
  if jsonb_array_length(pending_response) is distinct from 1 or pending_response->0->>'id' is distinct from item_key then
    raise exception 'Long-lived awaiting content could not resume';
  end if;
  perform public.content_worker('finish-item',base_args||jsonb_build_object('status','eligible','processVersion','long-running-fixture'));
  if not exists(select 1 from public.content_items where id=item_key and attempts=1002 and status='eligible') then
    raise exception 'Long-lived content could not finish after recovery';
  end if;
  -- A legacy reconciliation checkpoint must expose enough metadata for the worker
  -- to normalize it without media work, and same-version quarantine must leave the queue.
  perform public.content_worker('finish-item',base_args||jsonb_build_object('status','awaiting-analysis','processVersion','long-running-fixture',
    'reasons',jsonb_build_array('content-provider-reconciliation-required')));
  select to_jsonb(i) into reconciliation_item from public.content_items i where id=item_key;
  select count(*) into reconciliation_history from public.content_history where item_id=item_key;
  pending_response:=public.content_worker('pending',base_args||jsonb_build_object('canAnalyze',true,'processVersion','long-running-fixture'));
  if pending_response->0->>'status' is distinct from 'awaiting-analysis' or
    pending_response->0->>'process_version' is distinct from 'long-running-fixture' or
    pending_response->0->'reasons' is distinct from '["content-provider-reconciliation-required"]'::jsonb then
    raise exception 'Reconciliation queue metadata missing';
  end if;
  begin
    perform public.content_worker('finish-item',base_args||jsonb_build_object('status','quarantined','revision',repeat('0',64)));
    raise exception 'Stale revision normalized reconciliation';
  exception when serialization_failure then null; end;
  begin
    perform public.content_worker('finish-item',base_args||jsonb_build_object('status','quarantined','runId',gen_random_uuid()));
    raise exception 'Stale lease normalized reconciliation';
  exception when serialization_failure then null; end;
  perform public.content_worker('finish-item',base_args||jsonb_build_object('status','quarantined','processVersion','long-running-fixture',
    'reasons',reconciliation_item->'reasons'));
  if (select to_jsonb(i)-array['status','attempts','next_attempt_at','updated_at'] from public.content_items i where id=item_key)
    is distinct from reconciliation_item-array['status','attempts','next_attempt_at','updated_at'] or
    (select count(*) from public.content_history where item_id=item_key) is distinct from reconciliation_history+1 then
    raise exception 'Reconciliation normalization changed protected metadata or lost its history';
  end if;
  if jsonb_array_length(public.content_worker('pending',base_args||jsonb_build_object('canAnalyze',true,'processVersion','long-running-fixture'))) is distinct from 0 then
    raise exception 'Quarantined reconciliation still monopolizes pending';
  end if;
  if jsonb_array_length(public.content_worker('pending',base_args||jsonb_build_object('canAnalyze',true,'processVersion','changed-fixture'))) is distinct from 1 then
    raise exception 'Changed processing version could not run reconciliation gates';
  end if;
  begin
    update public.content_items set attempts=-1 where id=item_key;
    raise exception 'Negative content attempts accepted';
  exception when check_violation then null; end;
  -- The lifetime counter must not remove the ordinary six-attempt retry limit.
  update public.content_items set status='retry',attempts=6,next_attempt_at=now()-interval '1 second' where id=item_key;
  if jsonb_array_length(public.content_worker('pending',base_args||jsonb_build_object('canAnalyze',true))) is distinct from 0 then
    raise exception 'Exhausted ordinary retry became pending';
  end if;
  update public.content_items set status='pending',attempts=0,next_attempt_at=now() where id=item_key;
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
  -- Forward container-version compatibility only; no decoder/acoustic approval.
  begin
    update public.content_segment_audio set timing_basis='mpeg-frame-count-with-xing-v1' where segment_id=segment_key;
    raise exception 'Xing timing accepted non-MPEG media';
  exception when check_violation then null; end;
  update public.content_segment_audio set timing_basis='mpeg-frame-count-with-xing-v1',mime_type='audio/mpeg' where segment_id=segment_key;
  if not exists(select 1 from public.content_segment_audio where segment_id=segment_key and timing_basis='mpeg-frame-count-with-xing-v1'
    and sha256=repeat('f',64) and source_sha256=repeat('a',64) and state='preparing') then
    raise exception 'Versioned container changed identity or availability'; end if;
  begin
    update public.content_segment_audio set timing_basis='unverified-guessed-duration' where segment_id=segment_key;
    raise exception 'Unknown timing basis accepted';
  exception when check_violation then null; end;
  update public.content_segment_audio set timing_basis='pcm-sample-count',mime_type='audio/wav' where segment_id=segment_key;
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

-- Explicit acquisition coexistence, JSONB recovery and logical spending fence.
-- Synthetic metadata only; no provider, Storage upload or human approval.
do $$
declare sk text:='test-prefix-sql-'||replace(gen_random_uuid()::text,'-',''); rk uuid:=gen_random_uuid(); uk uuid:=gen_random_uuid();
  ik text:=repeat('7',64); rev text:=repeat('8',64); sha text:=repeat('9',64); c jsonb; base jsonb; asset jsonb;
  r jsonb; tr jsonb; intent jsonb; patch jsonb;
begin
  insert into auth.users(id) values(uk); insert into public.app_members(user_id) values(uk);
  perform public.content_worker('claim',jsonb_build_object('sourceId',sk,'runId',rk,'configHash',repeat('a',64),
    'source',jsonb_build_object('id',sk,'enabled',true,'name','Synthetic prefix fixture')));
  base:=jsonb_build_object('sourceId',sk,'runId',rk,'itemId',ik,'revision',rev);
  perform public.content_worker('ingest',base||jsonb_build_object('items',jsonb_build_array(jsonb_build_object('id',ik,'revision',rev,
    'episode',jsonb_build_object('guid','SYNTHETIC PREFIX TEST ONLY','sourceId',sk)))));
  r:=public.content_audio_work('order',jsonb_build_object('sourceIds',jsonb_build_array(sk,'unseen-work-fixture')));
  if r is distinct from jsonb_build_array(sk,'unseen-work-fixture') then raise exception 'First work order discarded input priority'; end if;
  perform public.content_audio_work('begin',base);
  r:=public.content_audio_work('order',jsonb_build_object('sourceIds',jsonb_build_array(sk,'unseen-work-fixture')));
  if r is distinct from jsonb_build_array('unseen-work-fixture',sk) then raise exception 'Audio work did not advance source rotation'; end if;
  if (select last_audio_work_at from public.content_sources where id=sk) is null then raise exception 'Audio work was not checkpointed'; end if;
  begin
    perform public.content_audio_work('begin',base||jsonb_build_object('runId',gen_random_uuid()));
    raise exception 'Expired worker changed source rotation';
  exception when serialization_failure then null; end;
  begin
    perform public.content_audio_work('order',jsonb_build_object('sourceIds',jsonb_build_array(sk,sk)));
    raise exception 'Duplicate sources bypassed work order validation';
  exception when invalid_parameter_value then null; end;
  c:=jsonb_build_object('version','mpeg-prefix-v1','networkKind','prefix','receivedBytes',417000,'sourceBytes',10000000,
    'sourceByteStart',0,'sourceByteEndExclusive',417000,'startSeconds',0,'endSeconds',1000.0*1152/44100,
    'frameCount',1000,'sampleRate',44100,'samplesPerFrame',1152,'removedMetadataFrame',null,'discardedTrailingBytes',0,
    'stopReason','range-boundary','gaplessAdjustment','not-applied');
  if public.content_mp3_coverage_v1_valid(c,417000) is distinct from true then raise exception 'Valid prefix coverage rejected'; end if;
  for patch in select value from jsonb_array_elements('[{"version":"unknown"},{"sourceByteStart":1},{"networkKind":"complete"},
      {"frameCount":1000.5},{"endSeconds":601},{"frameCount":null},{"extra":"field"},{"gaplessAdjustment":"invented"}]'::jsonb) loop
    if public.content_mp3_coverage_v1_valid(c||patch,417000) is distinct from false then raise exception 'Invalid prefix coverage accepted'; end if;
  end loop;
  if public.content_mp3_coverage_v1_valid(null,417000) is distinct from false then raise exception 'Missing coverage accepted'; end if;
  asset:=jsonb_build_object('sha256',sha,'bytes',417000,'mimeType','audio/mpeg');
  perform public.content_worker('asset',base||asset||jsonb_build_object('objectPath','episodes/'||ik||'/'||sha));
  perform public.content_worker('asset',base||asset||jsonb_build_object('objectPath','prefixes/'||ik||'/'||sha,
    'acquisitionVersion','mpeg-prefix-v1','coverage',c));
  if (select count(*) from public.content_audio_assets where item_id=ik) is distinct from 2 then raise exception 'Prefix replaced complete asset'; end if;
  perform public.content_worker('asset-ready',base||jsonb_build_object('sha256',sha,'acquisitionVersion','mpeg-prefix-v1'));
  if not exists(select 1 from public.content_audio_assets where item_id=ik and acquisition_version='complete-v1' and state='preparing' and coverage is null) then
    raise exception 'Prefix readiness changed old asset'; end if;
  r:=public.content_worker('pending',base||jsonb_build_object('acquisitionVersion','mpeg-prefix-v1'));
  if jsonb_array_length(r) is distinct from 1 or r->0->>'audio_acquisition_version' is distinct from 'mpeg-prefix-v1'
    or r->0->'audio_coverage' is distinct from c then raise exception 'Prefix JSONB recovery mismatch'; end if;
  r:=public.content_worker('pending',base);
  if r->0->>'object_path' is not null then raise exception 'Legacy caller acquired a prefix'; end if;
  perform public.content_worker('asset-ready',base||jsonb_build_object('sha256',sha));
  r:=public.content_worker('pending',base||jsonb_build_object('acquisitionVersion','mpeg-prefix-v1'));
  if jsonb_array_length(r) is distinct from 1 or r->0->>'audio_acquisition_version' is distinct from 'complete-v1' then
    raise exception 'Existing complete acquisition was not reused'; end if;
  begin
    perform public.content_worker('asset',base||asset||jsonb_build_object('objectPath','prefixes/'||ik||'/'||sha,
      'acquisitionVersion','mpeg-prefix-v1','coverage',c||jsonb_build_object('sourceBytes',10000001)));
    raise exception 'Same digest rebound to different coverage';
  exception when unique_violation then null; end;
  tr:=jsonb_build_object('reference',jsonb_build_object('origin','authorized-stt','derivation',jsonb_build_object('audioSha256',sha,'audioCoverage',c)),
    'cues','[]'::jsonb);
  perform public.content_worker('checkpoint',base||jsonb_build_object('transcript',tr,'fingerprint',repeat('a',64)));
  r:=public.content_worker('pending',base||jsonb_build_object('acquisitionVersion','mpeg-prefix-v1'));
  if r->0->>'audio_acquisition_version' is distinct from 'mpeg-prefix-v1' then
    raise exception 'Same-digest acquisitions ignored STT coverage'; end if;
  begin
    perform public.content_worker('checkpoint',base||jsonb_build_object('transcript',jsonb_set(tr,'{reference,derivation,audioCoverage,sourceBytes}','10000001'::jsonb),'fingerprint',repeat('b',64)));
    raise exception 'Existing STT rebound to different coverage';
  exception when unique_violation then null; end;
  begin
    perform public.content_worker('checkpoint',base||jsonb_build_object('transcript',jsonb_set(tr,'{reference,derivation,audioSha256}',to_jsonb(repeat('b',64))),'fingerprint',repeat('b',64)));
    raise exception 'Existing STT rebound to a new audio digest';
  exception when unique_violation then null; end;
  intent:=base||jsonb_build_object('purpose','content-stt','scope','','requestId','content-stt-'||repeat('c',64),
    'fingerprint',repeat('c',64),'audioSha256',sha);
  if public.content_request_intent(intent)->>'allowed' is distinct from 'true' then raise exception 'First logical intent rejected'; end if;
  if public.content_request_intent(intent)->>'allowed' is distinct from 'true' then raise exception 'Same logical intent was not idempotent'; end if;
  if public.content_request_intent(intent||jsonb_build_object('requestId','content-stt-'||repeat('d',64),'fingerprint',repeat('d',64)))->>'allowed'
    is distinct from 'false' then raise exception 'Changed fingerprint bypassed logical intent'; end if;
  if (select count(*) from public.content_request_intents where item_id=ik) is distinct from 1 then raise exception 'Intent duplicated'; end if;
  begin
    perform public.content_request_intent(intent||jsonb_build_object('runId',gen_random_uuid()));
    raise exception 'Stale lease wrote request intent';
  exception when serialization_failure then null; end;
  insert into public.content_usage(request_id,user_id,item_id,purpose,status,cost_usd,usage)
    values('content-stt-'||repeat('e',64),uk,ik,'content-stt','uncertain',null,'{"synthetic":true}'::jsonb);
  if public.content_request_intent(intent)->>'allowed' is distinct from 'false' then raise exception 'Unmapped historical charge was ignored'; end if;
  if not exists(select 1 from public.content_usage where item_id=ik and status='uncertain' and cost_usd is null) then
    raise exception 'Historical uncertainty was changed'; end if;
  update public.content_audio_assets set expires_at=clock_timestamp()-interval '1 second'
    where item_id=ik and acquisition_version='mpeg-prefix-v1';
  r:=public.content_worker('retention',base);
  if r is distinct from jsonb_build_array('prefixes/'||ik||'/'||sha) then raise exception 'Prefix retention selected wrong acquisition'; end if;
  if public.content_worker('retention',base) is distinct from r then raise exception 'Failed prefix deletion was not recoverable'; end if;
  perform public.content_worker('retention-finish',base||jsonb_build_object('paths',r));
  if (select count(*) from public.content_audio_assets where item_id=ik) is distinct from 1
    or not exists(select 1 from public.content_audio_assets where item_id=ik and acquisition_version='complete-v1' and state='ready') then
    raise exception 'Prefix retention removed the complete acquisition'; end if;
  if not exists(select 1 from public.content_request_intents where item_id=ik)
    or not exists(select 1 from public.content_usage where item_id=ik and status='uncertain' and cost_usd is null) then
    raise exception 'Audio cleanup erased replay protection or billing uncertainty'; end if;
end $$;

-- A pre-intent worker can lose its lease/process before writing content_usage.
-- The service ledger survives; changing acquisition must not authorize a retry.
do $$ declare uk uuid:=gen_random_uuid(); other_owner uuid:=gen_random_uuid(); run_key uuid:=gen_random_uuid();
  sk text:='orphan-ledger-'||replace(gen_random_uuid()::text,'-','');
  ik text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  old_item text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  old_fp text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  new_fp text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  args jsonb; old_args jsonb; result jsonb; original_ledger jsonb; state text;
begin
  insert into auth.users(id) values(uk),(other_owner);
  insert into public.app_members(user_id) values(uk),(other_owner);
  insert into public.service_preferences(user_id,daily_budget_usd,monthly_budget_usd) values(uk,2,2);
  perform public.content_worker('claim',jsonb_build_object('sourceId',sk,'runId',run_key,'configHash',repeat('a',64),
    'source',jsonb_build_object('id',sk,'enabled',true,'name','SYNTHETIC ORPHAN TEST')));
  perform public.content_worker('ingest',jsonb_build_object('sourceId',sk,'runId',run_key,'items',jsonb_build_array(
    jsonb_build_object('id',ik,'revision',repeat('b',64),'episode',jsonb_build_object('sourceId',sk,'guid','SYNTHETIC NEW ITEM')),
    jsonb_build_object('id',old_item,'revision',repeat('b',64),'episode',jsonb_build_object('sourceId',sk,'guid','SYNTHETIC OLD ITEM')))));
  args:=jsonb_build_object('sourceId',sk,'runId',run_key,'itemId',ik,'revision',repeat('b',64),'purpose','content-stt','scope','',
    'requestId','content-stt-'||new_fp,'fingerprint',new_fp,'audioSha256',repeat('e',64));
  old_args:=args||jsonb_build_object('itemId',old_item,'requestId','content-stt-'||old_fp,'fingerprint',old_fp);
  insert into public.service_usage(user_id,request_id,fingerprint,dispatch_nonce,service,status,reserved_usd)
    values(uk,'content-stt-'||old_fp,old_fp,gen_random_uuid(),'content','uncertain',0.5);
  select to_jsonb(u) into original_ledger from public.service_usage u where user_id=uk;
  result:=public.content_request_intent(args);
  if result->>'allowed' is distinct from 'false' then raise exception 'Orphan service reservation authorized a new content intent'; end if;
  if public.content_legacy_service_unmapped() is distinct from true then raise exception 'Orphan preflight was not closed'; end if;
  if exists(select 1 from public.content_request_intents where item_id=ik)
    or (select to_jsonb(u) from public.service_usage u where user_id=uk) is distinct from original_ledger then
    raise exception 'Orphan denial changed intent or original unknown hold'; end if;
  -- No content/checkpoint row exists; denial must precede budget reservation.
  if result->>'allowed'='true' then
    perform public.reserve_service_call(uk,'content-stt-'||new_fp,new_fp,'content',0.5,gen_random_uuid());
  end if;
  if (select count(*) from public.service_usage where user_id=uk)<>1 then raise exception 'Orphan retry created a second hold'; end if;
  foreach state in array array['reserved','completed','failed'] loop
    update public.service_usage set status=state where user_id=uk;
    if public.content_request_intent(args)->>'allowed' is distinct from 'false' then raise exception 'Ledger status hid orphan mapping'; end if;
  end loop;
  update public.service_usage set status='uncertain' where user_id=uk;
  insert into public.content_usage(request_id,user_id,item_id,purpose,status,usage)
    values('content-stt-'||old_fp,uk,null,'content-stt','uncertain','{"synthetic":true}');
  if public.content_request_intent(args)->>'allowed' is distinct from 'false' then raise exception 'Null-item checkpoint cleared orphan'; end if;
  update public.content_usage set item_id=old_item,user_id=other_owner where request_id='content-stt-'||old_fp;
  if public.content_request_intent(args)->>'allowed' is distinct from 'false' then raise exception 'Other owner checkpoint cleared orphan'; end if;
  update public.content_usage set user_id=uk where request_id='content-stt-'||old_fp;
  if public.content_legacy_service_unmapped() is distinct from false then raise exception 'Trustworthy old item mapping not recognized'; end if;
  if public.content_request_intent(args)->>'allowed' is distinct from 'true' then raise exception 'Mapped different old item blocked fresh work'; end if;
  if public.content_request_intent(old_args)->>'allowed' is distinct from 'false' then raise exception 'Old mapped item became replayable'; end if;
  -- A modern intent is committed BEFORE reservation. Losing the later usage
  -- checkpoint does not orphan that trustworthy binding or erase the hold.
  delete from public.content_usage where request_id='content-stt-'||old_fp;
  insert into public.content_request_intents(item_id,revision,purpose,scope,request_id,fingerprint,audio_sha256)
    values(old_item,repeat('b',64),'content-stt','','content-stt-'||old_fp,old_fp,repeat('e',64));
  if public.content_request_intent(args)->>'allowed' is distinct from 'true' then raise exception 'Interrupted modern checkpoint blocked unrelated work'; end if;
  if public.content_request_intent(old_args)->>'allowed' is distinct from 'true' then raise exception 'Stable modern binding stopped being idempotent'; end if;
  if public.content_request_intent(old_args||jsonb_build_object('requestId','content-stt-'||repeat('f',64),'fingerprint',repeat('f',64)))->>'allowed'
    is distinct from 'false' then raise exception 'Interrupted modern checkpoint rebound its fingerprint'; end if;
  update public.service_usage set fingerprint=repeat('f',64) where user_id=uk;
  if public.content_request_intent(args)->>'allowed' is distinct from 'false' then raise exception 'Mismatched intent fingerprint cleared orphan'; end if;
  update public.service_usage set fingerprint=old_fp where user_id=uk;
  if (select to_jsonb(u) from public.service_usage u where user_id=uk) is distinct from original_ledger then
    raise exception 'Replay checks changed original ledger'; end if;
  update public.content_sources set lease_until=null where id=sk;
  begin perform public.content_request_intent(args); raise exception 'Null lease expiry admitted intent';
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
  begin perform 1 from public.content_request_intents; raise exception 'Browser read private request bindings';
  exception when insufficient_privilege then null; end;
  begin perform public.content_request_intent('{}'); raise exception 'Browser created provider request intent';
  exception when insufficient_privilege then null; end;
  begin perform public.content_legacy_service_unmapped(); raise exception 'Browser inspected private legacy ledger state';
  exception when insufficient_privilege then null; end;
  begin perform public.content_audio_work('order','{"sourceIds":[]}'); raise exception 'Browser reordered provider work';
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
