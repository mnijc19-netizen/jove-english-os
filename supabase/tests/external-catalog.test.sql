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
do $$
declare first_token text; second_token text; snapshot jsonb; remembered jsonb;
begin
  select catalog into remembered from public.external_course_catalog where source_id='voa-level1';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second', lease_until=null where source_id='voa-level1';
  first_token := public.external_catalog_worker('claim')->>'leaseToken';
  second_token := public.external_catalog_worker('claim','{"sourceId":"voa-level2"}')->>'leaseToken';
  assert first_token is not null and second_token is not null and first_token<>second_token, 'course leases not independent';
  assert public.external_catalog_worker('read','{"sourceId":"voa-level2"}') is null, 'Level 1 leaked into Level 2';
  assert public.external_catalog_worker('claim','{"sourceId":"voa-level2"}')->>'leaseToken' is null, 'second source claim duplicated';
  snapshot := jsonb_build_object('version',1,'sourceId','voa-level2','language','en','checkedAt',9999999999999,'revision',repeat('b',64),
    'entries',(select jsonb_agg(jsonb_build_object('position',n,'url',format('https://learningenglish.voanews.com/a/level-two-lesson-%s/%s.html',n,9100000+n))) from generate_series(1,30)n));
  assert public.external_catalog_worker('commit',jsonb_build_object('sourceId','voa-level2','leaseToken',first_token,'catalog',snapshot))='false'::jsonb, 'cross-source lease committed';
  begin perform public.external_catalog_worker('commit',jsonb_build_object('leaseToken',first_token,'catalog',snapshot));
    raise exception 'default source accepted Level 2'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','voa-level2','leaseToken',second_token,'catalog',remembered));
    raise exception 'explicit source accepted wrong snapshot'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('claim','{"sourceId":"unknown"}');
    raise exception 'unknown source accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('read','{"sourceId":null}');
    raise exception 'null source accepted'; exception when invalid_parameter_value then null; end;
  assert public.external_catalog_worker('commit',jsonb_build_object('sourceId','voa-level2','leaseToken',second_token,'catalog',snapshot))='true'::jsonb, 'Level 2 snapshot failed';
  assert jsonb_array_length(public.external_catalog_worker('read','{"sourceId":"voa-level2"}')->'entries')=30, 'Level 2 incomplete';
  assert (select catalog=remembered from public.external_course_catalog where source_id='voa-level1'), 'Level 2 modified Level 1';
  perform public.external_catalog_worker('fail',jsonb_build_object('sourceId','voa-level2','leaseToken',first_token));
  assert (select failures=0 from public.external_course_catalog where source_id='voa-level2'), 'cross-source failure changed backoff';
  assert (select lease_token::text=first_token from public.external_course_catalog where source_id='voa-level1'), 'other course consumed lease';
  assert public.external_catalog_worker('claim','{"sourceId":"voa-level2"}')->>'leaseToken' is null, 'Level 2 success backoff missing';
end $$;
do $$
declare token text; snapshot jsonb; previous jsonb; remembered jsonb;
begin
  select catalog into previous from public.external_course_catalog where source_id='voa-level2';
  token := public.external_catalog_worker('claim','{"sourceId":"bbc-six-minute"}')->>'leaseToken';
  assert token is not null, 'episode lease missing';
  snapshot := jsonb_build_object('version',1,'sourceId','bbc-six-minute','language','en','checkedAt',9999999999999,'revision',repeat('c',64),
    'entries',jsonb_build_array(jsonb_build_object('id','p0abcdef','title','Everyday ideas',
      'url','https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-260917',
      'publishedAt',floor(extract(epoch from now()-interval '1 day')*1000)::bigint,'duration',381)));
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','bbc-six-minute','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,url}','"https://evil.example/episode"')));
    raise exception 'foreign episode URL accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','bbc-six-minute','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,publishedAt}','9999999999999')));
    raise exception 'future episode accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','bbc-six-minute','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries}',(snapshot->'entries')||(snapshot->'entries'))));
    raise exception 'duplicate episode accepted'; exception when invalid_parameter_value then null; end;
  assert public.external_catalog_worker('commit',jsonb_build_object('sourceId','bbc-six-minute','leaseToken',token,'catalog',snapshot))='true'::jsonb, 'episode catalog failed';
  remembered := public.external_catalog_worker('read','{"sourceId":"bbc-six-minute"}');
  assert jsonb_array_length(remembered->'entries')=1, 'variable-size episode catalog lost';
  assert (remembered->>'checkedAt')::bigint < 9999999999999, 'episode freshness forged';
  assert (select catalog=previous from public.external_course_catalog where source_id='voa-level2'), 'episode catalog overwrote VOA';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second' where source_id='bbc-six-minute';
  token := public.external_catalog_worker('claim','{"sourceId":"bbc-six-minute"}')->>'leaseToken';
  perform public.external_catalog_worker('fail',jsonb_build_object('sourceId','bbc-six-minute','leaseToken',token));
  assert public.external_catalog_worker('read','{"sourceId":"bbc-six-minute"}')=remembered, 'failed episode refresh destroyed reserve';
end $$;
reset role;
do $$ begin
  assert (select relrowsecurity from pg_class where oid='public.external_course_catalog'::regclass), 'RLS not enabled';
  assert not (select prosecdef from pg_proc where oid='public.external_catalog_worker(text,jsonb)'::regprocedure), 'RPC bypasses caller privileges';
end $$;
set local role service_role;
do $$
declare token text; snapshot jsonb; remembered jsonb; english jsonb;
begin
  english := public.external_catalog_worker('read','{"sourceId":"bbc-six-minute"}');
  token := public.external_catalog_worker('claim','{"sourceId":"ja-tadoku"}')->>'leaseToken';
  assert token is not null, 'Japanese book lease missing';
  select jsonb_build_object('version',1,'sourceId','ja-tadoku','language','ja','checkedAt',9999999999999,'revision',repeat('d',64),
    'entries',jsonb_agg(jsonb_build_object('id',i::text,'url','https://tadoku.org/japanese/book/'||i||'/',
      'title','Fixture original book','level',case when i=1 then 'Start' else (i-2)::text end))) into snapshot from generate_series(1,7) i;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-tadoku','leaseToken',token,'catalog',jsonb_set(snapshot,'{language}','"en"')));
    raise exception 'wrong book language accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-tadoku','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,url}','"https://tadoku.org/japanese/book/2/"')));
    raise exception 'mismatched book identity accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-tadoku','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,level}','"5"')));
    raise exception 'partial publisher levels accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-tadoku','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries}',(snapshot->'entries')||(snapshot->'entries'))));
    raise exception 'duplicate books accepted'; exception when invalid_parameter_value then null; end;
  assert public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-tadoku','leaseToken',token,'catalog',snapshot))='true'::jsonb, 'Japanese catalog not saved';
  remembered := public.external_catalog_worker('read','{"sourceId":"ja-tadoku"}');
  assert remembered->>'language'='ja' and jsonb_array_length(remembered->'entries')=7, 'Japanese metadata lost';
  assert (remembered->>'checkedAt')::bigint < 9999999999999, 'book freshness forged';
  assert public.external_catalog_worker('read','{"sourceId":"bbc-six-minute"}')=english, 'Japanese refresh changed English';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second' where source_id='ja-tadoku';
  token := public.external_catalog_worker('claim','{"sourceId":"ja-tadoku"}')->>'leaseToken';
  perform public.external_catalog_worker('fail',jsonb_build_object('sourceId','ja-tadoku','leaseToken',token));
  assert public.external_catalog_worker('read','{"sourceId":"ja-tadoku"}')=remembered, 'failed refresh destroyed books';
end $$;
reset role;
set local role service_role;
do $$
declare token text; snapshot jsonb; remembered jsonb; japanese jsonb;
begin
  japanese := public.external_catalog_worker('read','{"sourceId":"ja-tadoku"}');
  token := public.external_catalog_worker('claim','{"sourceId":"en-bc-reading"}')->>'leaseToken';
  assert token is not null, 'English reading lease missing';
  select jsonb_build_object('version',1,'sourceId','en-bc-reading','language','en','checkedAt',9999999999999,'revision',repeat('e',64),
    'entries',jsonb_agg(jsonb_build_object('id','fixture-reading','level',level,'title','Fixture reading',
      'url','https://learnenglish.britishcouncil.org/free-resources/reading/'||lower(level)||'/fixture-reading'))) into snapshot
    from unnest(array['A1','A2','B1','B2','C1']) level;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','en-bc-reading','leaseToken',token,'catalog',jsonb_set(snapshot,'{language}','"ja"')));
    raise exception 'wrong reader language accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','en-bc-reading','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,url}','"https://evil.example/reading"')));
    raise exception 'foreign reading page accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','en-bc-reading','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries}',(snapshot->'entries')-0)));
    raise exception 'missing reading level accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','en-bc-reading','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries}',(snapshot->'entries')||(snapshot->'entries'))));
    raise exception 'duplicate readers accepted'; exception when invalid_parameter_value then null; end;
  assert public.external_catalog_worker('commit',jsonb_build_object('sourceId','en-bc-reading','leaseToken',token,'catalog',snapshot))='true'::jsonb, 'English reader catalog not saved';
  remembered := public.external_catalog_worker('read','{"sourceId":"en-bc-reading"}');
  assert jsonb_array_length(remembered->'entries')=5 and (remembered->>'checkedAt')::bigint<9999999999999, 'English reading snapshot invalid';
  assert public.external_catalog_worker('read','{"sourceId":"ja-tadoku"}')=japanese, 'English catalog changed Japanese';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second' where source_id='en-bc-reading';
  token := public.external_catalog_worker('claim','{"sourceId":"en-bc-reading"}')->>'leaseToken';
  perform public.external_catalog_worker('fail',jsonb_build_object('sourceId','en-bc-reading','leaseToken',token));
  assert public.external_catalog_worker('read','{"sourceId":"en-bc-reading"}')=remembered, 'failed reading refresh destroyed last good snapshot';
end $$;
reset role;
set local role service_role;
do $$
declare token text; snapshot jsonb; remembered jsonb; english jsonb;
begin
  english := public.external_catalog_worker('read','{"sourceId":"en-bc-reading"}');
  token := public.external_catalog_worker('claim','{"sourceId":"ja-irodori"}')->>'leaseToken';
  assert token is not null, 'Japanese course lease missing';
  select jsonb_build_object('version',1,'sourceId','ja-irodori','language','ja','checkedAt',9999999999999,'revision',repeat('f',64),
    'entries',jsonb_agg(jsonb_build_object('course',course,'position',position,
      'url','https://www.irodori.jpf.go.jp/en/'||course||'/audio/lesson'||lpad(position::text,2,'0')||'.html'))) into snapshot
    from unnest(array['starter','elementary01','elementary02','pre-intermediate']) course cross join generate_series(1,18) position;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-irodori','leaseToken',token,'catalog',jsonb_set(snapshot,'{language}','"en"')));
    raise exception 'English course rebinding accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-irodori','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,0,url}','"https://evil.example/lesson"')));
    raise exception 'foreign playback accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-irodori','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries}',(snapshot->'entries')-0)));
    raise exception 'incomplete Japanese course accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-irodori','leaseToken',token,'catalog',jsonb_set(snapshot,'{entries,1}',snapshot->'entries'->0)));
    raise exception 'duplicate lesson accepted'; exception when invalid_parameter_value then null; end;
  assert public.external_catalog_worker('commit',jsonb_build_object('sourceId','ja-irodori','leaseToken',token,'catalog',snapshot))='true'::jsonb, 'Japanese courses not saved';
  remembered := public.external_catalog_worker('read','{"sourceId":"ja-irodori"}');
  assert jsonb_array_length(remembered->'entries')=72 and (remembered->>'checkedAt')::bigint<9999999999999, 'Japanese course snapshot invalid';
  assert public.external_catalog_worker('read','{"sourceId":"en-bc-reading"}')=english, 'Japanese course maintenance changed English';
  update public.external_course_catalog set next_attempt_at=now()-interval '1 second' where source_id='ja-irodori';
  token := public.external_catalog_worker('claim','{"sourceId":"ja-irodori"}')->>'leaseToken';
  perform public.external_catalog_worker('fail',jsonb_build_object('sourceId','ja-irodori','leaseToken',token));
  assert public.external_catalog_worker('read','{"sourceId":"ja-irodori"}')=remembered, 'failed course maintenance destroyed last good snapshot';
end $$;
reset role;
select 'external-catalog-sql-passed' as result;
