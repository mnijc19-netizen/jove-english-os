-- Advisory read only: stop known-denied media work before paying storage/egress.
-- A true result never replaces reserve_service_call's serialized dispatch check.
create function public.service_budget_available(owner_id uuid, estimated_usd numeric)
returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare settings public.service_preferences; day_total numeric; month_total numeric;
begin
  if owner_id is null or not exists(select 1 from public.app_members m where m.user_id = owner_id) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if estimated_usd is null or estimated_usd <= 0 or estimated_usd > 1000 then
    raise exception 'Invalid estimate' using errcode='22023';
  end if;
  select * into settings from public.service_preferences p where p.user_id = owner_id;
  -- Do not implicitly create preferences or enable a default paid allowance.
  if not found then return false; end if;
  select
    coalesce(sum(coalesce(u.actual_usd,u.reserved_usd)) filter (
      where u.created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),0),
    coalesce(sum(coalesce(u.actual_usd,u.reserved_usd)),0)
    into day_total, month_total
    from public.service_usage u
    where u.user_id = owner_id
      and u.created_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  return day_total + estimated_usd <= settings.daily_budget_usd
     and month_total + estimated_usd <= settings.monthly_budget_usd;
end;
$$;
revoke all on function public.service_budget_available(uuid,numeric) from public,anon,authenticated;
grant execute on function public.service_budget_available(uuid,numeric) to service_role;
