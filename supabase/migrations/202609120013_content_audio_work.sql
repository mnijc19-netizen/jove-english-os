-- Small resumable media batches must not starve a source at a fixed list position.
-- This is scheduling metadata, not learning evidence or a paid-dispatch receipt.
begin;
alter table public.content_sources add column last_audio_work_at timestamptz;
create function public.content_audio_work(action text,args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare src public.content_sources; item public.content_items; result jsonb; t timestamptz:=clock_timestamp();
begin
  if args is null or jsonb_typeof(args)<>'object' or octet_length(args::text)>2048 then
    raise exception 'Invalid audio work request' using errcode='22023'; end if;
  if action='order' then
    if jsonb_typeof(args->'sourceIds') is distinct from 'array' or jsonb_array_length(args->'sourceIds')>10 then
      raise exception 'Invalid audio work sources' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(args->'sourceIds') value
      where jsonb_typeof(value)<>'string' or value#>>'{}' !~ '^[a-z0-9-]{1,100}$') then
      raise exception 'Invalid audio work source' using errcode='22023'; end if;
    if (select count(distinct value) from jsonb_array_elements(args->'sourceIds') value)<>jsonb_array_length(args->'sourceIds') then
      raise exception 'Duplicate audio work source' using errcode='22023'; end if;
    select coalesce(jsonb_agg(q.id order by q.last_audio_work_at asc nulls first,q.ordinal),'[]') into result from (
      select requested.id,requested.ordinal,s.last_audio_work_at
      from jsonb_array_elements_text(args->'sourceIds') with ordinality requested(id,ordinal)
      left join public.content_sources s on s.id=requested.id
    ) q;
    return result;
  elsif action='begin' then
    select * into src from public.content_sources s where s.id=args->>'sourceId' for update;
    if not found or src.lease_id is distinct from (args->>'runId')::uuid or src.lease_id is null
      or src.lease_until is null or src.lease_until<=t then
      raise exception 'Content lease lost' using errcode='40001'; end if;
    select * into item from public.content_items i where i.id=args->>'itemId' and i.source_id=src.id;
    if not found or item.revision is distinct from args->>'revision' then
      raise exception 'Stale content item' using errcode='40001'; end if;
    update public.content_sources set last_audio_work_at=t where id=src.id;
    return '{}'::jsonb;
  end if;
  raise exception 'Invalid audio work action' using errcode='22023';
end;
$$;
revoke all on function public.content_audio_work(text,jsonb) from public,anon,authenticated;
grant execute on function public.content_audio_work(text,jsonb) to service_role;
commit;
