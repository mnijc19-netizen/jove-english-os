create table public.service_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_budget_usd numeric(12,6) not null default 1 check (daily_budget_usd between 0 and 1000),
  monthly_budget_usd numeric(12,6) not null default 30 check (monthly_budget_usd between 0 and 10000),
  recording_retention text not null default 'minimal' check (recording_retention in ('minimal','assessment-only','more-history')),
  prosody_enabled boolean not null default true
);
alter table public.service_preferences enable row level security;
create policy own_preferences on public.service_preferences for all to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.app_members m where m.user_id = (select auth.uid())));
grant select, insert, update on public.service_preferences to authenticated;
revoke all on public.service_preferences from anon;

create table public.service_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (length(request_id) between 1 and 100),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  dispatch_nonce uuid not null,
  service text not null check (service in ('llm','stt','tts','pronunciation','content','storage')),
  status text not null check (status in ('reserved','completed','failed','uncertain')),
  reserved_usd numeric(14,8) not null check (reserved_usd >= 0),
  actual_usd numeric(14,8) check (actual_usd >= 0),
  units numeric(14,4) not null default 0 check (units >= 0),
  unit_name text not null default 'request',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, request_id)
);
create index service_usage_owner_time on public.service_usage(user_id, created_at);
alter table public.service_usage enable row level security;
create policy own_usage on public.service_usage for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.service_usage from anon, authenticated;
grant select on public.service_usage to authenticated;

create table public.service_results (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  result jsonb not null check (octet_length(result::text) <= 2097152),
  expires_at timestamptz not null default now() + interval '7 days',
  primary key(user_id,request_id),
  foreign key(user_id,request_id) references public.service_usage(user_id,request_id) on delete cascade
);
alter table public.service_results enable row level security;
create policy own_service_result on public.service_results for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.service_results from anon, authenticated;
grant select on public.service_results to authenticated;

create table public.acoustic_assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id text not null,
  recording_id text not null,
  reference_id text not null,
  result jsonb not null check (octet_length(result::text) <= 1048576),
  created_at timestamptz not null default now(),
  unique(user_id,attempt_id)
);
alter table public.acoustic_assessments enable row level security;
create policy own_acoustic_result on public.acoustic_assessments for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.acoustic_assessments from anon, authenticated;
grant select on public.acoustic_assessments to authenticated;

-- Only the authenticated server gateway may reserve a provider call. Client code
-- cannot invent usage, clear a reservation, insert an assessment or raise its score.
create function public.reserve_service_call(owner_id uuid, request_id text, fingerprint text, service text, estimated_usd numeric, claim_nonce uuid)
returns public.service_usage language plpgsql security definer set search_path = '' as $$
declare settings public.service_preferences; existing public.service_usage; reserved public.service_usage;
  day_total numeric; month_total numeric;
begin
  if owner_id is null or not exists(select 1 from public.app_members m where m.user_id = owner_id) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if estimated_usd is null or estimated_usd < 0 or estimated_usd > 1000 then raise exception 'Invalid reservation' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,1));
  select * into existing from public.service_usage u where u.user_id = owner_id and u.request_id = reserve_service_call.request_id;
  if found then
    if existing.fingerprint <> reserve_service_call.fingerprint or existing.service <> reserve_service_call.service then
      raise exception 'Request identity collision' using errcode='23505';
    end if;
    return existing;
  end if;
  insert into public.service_preferences(user_id) values (owner_id) on conflict do nothing;
  select * into settings from public.service_preferences p where p.user_id = owner_id;
  select coalesce(sum(coalesce(u.actual_usd,u.reserved_usd)),0) into day_total from public.service_usage u
    where u.user_id=owner_id and u.created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
  select coalesce(sum(coalesce(u.actual_usd,u.reserved_usd)),0) into month_total from public.service_usage u
    where u.user_id=owner_id and u.created_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  if day_total + estimated_usd > settings.daily_budget_usd or month_total + estimated_usd > settings.monthly_budget_usd then
    raise exception 'Practice budget reached' using errcode='P0001';
  end if;
  insert into public.service_usage(user_id,request_id,fingerprint,dispatch_nonce,service,status,reserved_usd)
    values(owner_id,request_id,fingerprint,claim_nonce,service,'reserved',estimated_usd) returning * into reserved;
  return reserved;
end;
$$;
revoke all on function public.reserve_service_call(uuid,text,text,text,numeric,uuid) from public,anon,authenticated;
grant execute on function public.reserve_service_call(uuid,text,text,text,numeric,uuid) to service_role;

-- Aggregate on the server rather than silently truncating a month at the REST
-- row limit. All periods use UTC; held/unknown charges are separate from bills.
create function public.account_service_summary()
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare owner uuid := auth.uid(); output jsonb;
begin
  if owner is null or not exists(select 1 from public.app_members m where m.user_id=owner) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  with periods(name, starts_at) as (
    values ('today', date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
      ('week', date_trunc('week',now() at time zone 'UTC') at time zone 'UTC'),
      ('month', date_trunc('month',now() at time zone 'UTC') at time zone 'UTC')
  ), summaries as (
    select p.name, p.starts_at, count(u.id) as requests,
      count(u.id) filter(where u.actual_usd is null) as unknown_count,
      coalesce(sum(u.actual_usd),0) as reported_usd,
      coalesce(sum(u.reserved_usd) filter(where u.actual_usd is null),0) as held_usd
    from periods p left join public.service_usage u on u.user_id=owner and u.created_at>=p.starts_at
    group by p.name,p.starts_at
  )
  select jsonb_object_agg(name,jsonb_build_object('startsAt',starts_at,'requests',requests,
    'unknownCount',unknown_count,'reportedUsd',reported_usd,'heldUsd',held_usd)) into output from summaries;
  return output;
end;
$$;
revoke all on function public.account_service_summary() from public,anon;
grant execute on function public.account_service_summary() to authenticated;
