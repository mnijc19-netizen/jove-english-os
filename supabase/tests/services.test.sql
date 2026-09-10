-- Run inside a transaction on dedicated local Jove; caller must roll back.
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000101','jove-budget-fixture@example.invalid');
insert into public.app_members(user_id) values ('00000000-0000-4000-8000-000000000101');
do $$
declare first public.service_usage; retry public.service_usage;
  owner uuid := '00000000-0000-4000-8000-000000000101';
  claim1 uuid := '00000000-0000-4000-8000-000000000201';
  claim2 uuid := '00000000-0000-4000-8000-000000000202';
begin
  first := public.reserve_service_call(owner,'first',repeat('a',64),'llm',0.6,claim1);
  retry := public.reserve_service_call(owner,'first',repeat('a',64),'llm',0.6,claim2);
  if first.id is null or first.id is distinct from retry.id or retry.dispatch_nonce is distinct from claim1 then raise exception 'Duplicate dispatch was not excluded'; end if;
  begin
    perform public.reserve_service_call(owner,'first',repeat('b',64),'llm',0.6,claim2);
    raise exception 'Changed request reused reserved identity';
  exception when unique_violation then null; end;
  begin
    perform public.reserve_service_call(owner,'over-budget',repeat('b',64),'llm',0.5,claim2);
    raise exception 'Daily budget was bypassed' using errcode='22023';
  exception when raise_exception then
    if sqlerrm <> 'Practice budget reached' then raise; end if;
  end;
  update public.service_usage set actual_usd=0.1,status='completed' where id=first.id;
  perform public.reserve_service_call(owner,'second',repeat('b',64),'pronunciation',0.5,claim2);
  update public.service_preferences set daily_budget_usd=10,monthly_budget_usd=0.65 where user_id=owner;
  begin
    perform public.reserve_service_call(owner,'over-month',repeat('c',64),'llm',0.1,claim2);
    raise exception 'Monthly budget was bypassed' using errcode='22023';
  exception when raise_exception then
    if sqlerrm <> 'Practice budget reached' then raise; end if;
  end;
  if (select count(*) from public.service_usage where user_id=owner) <> 2 then raise exception 'Rejected calls changed usage'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000101',true);
do $$ begin
  if (select count(*) from public.service_usage) <> 2 then raise exception 'Owner usage unavailable'; end if;
  if (public.account_service_summary()->'today'->>'requests')::int is distinct from 2
    or (public.account_service_summary()->'month'->>'reportedUsd')::numeric is distinct from 0.1
    or (public.account_service_summary()->'month'->>'heldUsd')::numeric is distinct from 0.5
    or (public.account_service_summary()->'month'->>'unknownCount')::int is distinct from 1 then
    raise exception 'Known/held account costs were conflated';
  end if;
  begin
    update public.service_usage set actual_usd=0;
    raise exception 'Client rewrote usage';
  exception when insufficient_privilege then null; end;
  begin
    perform public.reserve_service_call('00000000-0000-4000-8000-000000000101','client',repeat('a',64),'llm',0,
      '00000000-0000-4000-8000-000000000201');
    raise exception 'Client could reserve direct paid calls';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.acoustic_assessments(user_id,attempt_id,recording_id,reference_id,result)
      values ('00000000-0000-4000-8000-000000000101','fake','fake','fake','{}');
    raise exception 'Client could manufacture provider acoustic evidence';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000999',true);
do $$ begin
  begin
    perform public.account_service_summary();
    raise exception 'Nonmember could access account summary';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Advisory preflight must share reservation arithmetic without reserving or
-- resetting anything. These owners and all usage are transactional fixtures.
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000102','jove-budget-empty-fixture@example.invalid');
insert into public.app_members(user_id) values ('00000000-0000-4000-8000-000000000102');
do $$
declare owner uuid := '00000000-0000-4000-8000-000000000101'; value numeric;
begin
  if public.service_budget_available(owner,0.05) is distinct from true
    or public.service_budget_available(owner,0.05000001) is distinct from false then
    raise exception 'Preflight ignored reported/held costs or exact monthly boundary';
  end if;
  update public.service_preferences set daily_budget_usd=0.65,monthly_budget_usd=10 where user_id=owner;
  if public.service_budget_available(owner,0.05) is distinct from true
    or public.service_budget_available(owner,0.05000001) is distinct from false then
    raise exception 'Preflight ignored daily boundary';
  end if;
  update public.service_preferences set daily_budget_usd=0 where user_id=owner;
  if public.service_budget_available(owner,0.01) is distinct from false then raise exception 'Paused day allowed media'; end if;
  update public.service_preferences set daily_budget_usd=10,monthly_budget_usd=0 where user_id=owner;
  if public.service_budget_available(owner,0.01) is distinct from false then raise exception 'Paused month allowed media'; end if;
  update public.service_preferences set daily_budget_usd=10,monthly_budget_usd=0.65 where user_id=owner;
  if public.service_budget_available('00000000-0000-4000-8000-000000000102',0.01) is distinct from false
    or exists(select 1 from public.service_preferences where user_id='00000000-0000-4000-8000-000000000102') then
    raise exception 'Preflight implicitly enabled unconfigured spending';
  end if;
  foreach value in array array[null::numeric,0,-1,'NaN'::numeric,'Infinity'::numeric,1001] loop
    begin
      perform public.service_budget_available(owner,value);
      raise exception 'Invalid estimate accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  begin
    perform public.service_budget_available('00000000-0000-4000-8000-000000000999',0.01);
    raise exception 'Nonmember preflight accepted';
  exception when insufficient_privilege then null; end;
  if (select count(*) from public.service_usage where user_id=owner) is distinct from 2::bigint then
    raise exception 'Read-only preflight changed usage';
  end if;
  insert into public.service_usage(user_id,request_id,fingerprint,dispatch_nonce,service,status,reserved_usd,created_at)
    values(owner,'prior-month',repeat('d',64),gen_random_uuid(),'content','uncertain',100,
      (date_trunc('month',now() at time zone 'UTC') at time zone 'UTC') - interval '1 second'),
      ('00000000-0000-4000-8000-000000000102','other-owner',repeat('e',64),gen_random_uuid(),'content','uncertain',100,now());
  if public.service_budget_available(owner,0.05) is distinct from true then raise exception 'Preflight mixed owner or UTC month'; end if;
  if has_function_privilege('anon','public.service_budget_available(uuid,numeric)','execute')
    or has_function_privilege('authenticated','public.service_budget_available(uuid,numeric)','execute')
    or not has_function_privilege('service_role','public.service_budget_available(uuid,numeric)','execute')
    or (select prosecdef from pg_proc where oid='public.service_budget_available(uuid,numeric)'::regprocedure) then
    raise exception 'Budget preflight privileges are not least privilege';
  end if;
end $$;
set local role service_role;
do $$ begin
  if public.service_budget_available('00000000-0000-4000-8000-000000000101',0.05) is distinct from true then
    raise exception 'Authenticated server cannot check preflight';
  end if;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform public.service_budget_available('00000000-0000-4000-8000-000000000101',0.05);
    raise exception 'Anonymous preflight access';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin
    perform public.service_budget_available('00000000-0000-4000-8000-000000000101',0.05);
    raise exception 'Browser preflight access';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS: daily/monthly budget, unknown-cost reservation, read-only media preflight, single dispatcher, idempotency, usage integrity, acoustic result write isolation';
