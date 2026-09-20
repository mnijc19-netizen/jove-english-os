-- Extend the existing metadata-only capability. No media, owner data or new grants.
alter table public.external_course_catalog drop constraint external_course_catalog_source_id_check;
alter table public.external_course_catalog add constraint external_course_catalog_source_id_check
  check (source_id in ('voa-level1','voa-level2','bbc-six-minute','ja-tadoku'));

create or replace function public.external_catalog_worker(action text, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare token uuid; snapshot jsonb; committed boolean; selected_source text; lesson_count integer; entry_count integer;
begin
  if jsonb_typeof(args) is distinct from 'object' then raise exception 'Invalid catalog request' using errcode='22023'; end if;
  selected_source := coalesce(args->>'sourceId','voa-level1');
  if selected_source not in ('voa-level1','voa-level2','bbc-six-minute','ja-tadoku')
    or (args ? 'sourceId' and jsonb_typeof(args->'sourceId') is distinct from 'string') then
    raise exception 'Unknown catalog source' using errcode='22023';
  end if;
  lesson_count := case selected_source when 'voa-level1' then 52 when 'voa-level2' then 30 else null end;
  if action = 'read' then
    select catalog into snapshot from public.external_course_catalog
      where source_id=selected_source and last_success_at > now() - interval '90 days';
    return snapshot;
  elsif action = 'claim' then
    insert into public.external_course_catalog(source_id) values (selected_source) on conflict do nothing;
    update public.external_course_catalog set lease_token=gen_random_uuid(), lease_until=now()+interval '2 minutes', last_attempt_at=now()
      where source_id=selected_source and next_attempt_at <= now() and (lease_until is null or lease_until <= now())
      returning lease_token into token;
    return jsonb_build_object('leaseToken',token);
  elsif action = 'commit' then
    snapshot := args->'catalog';
    if jsonb_typeof(snapshot) is distinct from 'object' or octet_length(snapshot::text)>262144
      or snapshot->>'sourceId' is distinct from selected_source or snapshot->>'language' is distinct from (case selected_source when 'ja-tadoku' then 'ja' else 'en' end)
      or snapshot->>'version' is distinct from '1' or coalesce(snapshot->>'revision','') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(snapshot->'entries') is distinct from 'array' then
      raise exception 'Invalid catalog snapshot' using errcode='22023';
    end if;
    entry_count := jsonb_array_length(snapshot->'entries');
    if selected_source = 'ja-tadoku' then
      if entry_count < 7 or entry_count > 500 or exists (
        select 1 from jsonb_array_elements(snapshot->'entries') e
        where jsonb_typeof(e) is distinct from 'object'
          or jsonb_typeof(e->'id') is distinct from 'string' or coalesce(e->>'id','') !~ '^[1-9][0-9]{0,7}$'
          or (e->>'url') is distinct from ('https://tadoku.org/japanese/book/' || (e->>'id') || '/')
          or jsonb_typeof(e->'title') is distinct from 'string' or length(e->>'title') not between 1 and 300
          or (e->>'title') ~ '[<>[:cntrl:]]'
          or jsonb_typeof(e->'level') is distinct from 'string'
          or coalesce(e->>'level','') not in ('Start','0','1','2','3','4','5')
      ) or (select count(distinct e->>'id') from jsonb_array_elements(snapshot->'entries') e)<>entry_count
        or (select count(distinct e->>'level') from jsonb_array_elements(snapshot->'entries') e)<>7 then
        raise exception 'Invalid or incomplete reading catalog' using errcode='22023';
      end if;
    elsif selected_source = 'bbc-six-minute' then
      if entry_count < 1 or entry_count > 52 or exists (
        select 1 from jsonb_array_elements(snapshot->'entries') e
        where jsonb_typeof(e) is distinct from 'object'
          or coalesce(e->>'id','') !~ '^p[a-z0-9]{7}$'
          or coalesce(e->>'url','') !~ '^https://www\.bbc\.co\.uk/learningenglish/english/features/6-minute-english_20[0-9]{2}/ep-[0-9]{6}$'
          or jsonb_typeof(e->'title') is distinct from 'string' or length(e->>'title') not between 1 and 160
          or (e->>'title') ~ '[<>[:cntrl:]]'
          or jsonb_typeof(e->'publishedAt') is distinct from 'number' or coalesce(e->>'publishedAt','') !~ '^[0-9]{1,15}$'
          or jsonb_typeof(e->'duration') is distinct from 'number' or coalesce(e->>'duration','') !~ '^[0-9]{3}$'
      ) then raise exception 'Invalid episode metadata' using errcode='22023'; end if;
      if exists (select 1 from jsonb_array_elements(snapshot->'entries') e
        where (e->>'publishedAt')::bigint > floor(extract(epoch from now())*1000)::bigint
          or (e->>'publishedAt')::bigint <= floor(extract(epoch from now()-interval '365 days')*1000)::bigint
          or (e->>'duration')::integer not between 180 and 600)
        or (select count(distinct e->>'id') from jsonb_array_elements(snapshot->'entries') e)<>entry_count
        or (select count(distinct e->>'url') from jsonb_array_elements(snapshot->'entries') e)<>entry_count then
        raise exception 'Stale or ambiguous episode metadata' using errcode='22023';
      end if;
    elsif entry_count <> lesson_count or exists (
      select 1 from jsonb_array_elements(snapshot->'entries') e
      where jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'position') is distinct from 'number'
        or coalesce(e->>'position','') !~ case selected_source when 'voa-level1' then '^([1-9]|[1-4][0-9]|5[0-2])$' else '^([1-9]|[12][0-9]|30)$' end
        or coalesce(e->>'url','') !~ '^https://learningenglish\.voanews\.com/a/[a-z0-9-]+/[0-9]+\.html$'
    ) or (select count(distinct e->>'position') from jsonb_array_elements(snapshot->'entries') e)<>lesson_count
      or (select count(distinct e->>'url') from jsonb_array_elements(snapshot->'entries') e)<>lesson_count then
      raise exception 'Incomplete or ambiguous catalog' using errcode='22023';
    end if;
    snapshot := jsonb_set(snapshot,'{checkedAt}',to_jsonb(floor(extract(epoch from now())*1000)::bigint));
    update public.external_course_catalog set catalog=snapshot, last_success_at=now(), next_attempt_at=now()+interval '6 hours',
      lease_token=null, lease_until=null, failures=0
      where source_id=selected_source and lease_token=(args->>'leaseToken')::uuid and lease_until>now()
      returning true into committed;
    return to_jsonb(coalesce(committed,false));
  elsif action = 'fail' then
    update public.external_course_catalog set failures=least(failures+1,1000000), next_attempt_at=now()+interval '1 hour',
      lease_token=null, lease_until=null
      where source_id=selected_source and lease_token=(args->>'leaseToken')::uuid and lease_until>now();
    return 'true'::jsonb;
  end if;
  raise exception 'Unknown catalog action' using errcode='22023';
end;
$$;
revoke all on function public.external_catalog_worker(text,jsonb) from public, anon, authenticated;
grant execute on function public.external_catalog_worker(text,jsonb) to service_role;
