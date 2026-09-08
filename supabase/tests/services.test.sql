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
select 'PASS: daily/monthly budget, unknown-cost reservation, single dispatcher, idempotency, usage integrity, acoustic result write isolation';
