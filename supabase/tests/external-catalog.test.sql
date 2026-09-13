-- Run in an isolated transaction together with the additive migration, then ROLLBACK.
set local plpgsql.check_asserts = on;
set local role anon;
do $$ begin
  begin perform public.external_catalog_worker('read'); raise exception 'anon RPC access unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.external_course_catalog; raise exception 'anon table access unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
do $$ begin
  begin perform public.external_catalog_worker('claim'); raise exception 'authenticated write unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin perform public.install_external_catalog_schedule('https://lnkxdwzdcrtlucaezhkd.supabase.co/functions/v1/content','jove-content-job-test');
    raise exception 'authenticated scheduler access unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end $$;
set local role service_role;
do $$
declare first_claim jsonb; token text; snapshot jsonb; answer jsonb; remembered jsonb;
begin
  assert public.external_catalog_worker('read') is null, 'empty catalog invented content';
  first_claim := public.external_catalog_worker('claim'); token := first_claim->>'leaseToken';
  assert token is not null, 'first claim missing';
  assert public.external_catalog_worker('claim')->>'leaseToken' is null, 'concurrent claim duplicated';
  snapshot := jsonb_build_object('version',1,'sourceId','voa-level1','language','en','checkedAt',9999999999999,'revision',repeat('a',64),
    'entries',(select jsonb_agg(jsonb_build_object('position',n,'url',format('https://learningenglish.voanews.com/a/lesson-%s/%s.html',n,9000000+n))) from generate_series(1,52)n));
  answer := public.external_catalog_worker('commit',jsonb_build_object('leaseToken',gen_random_uuid(),'catalog',snapshot));
  assert answer='false'::jsonb, 'wrong lease committed';
  begin perform public.external_catalog_worker('commit',jsonb_build_object('leaseToken',token,'catalog',jsonb_set(snapshot,'{language}','"ja"')));
    raise exception 'wrong-language snapshot accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('leaseToken',token,'catalog',jsonb_set(snapshot,'{entries}','[]')));
    raise exception 'empty replacement accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,url}','"https://evil.example/a/x/1.html"')));
    raise exception 'foreign URL accepted'; exception when invalid_parameter_value then null; end;
  assert public.external_catalog_worker('commit',jsonb_build_object('leaseToken',token,'catalog',snapshot))='true'::jsonb, 'valid snapshot not saved';
  remembered := public.external_catalog_worker('read');
  assert jsonb_array_length(remembered->'entries')=52, 'snapshot incomplete';
  assert (remembered->>'checkedAt')::bigint < 9999999999999, 'caller forged freshness';
  assert public.external_catalog_worker('claim')->>'leaseToken' is null, 'success backoff missing';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second' where source_id='voa-level1';
  token := public.external_catalog_worker('claim')->>'leaseToken';
  perform public.external_catalog_worker('fail',jsonb_build_object('leaseToken',token));
  assert public.external_catalog_worker('read')=remembered, 'failed refresh destroyed previous snapshot';
  assert public.external_catalog_worker('claim')->>'leaseToken' is null, 'failure backoff missing';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second' where source_id='voa-level1';
  token := public.external_catalog_worker('claim')->>'leaseToken';
  update public.external_course_catalog set lease_until=now()-interval '1 second' where source_id='voa-level1';
  assert public.external_catalog_worker('commit',jsonb_build_object('leaseToken',token,'catalog',snapshot))='false'::jsonb, 'expired lease committed';
  assert public.external_catalog_worker('read')=remembered, 'expired writer replaced snapshot';
  update public.external_course_catalog set last_success_at=now()-interval '91 days' where source_id='voa-level1';
  assert public.external_catalog_worker('read') is null, 'expired catalog freshly recommended';
end $$;
reset role;
do $$ begin
  assert (select relrowsecurity from pg_class where oid='public.external_course_catalog'::regclass), 'RLS not enabled';
  assert not (select prosecdef from pg_proc where oid='public.external_catalog_worker(text,jsonb)'::regprocedure), 'RPC bypasses caller privileges';
end $$;
select 'external-catalog-sql-passed' as result;
