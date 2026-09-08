-- Run after 005 in an isolated local transaction; caller rolls back all fixtures.
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000501','speech-owner@example.invalid'),
 ('00000000-0000-4000-8000-000000000502','speech-other@example.invalid');
insert into public.app_members(user_id) values ('00000000-0000-4000-8000-000000000501');
insert into public.pronunciation_references(user_id,id,reference_text,audio_url,audio_sha256,source_url,rights_evidence,voice_review,reviewed_by,reviewed_at)
values ('00000000-0000-4000-8000-000000000501','test-only-reviewed-fixture','Good morning.',
 'https://example.invalid/test.wav',repeat('a',64),'https://example.invalid/test-source','INERT TEST ONLY, not an approved production voice',
 '{"locale":"en-US","kind":"human","rightsApproved":true,"transcriptChecked":true,"clearSingleSpeaker":true,"naturalStressAndRhythm":true,"generalAmericanReviewed":true,"clippingOrIntrusiveNoise":false,"reviewId":"test-only-review"}',
 '00000000-0000-4000-8000-000000000501',now());
do $$
declare c public.service_usage; answer jsonb; count_before integer;
  owner uuid := '00000000-0000-4000-8000-000000000501'; nonce uuid := '00000000-0000-4000-8000-000000000511';
  assessment uuid := '00000000-0000-4000-8000-000000000521';
begin
  begin
    update public.pronunciation_references set reference_text='Unreviewed change' where user_id=owner;
    raise exception 'Reference version was mutable';
  exception when invalid_parameter_value then null; end;
  begin
    insert into public.pronunciation_references select user_id,'unknown-quality',material_id,reference_text,audio_url,audio_sha256,
      source_url,rights_evidence,voice_review-'generalAmericanReviewed',reviewed_by,reviewed_at,revoked_at from public.pronunciation_references where user_id=owner;
    raise exception 'Missing voice quality was accepted';
  exception when check_violation then null; end;
  c := public.reserve_service_call(owner,'test-attempt',repeat('b',64),'pronunciation',0.02,nonce);
  answer := jsonb_build_object('ok',true,'assessmentId',assessment,'assessedAt',1788820000000,'usage','[]'::jsonb,
    'assessment',jsonb_build_object('attemptId','test-attempt','recordingId','test-recording','referenceId','test-only-reviewed-fixture',
      'provider','azure-speech','method','scripted-pronunciation-assessment','locale','en-US','raw','{}'::jsonb));
  begin
    perform public.complete_speech_assessment(owner,c.id,'00000000-0000-4000-8000-000000000512',repeat('b',64),assessment,'test-recording','test-only-reviewed-fixture',answer);
    raise exception 'Non-dispatcher could persist provider result';
  exception when insufficient_privilege then null; end;
  begin
    perform public.complete_speech_assessment(owner,c.id,nonce,repeat('b',64),assessment,'other-recording','test-only-reviewed-fixture',answer);
    raise exception 'Mismatched recording accepted';
  exception when invalid_parameter_value then null; end;
  perform public.complete_speech_assessment(owner,c.id,nonce,repeat('b',64),assessment,'test-recording','test-only-reviewed-fixture',answer);
  perform public.complete_speech_assessment(owner,c.id,nonce,repeat('b',64),assessment,'test-recording','test-only-reviewed-fixture',answer);
  if (select count(*) from public.acoustic_assessments where user_id=owner) <> 1 or
    (select count(*) from public.service_results where user_id=owner) <> 1 then raise exception 'Result/cache persistence is not idempotent'; end if;
  if (select actual_usd from public.service_usage where id=c.id) is not null then raise exception 'Unknown invoice fabricated'; end if;
  update public.pronunciation_references set revoked_at=now() where user_id=owner;
  begin
    update public.pronunciation_references set revoked_at=null where user_id=owner;
    raise exception 'Reference revocation was undone';
  exception when invalid_parameter_value then null; end;
  select count(*) into count_before from public.acoustic_assessments where user_id=owner;
  if count_before <> 1 then raise exception 'Revocation destroyed previous private evidence'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000501',true);
do $$ begin
  if (select count(*) from public.pronunciation_references) <> 0 then raise exception 'Revoked reference remains visible'; end if;
  if (select count(*) from public.acoustic_assessments) <> 1 then raise exception 'Owner cannot recover evidence'; end if;
  begin
    update public.pronunciation_references set revoked_at=null;
    raise exception 'Browser could certify a reference';
  exception when insufficient_privilege then null; end;
  begin
    perform public.complete_speech_assessment(null,null,null,null,null,null,null,null);
    raise exception 'Browser could mint acoustic assessment';
  exception when insufficient_privilege then null; end;
  begin
    update public.acoustic_assessments set result='{}';
    raise exception 'Browser could overwrite acoustic evidence';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000502',true);
do $$ begin
  if exists(select 1 from public.acoustic_assessments) or exists(select 1 from public.service_results) or exists(select 1 from public.pronunciation_references) then
    raise exception 'Other user read private speech data'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.pronunciation_references;
    raise exception 'Anonymous reference access allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS: immutable/revocable actual-review boundary, private owner evidence, no client minting, dispatch binding, atomic/idempotent result cache';
