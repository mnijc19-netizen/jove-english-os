-- Page-only course snapshots; no link to acoustic eligibility or paid usage tables.
create table public.external_course_catalog (
  source_id text primary key check (source_id = 'voa-level1'),
  language text not null default 'en' check (language = 'en'),
  catalog jsonb,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default '-infinity',
  lease_token uuid,
  lease_until timestamptz,
  failures integer not null default 0 check (failures >= 0),
  check (catalog is null or (jsonb_typeof(catalog) = 'object' and octet_length(catalog::text) <= 262144))
);
alter table public.external_course_catalog enable row level security;
revoke all on public.external_course_catalog from public, anon, authenticated;
grant select, insert, update on public.external_course_catalog to service_role;

create function public.external_catalog_worker(action text, args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare token uuid; snapshot jsonb; committed boolean;
begin
  if jsonb_typeof(args) is distinct from 'object' then raise exception 'Invalid catalog request' using errcode='22023'; end if;
  if action = 'read' then
    select catalog into snapshot from public.external_course_catalog
      where source_id='voa-level1' and last_success_at > now() - interval '90 days';
    return snapshot;
  elsif action = 'claim' then
    insert into public.external_course_catalog(source_id) values ('voa-level1') on conflict do nothing;
    update public.external_course_catalog set lease_token=gen_random_uuid(), lease_until=now()+interval '2 minutes', last_attempt_at=now()
      where source_id='voa-level1' and next_attempt_at <= now() and (lease_until is null or lease_until <= now())
      returning lease_token into token;
    return jsonb_build_object('leaseToken',token);
  elsif action = 'commit' then
    snapshot := args->'catalog';
    if jsonb_typeof(snapshot) is distinct from 'object' or octet_length(snapshot::text)>262144
      or snapshot->>'sourceId' is distinct from 'voa-level1' or snapshot->>'language' is distinct from 'en'
      or snapshot->>'version' is distinct from '1' or coalesce(snapshot->>'revision','') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(snapshot->'entries') is distinct from 'array' then
      raise exception 'Invalid catalog snapshot' using errcode='22023';
    end if;
    if jsonb_array_length(snapshot->'entries') <> 52 or exists (
      select 1 from jsonb_array_elements(snapshot->'entries') e
      where jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'position') is distinct from 'number'
        or coalesce(e->>'position','') !~ '^([1-9]|[1-4][0-9]|5[0-2])$'
        or coalesce(e->>'url','') !~ '^https://learningenglish\.voanews\.com/a/[a-z0-9-]+/[0-9]+\.html$'
    ) or (select count(distinct e->>'position') from jsonb_array_elements(snapshot->'entries') e)<>52
      or (select count(distinct e->>'url') from jsonb_array_elements(snapshot->'entries') e)<>52 then
      raise exception 'Incomplete or ambiguous catalog' using errcode='22023';
    end if;
    -- Database time controls freshness, not a caller-provided future timestamp.
    snapshot := jsonb_set(snapshot,'{checkedAt}',to_jsonb(floor(extract(epoch from now())*1000)::bigint));
    update public.external_course_catalog set catalog=snapshot, last_success_at=now(), next_attempt_at=now()+interval '6 hours',
      lease_token=null, lease_until=null, failures=0
      where source_id='voa-level1' and lease_token=(args->>'leaseToken')::uuid and lease_until>now()
      returning true into committed;
    return to_jsonb(coalesce(committed,false));
  elsif action = 'fail' then
    update public.external_course_catalog set failures=least(failures+1,1000000), next_attempt_at=now()+interval '1 hour',
      lease_token=null, lease_until=null
      where source_id='voa-level1' and lease_token=(args->>'leaseToken')::uuid and lease_until>now();
    return 'true'::jsonb;
  end if;
  raise exception 'Unknown catalog action' using errcode='22023';
end;
$$;
revoke all on function public.external_catalog_worker(text,jsonb) from public, anon, authenticated;
grant execute on function public.external_catalog_worker(text,jsonb) to service_role;

-- Explicit operator installation after handler acceptance. Never starts the old audio job.
create function public.install_external_catalog_schedule(edge_url text, vault_secret_name text) returns bigint
language plpgsql security invoker set search_path='' as $$
declare job_id bigint;
begin
  if edge_url is distinct from 'https://lnkxdwzdcrtlucaezhkd.supabase.co/functions/v1/content'
    or coalesce(vault_secret_name,'') !~ '^jove-content-job-[a-z0-9-]{1,60}$' then
    raise exception 'Invalid dedicated catalog schedule target' using errcode='22023';
  end if;
  if not exists(select 1 from pg_extension where extname='pg_cron') or not exists(select 1 from pg_extension where extname='pg_net') then
    raise exception 'Configure the dedicated scheduler extensions first' using errcode='55000';
  end if;
  if not exists(select 1 from vault.decrypted_secrets where name=vault_secret_name and length(decrypted_secret)>=32) then
    raise exception 'Configure the dedicated scheduler credential first' using errcode='55000';
  end if;
  execute 'select cron.schedule($1,$2,$3)' into job_id using 'jove-external-catalog-refresh','37 */6 * * *',format(
    'select net.http_post(url:=%L,headers:=jsonb_build_object(''Content-Type'',''application/json'',''X-Jove-Content-Job'',(select decrypted_secret from vault.decrypted_secrets where name=%L)),body:='' {"action":"catalog-refresh"} ''::jsonb,timeout_milliseconds:=60000);',
    edge_url,vault_secret_name);
  return job_id;
end;
$$;
revoke all on function public.install_external_catalog_schedule(text,text) from public,anon,authenticated;
