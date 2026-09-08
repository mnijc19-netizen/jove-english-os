-- No seed voice is certified by this migration. Only an actual service-side
-- rights/transcript/acoustic review may create a reference; never browser input.
create table public.pronunciation_references (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  material_id text check (material_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  reference_text text not null check (octet_length(reference_text) between 1 and 2048
    and reference_text = btrim(reference_text) and reference_text !~ '[[:cntrl:]<>]'),
  audio_url text not null check (length(audio_url) <= 2048 and audio_url ~ '^https://[^/@[:space:]]+(/|$)'),
  audio_sha256 text not null check (audio_sha256 ~ '^[a-f0-9]{64}$'),
  source_url text not null check (length(source_url) <= 2048 and source_url ~ '^https://[^/@[:space:]]+(/|$)'),
  rights_evidence text not null check (length(btrim(rights_evidence)) between 1 and 2000),
  voice_review jsonb not null check (jsonb_typeof(voice_review) = 'object' and octet_length(voice_review::text) <= 2000
    and voice_review @> '{"locale":"en-US","rightsApproved":true,"transcriptChecked":true,"clearSingleSpeaker":true,"naturalStressAndRhythm":true,"generalAmericanReviewed":true,"clippingOrIntrusiveNoise":false}'::jsonb
    and voice_review->>'kind' in ('human','synthetic') and voice_review->>'reviewId' ~ '^[A-Za-z0-9_-]{1,100}$'
    and voice_review ?& array['kind','reviewId']),
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null,
  revoked_at timestamptz,
  primary key(user_id,id),
  check (revoked_at is null or revoked_at >= reviewed_at)
);
alter table public.pronunciation_references enable row level security;
create policy own_reviewed_references on public.pronunciation_references for select to authenticated
  using (user_id = (select auth.uid()) and revoked_at is null
    and exists(select 1 from public.app_members m where m.user_id = (select auth.uid())));
revoke all on public.pronunciation_references from public,anon,authenticated;
grant select on public.pronunciation_references to authenticated;
grant all on public.pronunciation_references to service_role;

-- Updating a URL, transcript or quality policy requires a new reference identity.
-- Revocation is one-way; cached evidence can still be recovered privately.
create function public.protect_pronunciation_reference() returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'revoked_at') is distinct from (to_jsonb(old) - 'revoked_at')
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'Reference identity is immutable; create a newly reviewed version' using errcode='22023';
  end if;
  return new;
end $$;
create trigger immutable_pronunciation_reference before update on public.pronunciation_references
  for each row execute function public.protect_pronunciation_reference();
revoke all on function public.protect_pronunciation_reference() from public,anon,authenticated;

alter table public.acoustic_assessments add column request_fingerprint text check (request_fingerprint ~ '^[a-f0-9]{64}$');
alter table public.acoustic_assessments add column usage_id uuid references public.service_usage(id);
create unique index acoustic_assessment_usage on public.acoustic_assessments(usage_id) where usage_id is not null;

-- Commit the successful provider envelope and its retry cache atomically. The
-- gateway subsequently settles usage; failure there cannot cause paid replay.
create function public.complete_speech_assessment(owner_id uuid, usage_id uuid, claim_nonce uuid,
  request_fingerprint text, assessment_id uuid, recording_id text, reference_id text, result jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare call public.service_usage; existing public.acoustic_assessments;
begin
  select * into call from public.service_usage u where u.id = usage_id and u.user_id = owner_id for update;
  if not found or call.service <> 'pronunciation' or call.dispatch_nonce <> claim_nonce
    or call.fingerprint <> request_fingerprint or not exists(select 1 from public.app_members m where m.user_id = owner_id) then
    raise exception 'Assessment reservation does not match' using errcode='42501';
  end if;
  select * into existing from public.acoustic_assessments a where a.user_id=owner_id and a.attempt_id=call.request_id;
  if found then
    if existing.request_fingerprint <> request_fingerprint or existing.recording_id <> recording_id or existing.reference_id <> reference_id then
      raise exception 'Assessment identity collision' using errcode='23505';
    end if;
    return existing.id;
  end if;
  if call.status <> 'reserved' or recording_id !~ '^[A-Za-z0-9_-]{1,100}$' or reference_id !~ '^[A-Za-z0-9_-]{1,100}$'
    or not exists(select 1 from public.pronunciation_references r where r.user_id=owner_id and r.id=reference_id and r.revoked_at is null)
    or jsonb_typeof(result) is distinct from 'object' or result->'ok' is distinct from 'true'::jsonb
    or result->>'assessmentId' is distinct from assessment_id::text
    or result#>>'{assessment,attemptId}' is distinct from call.request_id
    or result#>>'{assessment,recordingId}' is distinct from recording_id
    or result#>>'{assessment,referenceId}' is distinct from reference_id
    or result#>>'{assessment,provider}' is distinct from 'azure-speech'
    or result#>>'{assessment,method}' is distinct from 'scripted-pronunciation-assessment'
    or result#>>'{assessment,locale}' is distinct from 'en-US'
    or jsonb_typeof(result#>'{assessment,raw}') is distinct from 'object' then
    raise exception 'Invalid provider assessment envelope' using errcode='22023';
  end if;
  insert into public.acoustic_assessments(id,user_id,attempt_id,recording_id,reference_id,result,request_fingerprint,usage_id)
    values(assessment_id,owner_id,call.request_id,recording_id,reference_id,result,request_fingerprint,usage_id);
  insert into public.service_results(user_id,request_id,result) values(owner_id,call.request_id,result);
  return assessment_id;
end $$;
revoke all on function public.complete_speech_assessment(uuid,uuid,uuid,text,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_speech_assessment(uuid,uuid,uuid,text,uuid,text,text,jsonb) to service_role;
