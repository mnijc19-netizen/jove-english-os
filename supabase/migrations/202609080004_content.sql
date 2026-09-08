-- Dedicated Jove backend. Public source content is operationally private until inspected.
-- No owner identity, provider key, scheduler secret or fixture approval is seeded here.
create table public.content_sources (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  config jsonb not null check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 65536),
  config_hash text not null check (config_hash ~ '^[a-f0-9]{64}$'),
  etag text, last_modified text, feed_hash text,
  last_poll_at timestamptz, next_poll_at timestamptz not null default now(),
  failures integer not null default 0 check (failures between 0 and 1000),
  lease_id uuid, lease_until timestamptz,
  rights_status text not null default 'unchecked' check (rights_status in ('unchecked','verified','changed')),
  rights_checked_at timestamptz, next_rights_check_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.content_rights_checks (
  id bigint generated always as identity primary key,
  source_id text not null references public.content_sources(id) on delete cascade,
  status text not null check (status in ('verified','changed','unavailable')),
  evidence jsonb not null check (octet_length(evidence::text)<=16384),
  reason text, checked_at timestamptz not null default now()
);
create table public.content_items (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  source_id text not null references public.content_sources(id),
  guid text not null check (length(guid) between 1 and 8000),
  revision text not null check (revision ~ '^[a-f0-9]{64}$'),
  episode jsonb not null check (octet_length(episode::text) <= 131072),
  status text not null default 'pending' check (status in ('pending','awaiting-analysis','retry','quarantined','eligible')),
  reasons jsonb not null default '[]',
  attempts integer not null default 0 check (attempts between 0 and 1000),
  process_version text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(source_id,guid)
);
create index content_items_queue on public.content_items(source_id,status,next_attempt_at);
create table public.content_transcripts (
  item_id text primary key references public.content_items(id) on delete cascade,
  revision text not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  transcript jsonb not null check (octet_length(transcript::text) <= 4194304),
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 days'
);
create table public.content_audio_assets (
  item_id text not null references public.content_items(id) on delete cascade,
  revision text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  object_path text not null unique check (object_path ~ '^episodes/[a-f0-9]{64}/[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 1 and 67108864),
  mime_type text not null,
  duration_seconds double precision check (duration_seconds > 0 and duration_seconds <= 86400),
  state text not null default 'preparing' check (state in ('preparing','ready','deleting')),
  expires_at timestamptz not null default now()+interval '3 days',
  created_at timestamptz not null default now(),
  primary key(item_id,revision)
);
create table public.content_segments (
  id text primary key check (id ~ '^authentic-[a-f0-9]{64}$'),
  item_id text not null references public.content_items(id) on delete cascade,
  revision text not null,
  content_fingerprint text not null check (content_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('quarantined','eligible','stale')),
  record jsonb not null check (octet_length(record::text) <= 524288),
  updated_at timestamptz not null default now()
);
create index content_segments_fingerprint on public.content_segments(content_fingerprint);
create index content_segments_status on public.content_segments(status,updated_at);
create table public.content_segment_audio (
  segment_id text primary key references public.content_segments(id) on delete cascade,
  object_path text not null unique check (object_path ~ '^clips/[a-f0-9]{64}/[a-f0-9]{64}$'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 1 and 10485760),
  mime_type text not null check (mime_type in ('audio/mpeg','audio/wav','audio/ogg')),
  origin_seconds double precision not null check (origin_seconds between 0 and 86400),
  source_start double precision not null, source_end double precision not null,
  clip_start double precision not null, clip_end double precision not null,
  duration_seconds double precision not null check (duration_seconds > 0 and duration_seconds <= 123),
  timing_basis text not null check (timing_basis in ('complete-container','mpeg-frame-count-with-preroll','pcm-sample-count')),
  state text not null default 'preparing' check (state in ('preparing','ready','deleting')),
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '90 days',
  check (source_start>=origin_seconds and source_end<=86400 and source_end-source_start between 30 and 120),
  check (clip_start>=0 and clip_end>clip_start and clip_end<=duration_seconds+0.001),
  check (abs(source_start-origin_seconds-clip_start)<0.000001 and abs(source_end-origin_seconds-clip_end)<0.000001)
);
create table public.content_speakers (
  segment_id text not null references public.content_segments(id) on delete cascade,
  label text not null check (length(label) between 1 and 200),
  observation jsonb not null default '{"status":"unknown","reason":"Publisher caption label only; no verified speaker identity or accent."}',
  primary key(segment_id,label)
);
create table public.content_scores (
  segment_id text primary key references public.content_segments(id) on delete cascade,
  report jsonb not null check (octet_length(report::text) <= 262144),
  updated_at timestamptz not null default now()
);
create table public.content_usage (
  request_id text primary key check (length(request_id) between 1 and 100),
  user_id uuid not null references public.app_members(user_id) on delete cascade,
  item_id text references public.content_items(id),
  purpose text not null check (purpose in ('content-analysis','content-stt')),
  status text not null check (status in ('completed','uncertain')),
  cost_usd numeric(14,8) check (cost_usd >= 0),
  usage jsonb not null check (octet_length(usage::text) <= 8192),
  created_at timestamptz not null default now()
);
create table public.content_recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_members(user_id) on delete cascade,
  request_id text not null check (length(request_id) between 1 and 100),
  segment_id text not null references public.content_segments(id),
  lesson jsonb not null check (octet_length(lesson::text) <= 262144),
  fit numeric(5,4) not null check (fit between 0 and 1),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(user_id,request_id,segment_id)
);
create index content_recommendations_owner on public.content_recommendations(user_id,created_at);
create table public.content_history (
  id bigint generated always as identity primary key,
  source_id text references public.content_sources(id),
  item_id text references public.content_items(id),
  segment_id text references public.content_segments(id),
  user_id uuid references public.app_members(user_id) on delete cascade,
  event text not null check (length(event) between 1 and 80),
  event_key text unique,
  detail jsonb not null default '{}' check (octet_length(detail::text) <= 8192),
  created_at timestamptz not null default now()
);
create index content_history_owner on public.content_history(user_id,created_at);
create table public.content_profiles (
  user_id uuid primary key references public.app_members(user_id) on delete cascade,
  profile jsonb not null check (jsonb_typeof(profile)='object' and octet_length(profile::text)<=16384),
  updated_at timestamptz not null default now()
);

do $$ declare tab text; begin
  foreach tab in array array['content_sources','content_items','content_transcripts','content_audio_assets','content_segments',
    'content_speakers','content_scores','content_usage','content_recommendations','content_history','content_rights_checks','content_profiles','content_segment_audio'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from anon, authenticated',tab);
    execute format('grant all on public.%I to service_role',tab);
  end loop;
end $$;
grant select on public.content_recommendations,public.content_usage,public.content_history to authenticated;
grant usage, select on sequence public.content_history_id_seq to service_role;
grant usage, select on sequence public.content_rights_checks_id_seq to service_role;
create function public.content_lesson_available(segment_key text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.content_recommendations r
    join public.content_segments s on s.id=r.segment_id
    join public.content_items i on i.id=s.item_id
    join public.content_sources c on c.id=i.source_id
    join public.content_segment_audio a on a.segment_id=s.id and a.state='ready' and a.expires_at>now()
    where r.user_id=(select auth.uid()) and r.segment_id=segment_key and r.active
      and s.status='eligible' and s.revision=i.revision
      and c.config->>'enabled'='true' and c.config->'rights'->>'status'='verified'
      and c.rights_status='verified' and c.rights_checked_at+
        make_interval(days=>(c.config->'rights'->>'recheckAfterDays')::integer)>now());
$$;
revoke all on function public.content_lesson_available(text) from public,anon;
grant execute on function public.content_lesson_available(text) to authenticated,service_role;
create policy own_content_recommendations on public.content_recommendations for select to authenticated
  using (user_id=(select auth.uid()) and active and public.content_lesson_available(segment_id)
    and exists(select 1 from public.app_members m where m.user_id=(select auth.uid())));
create policy own_content_usage on public.content_usage for select to authenticated
  using (user_id=(select auth.uid()) and exists(select 1 from public.app_members m where m.user_id=(select auth.uid())));
create policy own_content_history on public.content_history for select to authenticated
  using (user_id=(select auth.uid()) and exists(select 1 from public.app_members m where m.user_id=(select auth.uid())));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('jove-content-audio','jove-content-audio',false,67108864,array['audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/x-wav','audio/aac'])
on conflict(id) do nothing;
-- No browser Storage policy is added. The authenticated gateway signs ONLY eligible owner recommendations.

-- One service-only RPC keeps lease fencing and each checkpoint atomic. Browser roles cannot invoke it.
create function public.content_worker(action text, args jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare src public.content_sources; item public.content_items; obj jsonb; row_data jsonb; result jsonb;
  t timestamptz := clock_timestamp(); source_key text := args->>'sourceId'; run_key uuid;
  owner_key uuid; lease_seconds integer := 180; n integer; item_key text; segment_key text;
begin
  if args is null or jsonb_typeof(args)<>'object' or octet_length(args::text)>8388608 then
    raise exception 'Invalid content arguments' using errcode='22023';
  end if;
  if action='owner' then
    if args->>'ownerId' is not null then
      owner_key := (args->>'ownerId')::uuid;
      if not exists(select 1 from public.app_members m where m.user_id=owner_key) then raise exception 'Not a member' using errcode='42501'; end if;
    else
      if (select count(*) from public.app_members)<>1 then return jsonb_build_object('ownerId',null); end if;
      select m.user_id into owner_key from public.app_members m limit 1;
    end if;
    return jsonb_build_object('ownerId',owner_key);
  end if;
  if action in ('candidates','recommend','learning-use','profile','status','playback') then
    owner_key := (args->>'ownerId')::uuid;
    if owner_key is null or not exists(select 1 from public.app_members m where m.user_id=owner_key) then raise exception 'Not a member' using errcode='42501'; end if;
    if action='profile' then
      if args->'profile' is not null then
        insert into public.content_profiles(user_id,profile) values(owner_key,args->'profile')
          on conflict(user_id) do update set profile=excluded.profile,updated_at=t;
      end if;
      select p.profile into result from public.content_profiles p where p.user_id=owner_key;
      return coalesce(result,'null'::jsonb);
    elsif action='status' then
      select jsonb_build_object('sources',coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.config->'name',
        'rightsStatus',c.rights_status,'rightsCheckedAt',c.rights_checked_at,'nextRightsCheckAt',c.next_rights_check_at,
        'lastPollAt',c.last_poll_at,'nextPollAt',c.next_poll_at,'failures',c.failures,
        'items',(select count(*) from public.content_items i where i.source_id=c.id),
        'eligible',(select count(*) from public.content_segments s join public.content_items i on i.id=s.item_id
          where i.source_id=c.id and s.revision=i.revision and s.status='eligible'))),'[]'))
        into result from public.content_sources c;
      return result;
    elsif action='playback' then
      select s.record into result from public.content_recommendations r
        join public.content_segments s on s.id=r.segment_id join public.content_items i on i.id=s.item_id
        join public.content_sources c on c.id=i.source_id join public.content_segment_audio a on a.segment_id=s.id and a.state='ready' and a.expires_at>t
        where r.user_id=owner_key and r.segment_id=args->>'segmentId' and r.active and s.status='eligible'
          and s.revision=i.revision and c.rights_status='verified' and c.config->>'enabled'='true'
          and c.rights_checked_at+make_interval(days=>(c.config->'rights'->>'recheckAfterDays')::integer)>t limit 1;
      if result is null then raise exception 'No eligible owner audio' using errcode='42501'; end if;
      return result;
    elsif action='candidates' then
      select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (
        select distinct on (s.content_fingerprint) s.id,s.record,
          jsonb_set(c.config,'{verifiedAt}',to_jsonb(extract(epoch from c.rights_checked_at)*1000)) as config
        from public.content_segments s join public.content_items i on i.id=s.item_id
        join public.content_sources c on c.id=i.source_id
        join public.content_segment_audio a on a.segment_id=s.id and a.state='ready' and a.expires_at>t
        where s.status='eligible' and s.revision=i.revision and (s.record->'lesson')<>'null'::jsonb
          and c.config->>'enabled'='true' and c.config->'rights'->>'status'='verified'
          and c.rights_status='verified' and c.rights_checked_at+make_interval(days=>(c.config->'rights'->>'recheckAfterDays')::integer)>t
          and not exists(select 1 from public.content_recommendations recent join public.content_segments prior on prior.id=recent.segment_id
            where recent.user_id=owner_key and recent.active and recent.created_at>t-interval '24 hours'
              and recent.request_id is distinct from args->>'requestId' and prior.content_fingerprint=s.content_fingerprint)
          and not exists(select 1 from public.content_history h join public.content_segments prior on prior.id=h.segment_id
            where h.user_id=owner_key and h.event in ('started','completed') and prior.content_fingerprint=s.content_fingerprint
            and h.created_at>t-interval '30 days')
        order by s.content_fingerprint,s.updated_at desc limit 100
      ) q;
      select coalesce(jsonb_agg(to_jsonb(q)),'[]') into row_data from (
        select r.id,r.request_id,r.segment_id,r.lesson,r.created_at
        from public.content_recommendations r join public.content_segments s on s.id=r.segment_id
        join public.content_items i on i.id=s.item_id join public.content_sources c on c.id=i.source_id
        join public.content_segment_audio a on a.segment_id=s.id and a.state='ready' and a.expires_at>t
        where r.user_id=owner_key and r.active and s.status='eligible' and s.revision=i.revision
          and c.config->>'enabled'='true' and c.config->'rights'->>'status'='verified'
          and c.rights_status='verified' and c.rights_checked_at+make_interval(days=>(c.config->'rights'->>'recheckAfterDays')::integer)>t
        order by r.created_at desc limit 50
      ) q;
      return jsonb_build_object('candidates',result,'recent',row_data);
    elsif action='recommend' then
      if jsonb_typeof(args->'lessons')<>'array' or jsonb_array_length(args->'lessons')>10 then raise exception 'Invalid recommendations' using errcode='22023'; end if;
      perform pg_advisory_xact_lock(hashtextextended(owner_key::text,4));
      result := '[]';
      for obj in select value from jsonb_array_elements(args->'lessons') loop
        segment_key := obj->>'segmentId';
        if not exists(select 1 from public.content_segments s join public.content_items i on i.id=s.item_id
          join public.content_sources c on c.id=i.source_id
          join public.content_segment_audio a on a.segment_id=s.id and a.state='ready' and a.expires_at>t
          where s.id=segment_key and s.status='eligible' and s.revision=i.revision
          and c.rights_status='verified' and c.config->>'enabled'='true' and c.config->'rights'->>'status'='verified'
          and c.rights_checked_at+make_interval(days=>(c.config->'rights'->>'recheckAfterDays')::integer)>t)
          then raise exception 'Stale content candidate' using errcode='40001'; end if;
        insert into public.content_recommendations(user_id,request_id,segment_id,lesson,fit)
          values(owner_key,args->>'requestId',segment_key,obj,(obj->>'fit')::numeric)
          on conflict(user_id,request_id,segment_id) do nothing;
        select to_jsonb(r) into row_data from public.content_recommendations r
          where r.user_id=owner_key and r.request_id=args->>'requestId' and r.segment_id=segment_key;
        result := result || jsonb_build_array(row_data);
        insert into public.content_history(user_id,segment_id,event,event_key,detail)
          values(owner_key,segment_key,'recommended',owner_key::text||':'||(args->>'requestId')||':'||segment_key,
            jsonb_build_object('fit',obj->'fit','reason',obj->'reason')) on conflict(event_key) do nothing;
      end loop;
      return result;
    else
      if args->>'event' not in ('started','completed','skipped') then raise exception 'Invalid learning event' using errcode='22023'; end if;
      if not exists(select 1 from public.content_recommendations r where r.user_id=owner_key and r.segment_id=args->>'segmentId' and r.active) then
        raise exception 'No owner recommendation' using errcode='42501';
      end if;
      insert into public.content_history(user_id,segment_id,event,event_key)
        values(owner_key,args->>'segmentId',args->>'event',owner_key::text||':'||(args->>'eventId')) on conflict(event_key) do nothing;
      return '{}'::jsonb;
    end if;
  end if;
  if action='claim' then
    run_key := (args->>'runId')::uuid;
    if run_key is null or source_key is null or args->'source'->>'id'<>source_key then raise exception 'Invalid source claim' using errcode='22023'; end if;
    insert into public.content_sources(id,config,config_hash) values(source_key,args->'source',args->>'configHash') on conflict(id) do nothing;
    select * into src from public.content_sources s where s.id=source_key for update;
    if src.lease_until>t then return jsonb_build_object('acquired',false,'reason','leased'); end if;
    if src.config_hash=args->>'configHash' and src.next_rights_check_at>t and src.next_poll_at>t and not coalesce((args->>'forcePoll')::boolean,false) and not exists(
      select 1 from public.content_items i where i.source_id=source_key and
        (i.status in ('pending','retry') and i.next_attempt_at<=t and i.attempts<6 or
         coalesce((args->>'canAnalyze')::boolean,false) and (i.status='awaiting-analysis' or i.status='quarantined' and i.process_version is distinct from args->>'processVersion'))
    ) then return jsonb_build_object('acquired',false,'reason','not-due'); end if;
    if src.config_hash<>args->>'configHash' then
      update public.content_items set status='pending',next_attempt_at=t,attempts=0 where source_id=source_key;
      update public.content_segments s set status='stale' where s.item_id in(select i.id from public.content_items i where i.source_id=source_key);
      update public.content_recommendations r set active=false where r.segment_id in(select s.id from public.content_segments s join public.content_items i on i.id=s.item_id where i.source_id=source_key);
    end if;
    update public.content_sources set config=args->'source',config_hash=args->>'configHash',lease_id=run_key,
      lease_until=t+make_interval(secs=>lease_seconds),updated_at=t where id=source_key;
    return to_jsonb(src)||jsonb_build_object('acquired',true,'rightsDue',src.config_hash<>args->>'configHash' or src.next_rights_check_at<=t,
      'feedDue',src.config_hash<>args->>'configHash' or src.next_poll_at<=t or coalesce((args->>'forcePoll')::boolean,false));
  end if;
  run_key := (args->>'runId')::uuid;
  select * into src from public.content_sources s where s.id=source_key for update;
  if not found or run_key is null or src.lease_id is distinct from run_key or src.lease_until<=t then
    raise exception 'Content lease lost' using errcode='40001';
  end if;
  if action='heartbeat' then
    update public.content_sources set lease_until=t+make_interval(secs=>lease_seconds) where id=source_key;
    return '{}'::jsonb;
  elsif action='retention' then
    -- Mark inaccessible before object deletion. Retrying a failed delete returns the same exact paths.
    update public.content_audio_assets a set state='deleting' from public.content_items i
      where a.item_id=i.id and i.source_id=source_key and (a.expires_at<=t or a.revision<>i.revision or
        i.status in ('eligible','quarantined') or a.state='preparing' and a.created_at<t-interval '1 day');
    update public.content_segment_audio a set state='deleting' from public.content_segments s join public.content_items i on i.id=s.item_id
      where a.segment_id=s.id and i.source_id=source_key and (a.expires_at<=t or s.status='stale' or s.revision<>i.revision or
        a.state='preparing' and a.created_at<t-interval '1 day');
    update public.content_segments s set status='stale' from public.content_segment_audio a where a.segment_id=s.id and a.state='deleting';
    update public.content_recommendations r set active=false from public.content_segments s where s.id=r.segment_id and s.status='stale';
    select coalesce(jsonb_agg(q.object_path),'[]') into result from (
      select a.object_path from public.content_audio_assets a join public.content_items i on i.id=a.item_id where i.source_id=source_key and a.state='deleting'
      union all select a.object_path from public.content_segment_audio a join public.content_segments s on s.id=a.segment_id
        join public.content_items i on i.id=s.item_id where i.source_id=source_key and a.state='deleting' limit 100
    ) q;
    delete from public.content_transcripts tr using public.content_items i where tr.item_id=i.id and i.source_id=source_key and tr.expires_at<=t;
    return result;
  elsif action='retention-finish' then
    if jsonb_typeof(args->'paths')<>'array' or jsonb_array_length(args->'paths')>100 then raise exception 'Invalid deletion batch' using errcode='22023'; end if;
    delete from public.content_audio_assets a using public.content_items i where a.item_id=i.id and i.source_id=source_key
      and a.state='deleting' and a.object_path in(select jsonb_array_elements_text(args->'paths'));
    delete from public.content_segment_audio a using public.content_segments s,public.content_items i
      where a.segment_id=s.id and s.item_id=i.id and i.source_id=source_key and a.state='deleting'
      and a.object_path in(select jsonb_array_elements_text(args->'paths'));
    return '{}'::jsonb;
  elsif action='rights-check' then
    obj := args->'check';
    if obj->>'status' not in ('verified','changed','unavailable') or jsonb_typeof(obj->'evidence')<>'array' then
      raise exception 'Invalid rights check' using errcode='22023';
    end if;
    if obj->>'status'='verified' and (jsonb_array_length(obj->'evidence')<1 or exists(
      select 1 from jsonb_array_elements(obj->'evidence') e where e->>'observedHash' is distinct from e->>'expectedHash'
        or e->>'bodyHash' is null or e->>'observedHash' is null)) then
      raise exception 'Unverified rights evidence' using errcode='22023';
    end if;
    insert into public.content_rights_checks(source_id,status,evidence,reason) values(source_key,obj->>'status',obj->'evidence',obj->>'reason');
    update public.content_sources set rights_status=case when obj->>'status'='unavailable' then rights_status else obj->>'status' end,
      rights_checked_at=case when obj->>'status'='verified' then t else rights_checked_at end,
      next_rights_check_at=t+case when obj->>'status'='verified' then interval '7 days' else interval '1 day' end where id=source_key;
    if obj->>'status'='changed' then
      update public.content_segments s set status='stale' where s.item_id in(select i.id from public.content_items i where i.source_id=source_key);
      update public.content_recommendations r set active=false where r.segment_id in(select s.id from public.content_segments s join public.content_items i on i.id=s.item_id where i.source_id=source_key);
    elsif obj->>'status'='verified' and src.rights_status='changed' then
      update public.content_items set status='pending',next_attempt_at=t,attempts=0 where source_id=source_key;
    end if;
    return '{}'::jsonb;
  elsif action='ingest' then
    if jsonb_typeof(args->'items')<>'array' or jsonb_array_length(args->'items')>100 then raise exception 'Invalid feed batch' using errcode='22023'; end if;
    n := 0;
    for obj in select value from jsonb_array_elements(args->'items') loop
      if obj->'episode'->>'sourceId'<>source_key then raise exception 'Source mismatch' using errcode='22023'; end if;
      item_key := obj->>'id';
      select * into item from public.content_items i where i.id=item_key;
      if not found then
        insert into public.content_items(id,source_id,guid,revision,episode)
          values(item_key,source_key,obj->'episode'->>'guid',obj->>'revision',obj->'episode'); n:=n+1;
      elsif item.source_id<>source_key then raise exception 'Item identity collision' using errcode='23505';
      elsif item.revision<>obj->>'revision' then
        update public.content_items set revision=obj->>'revision',episode=obj->'episode',status='pending',attempts=0,next_attempt_at=t,updated_at=t where id=item_key;
        update public.content_segments set status='stale' where item_id=item_key;
        update public.content_recommendations set active=false where segment_id in(select id from public.content_segments where item_id=item_key);
        n:=n+1;
      end if;
    end loop;
    return jsonb_build_object('changed',n);
  elsif action='poll' then
    update public.content_sources set etag=args->>'etag',last_modified=args->>'lastModified',feed_hash=coalesce(args->>'feedHash',feed_hash),
      last_poll_at=t,next_poll_at=t+make_interval(secs=>least(604800,greatest(3600,(args->>'pollSeconds')::integer))),failures=0 where id=source_key;
    insert into public.content_history(source_id,event,detail) values(source_key,'feed-polled',jsonb_build_object('status',args->'status','heldItems',args->'heldItems'));
    return '{}'::jsonb;
  elsif action='pending' then
    select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (
      select i.*,tr.transcript,au.object_path,au.sha256 as audio_sha256,au.bytes as audio_bytes,au.mime_type as audio_mime,
        (select coalesce(jsonb_agg(s.record),'[]') from public.content_segments s where s.item_id=i.id and s.revision=i.revision and s.status<>'stale') as saved_segments
      from public.content_items i left join public.content_transcripts tr on tr.item_id=i.id and tr.revision=i.revision and tr.expires_at>t
      left join public.content_audio_assets au on au.item_id=i.id and au.revision=i.revision and au.state='ready' and au.expires_at>t
      where i.source_id=source_key and (i.status in ('pending','retry') and i.next_attempt_at<=t and i.attempts<6 or
        coalesce((args->>'canAnalyze')::boolean,false) and (i.status='awaiting-analysis' or i.status='quarantined' and i.process_version is distinct from args->>'processVersion'))
      order by i.created_at,i.id limit least(10,greatest(1,coalesce((args->>'limit')::integer,2)))
    ) q;
    return result;
  elsif action in ('checkpoint','save-segment','finish-item','asset','asset-ready','clip','clip-ready','usage') then
    item_key := args->>'itemId';
    select * into item from public.content_items i where i.id=item_key and i.source_id=source_key;
    if not found or item.revision<>args->>'revision' then raise exception 'Stale content item' using errcode='40001'; end if;
    if action='checkpoint' then
      insert into public.content_transcripts(item_id,revision,fingerprint,transcript)
        values(item_key,item.revision,args->>'fingerprint',args->'transcript')
        on conflict(item_id) do update set revision=excluded.revision,fingerprint=excluded.fingerprint,transcript=excluded.transcript,expires_at=t+interval '30 days';
    elsif action='asset' then
      -- Reserve bounded capacity BEFORE upload, including in-flight uploads from other source leases.
      perform pg_advisory_xact_lock(hashtextextended('jove-content-storage',4));
      if not exists(select 1 from public.content_audio_assets a where a.item_id=item_key and a.revision=item.revision) and
        coalesce((select sum(a.bytes) from public.content_audio_assets a),0)+(args->>'bytes')::bigint>268435456 then
        raise exception 'Episode cache capacity reached' using errcode='53000'; end if;
      insert into public.content_audio_assets(item_id,revision,sha256,object_path,bytes,mime_type)
        values(item_key,item.revision,args->>'sha256',args->>'objectPath',(args->>'bytes')::bigint,args->>'mimeType')
        on conflict(item_id,revision) do nothing;
      if not exists(select 1 from public.content_audio_assets a where a.item_id=item_key and a.revision=item.revision and a.sha256=args->>'sha256') then
        raise exception 'Audio artifact conflict' using errcode='23505';
      end if;
    elsif action='asset-ready' then
      update public.content_audio_assets set state='ready' where item_id=item_key and revision=item.revision and sha256=args->>'sha256' and state<>'deleting';
      if not found then raise exception 'Audio reservation lost' using errcode='40001'; end if;
    elsif action='clip' then
      segment_key:=args->>'segmentId'; obj:=args->'clip';
      if not exists(select 1 from public.content_segments s where s.id=segment_key and s.item_id=item_key and s.revision=item.revision) or
        not exists(select 1 from public.content_audio_assets a where a.item_id=item_key and a.revision=item.revision and a.state='ready' and a.sha256=obj->>'sourceAudioSha256') or
        obj->>'objectPath'<>'clips/'||substring(segment_key from 11)||'/'||(obj->>'audioSha256') then
        raise exception 'Clip binding mismatch' using errcode='22023'; end if;
      perform pg_advisory_xact_lock(hashtextextended('jove-content-storage',4));
      if not exists(select 1 from public.content_segment_audio a where a.segment_id=segment_key) and
        coalesce((select sum(a.bytes) from public.content_segment_audio a),0)+(obj->>'byteLength')::bigint>536870912 then
        raise exception 'Clip cache capacity reached' using errcode='53000'; end if;
      insert into public.content_segment_audio(segment_id,object_path,sha256,source_sha256,bytes,mime_type,origin_seconds,
        source_start,source_end,clip_start,clip_end,duration_seconds,timing_basis)
        values(segment_key,obj->>'objectPath',obj->>'audioSha256',obj->>'sourceAudioSha256',(obj->>'byteLength')::bigint,obj->>'mimeType',
          (obj->>'clipOriginSeconds')::double precision,(obj->>'sourceStartSeconds')::double precision,(obj->>'sourceEndSeconds')::double precision,
          (obj->>'startSeconds')::double precision,(obj->>'endSeconds')::double precision,(obj->>'durationSeconds')::double precision,obj->>'timingBasis')
        on conflict(segment_id) do nothing;
      if not exists(select 1 from public.content_segment_audio a where a.segment_id=segment_key and a.sha256=obj->>'audioSha256' and a.source_sha256=obj->>'sourceAudioSha256' and a.state<>'deleting') then
        raise exception 'Clip artifact conflict' using errcode='23505'; end if;
    elsif action='clip-ready' then
      update public.content_segment_audio a set state='ready' from public.content_segments s
        where a.segment_id=s.id and s.item_id=item_key and s.revision=item.revision and a.segment_id=args->>'segmentId' and a.sha256=args->>'sha256' and a.state<>'deleting';
      if not found then raise exception 'Clip reservation lost' using errcode='40001'; end if;
    elsif action='save-segment' then
      obj := args->'record'; segment_key := obj->'segment'->>'id';
      if obj->'segment'->>'sourceId'<>source_key or obj->>'status' not in ('quarantined','eligible') then raise exception 'Invalid content segment' using errcode='22023'; end if;
      if obj->>'status'='eligible' and (coalesce(obj->'inspection','null')='null'::jsonb or coalesce(obj->'artifact','null')='null'::jsonb or
        coalesce(obj->'lesson','null')='null'::jsonb or coalesce(obj->'material'->>'approved','false')<>'true' or not exists(
          select 1 from public.content_segment_audio a where a.segment_id=segment_key and a.state='ready' and a.expires_at>t
            and a.sha256=obj->'clip'->>'audioSha256' and a.object_path=obj->'clip'->>'objectPath'
            and a.sha256=obj->'audioEvidence'->>'submittedAudioSha256' and a.source_sha256=obj->'artifact'->>'sha256')) then
        raise exception 'Uninspected content cannot be eligible' using errcode='22023';
      end if;
      insert into public.content_segments(id,item_id,revision,content_fingerprint,status,record)
        values(segment_key,item_key,item.revision,obj->'segment'->>'contentFingerprint',obj->>'status',obj)
        on conflict(id) do update set revision=excluded.revision,status=excluded.status,record=excluded.record,updated_at=t;
      insert into public.content_scores(segment_id,report) values(segment_key,obj->'quality')
        on conflict(segment_id) do update set report=excluded.report,updated_at=t;
      for row_data in select value from jsonb_array_elements(obj->'segment'->'sentences') loop
        if nullif(row_data->>'speaker','') is not null then
          insert into public.content_speakers(segment_id,label) values(segment_key,row_data->>'speaker') on conflict do nothing;
        end if;
      end loop;
      if obj->>'status'<>'eligible' then update public.content_recommendations set active=false where segment_id=segment_key; end if;
      insert into public.content_history(source_id,item_id,segment_id,event,detail)
        values(source_key,item_key,segment_key,'segment-screened',jsonb_build_object('status',obj->'status','reasons',obj->'quality'->'reasons'));
    elsif action='usage' then
      owner_key := (args->>'ownerId')::uuid;
      if not exists(select 1 from public.app_members m where m.user_id=owner_key) then raise exception 'Not a member' using errcode='42501'; end if;
      insert into public.content_usage(request_id,user_id,item_id,purpose,status,cost_usd,usage)
        values(args->>'requestId',owner_key,item_key,args->>'purpose',args->>'status',(args->'usage'->>'costUsd')::numeric,coalesce(args->'usage','{}'))
        on conflict(request_id) do nothing;
    else
      update public.content_items set status=args->>'status',reasons=coalesce(args->'reasons','[]'),
        process_version=args->>'processVersion',attempts=attempts+1,
        next_attempt_at=t+make_interval(secs=>least(604800,greatest(60,coalesce((args->>'retrySeconds')::integer,3600)))),updated_at=t where id=item_key;
      insert into public.content_history(source_id,item_id,event,detail) values(source_key,item_key,'item-checkpoint',jsonb_build_object('status',args->'status','reasons',args->'reasons'));
    end if;
    return '{}'::jsonb;
  elsif action='release' then
    if coalesce((args->>'failed')::boolean,false) then
      update public.content_sources set failures=least(1000,failures+1),
        next_poll_at=t+make_interval(secs=>least(604800,greatest(60,coalesce((args->>'retrySeconds')::integer,3600)))) where id=source_key;
    end if;
    update public.content_sources set lease_id=null,lease_until=null,updated_at=t where id=source_key;
    return '{}'::jsonb;
  end if;
  raise exception 'Unsupported content operation' using errcode='22023';
end;
$$;
revoke all on function public.content_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.content_worker(text,jsonb) to service_role;

-- Installation is explicit: the owner configures only this project's pg_cron, pg_net and Vault.
-- This migration NEVER writes a secret or automatically starts a job.
create function public.install_content_schedule(edge_url text, vault_secret_name text) returns bigint
language plpgsql security definer set search_path='' as $$
declare job_id bigint;
begin
  if edge_url !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/content$'
    or vault_secret_name !~ '^jove-content-job-[a-z0-9-]{1,60}$' then
    raise exception 'Invalid dedicated content schedule target' using errcode='22023';
  end if;
  if not exists(select 1 from pg_extension where extname='pg_cron') or not exists(select 1 from pg_extension where extname='pg_net') then
    raise exception 'Enable pg_cron and pg_net in the dedicated Jove backend first' using errcode='55000';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name=vault_secret_name and length(decrypted_secret)>=32) then
    raise exception 'Configure the dedicated job credential in Vault first' using errcode='55000';
  end if;
  execute 'select cron.schedule($1,$2,$3)' into job_id using 'jove-content-refresh','17 */6 * * *',format(
    'select net.http_post(url:=%L,headers:=jsonb_build_object(''Content-Type'',''application/json'',''X-Jove-Content-Job'',(select decrypted_secret from vault.decrypted_secrets where name=%L)),body:=''{}''::jsonb,timeout_milliseconds:=120000);',
    edge_url,vault_secret_name);
  return job_id;
end;
$$;
revoke all on function public.install_content_schedule(text,text) from public,anon,authenticated;
grant execute on function public.install_content_schedule(text,text) to service_role;
