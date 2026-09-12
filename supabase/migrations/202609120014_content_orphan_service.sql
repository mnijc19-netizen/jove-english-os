-- An interrupted pre-intent worker may have a service reservation but no
-- lease-fenced content_usage checkpoint. Its item cannot safely be guessed.
begin;
create function public.content_legacy_service_unmapped() returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(
    select 1 from public.service_usage u join public.app_members m on m.user_id=u.user_id
    where u.service='content'
      and not exists(select 1 from public.content_request_intents r
        where r.request_id=u.request_id and r.fingerprint=u.fingerprint)
      and not exists(select 1 from public.content_usage c
        where c.request_id=u.request_id and c.user_id=u.user_id and c.item_id is not null)
  );
$$;
revoke all on function public.content_legacy_service_unmapped() from public,anon,authenticated;
grant execute on function public.content_legacy_service_unmapped() to service_role;

create or replace function public.content_request_intent(args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare src public.content_sources; item public.content_items; row_data public.content_request_intents;
  t timestamptz:=clock_timestamp(); run_key uuid;
begin
  if args is null or jsonb_typeof(args)<>'object' or octet_length(args::text)>2048 then
    raise exception 'Invalid request intent' using errcode='22023'; end if;
  run_key:=(args->>'runId')::uuid;
  select * into src from public.content_sources s where s.id=args->>'sourceId' for update;
  if not found or run_key is null or src.lease_id is distinct from run_key or src.lease_until is null or src.lease_until<=t then
    raise exception 'Content lease lost' using errcode='40001'; end if;
  select * into item from public.content_items i where i.id=args->>'itemId' and i.source_id=src.id;
  if not found or item.revision is distinct from args->>'revision' then
    raise exception 'Stale content item' using errcode='40001'; end if;
  if args->>'purpose'='content-analysis' and not exists(select 1 from public.content_segments s
      where s.id=args->>'scope' and s.item_id=item.id and s.revision=item.revision) then
    raise exception 'Analysis scope mismatch' using errcode='22023'; end if;
  -- A missing item mapping blocks the active single-owner content boundary.
  -- Do not infer no charge from status or create a mapping to make it pass.
  if public.content_legacy_service_unmapped() then
    return jsonb_build_object('allowed',false,'reason','legacy-ledger-reconciliation-required'); end if;
  -- A trustworthy old item mapping permits other items, but does not establish
  -- the old revision/interval. Preserve the existing per-item legacy fence.
  if exists(select 1 from public.content_usage u where u.item_id=item.id
      and not exists(select 1 from public.content_request_intents r where r.request_id=u.request_id)) then
    return jsonb_build_object('allowed',false,'reason','legacy-reconciliation-required'); end if;
  insert into public.content_request_intents(item_id,revision,purpose,scope,request_id,fingerprint,audio_sha256)
    values(item.id,item.revision,args->>'purpose',args->>'scope',args->>'requestId',args->>'fingerprint',args->>'audioSha256')
    on conflict(item_id,revision,purpose,scope) do nothing;
  select * into row_data from public.content_request_intents r where r.item_id=item.id and r.revision=item.revision
    and r.purpose=args->>'purpose' and r.scope=args->>'scope';
  return jsonb_build_object('allowed',row_data.request_id=args->>'requestId' and row_data.fingerprint=args->>'fingerprint'
    and row_data.audio_sha256=args->>'audioSha256');
end;
$$;
revoke all on function public.content_request_intent(jsonb) from public,anon,authenticated;
grant execute on function public.content_request_intent(jsonb) to service_role;
commit;
