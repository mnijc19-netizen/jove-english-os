-- Bind a logical item/revision/analysis interval BEFORE a paid reservation.
-- Changing acquisition bytes or adapter versions must not make an uncertain
-- prior dispatch look like a brand-new chargeable request. Metadata only.
begin;
create table public.content_request_intents (
  item_id text not null references public.content_items(id) on delete cascade,
  revision text not null check (revision ~ '^[a-f0-9]{64}$'),
  purpose text not null check (purpose in ('content-stt','content-analysis')),
  scope text not null,
  request_id text not null unique,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  audio_sha256 text not null check (audio_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key(item_id,revision,purpose,scope),
  check ((purpose='content-stt' and scope='') or (purpose='content-analysis' and scope ~ '^authentic-[a-f0-9]{64}$')),
  check (request_id=(case when purpose='content-stt' then 'content-stt-' else 'content-a-' end)||fingerprint)
);
alter table public.content_request_intents enable row level security;
revoke all on public.content_request_intents from public,anon,authenticated;
grant all on public.content_request_intents to service_role;

create function public.content_request_intent(args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare src public.content_sources; item public.content_items; row_data public.content_request_intents;
  t timestamptz:=clock_timestamp(); run_key uuid;
begin
  if args is null or jsonb_typeof(args)<>'object' or octet_length(args::text)>2048 then
    raise exception 'Invalid request intent' using errcode='22023'; end if;
  run_key:=(args->>'runId')::uuid;
  select * into src from public.content_sources s where s.id=args->>'sourceId' for update;
  if not found or run_key is null or src.lease_id is distinct from run_key or src.lease_until<=t then
    raise exception 'Content lease lost' using errcode='40001'; end if;
  select * into item from public.content_items i where i.id=args->>'itemId' and i.source_id=src.id;
  if not found or item.revision is distinct from args->>'revision' then
    raise exception 'Stale content item' using errcode='40001'; end if;
  if args->>'purpose'='content-analysis' and not exists(select 1 from public.content_segments s
      where s.id=args->>'scope' and s.item_id=item.id and s.revision=item.revision) then
    raise exception 'Analysis scope mismatch' using errcode='22023'; end if;
  -- Old receipts have no logical intent binding. Do not guess their revision or
  -- interval and do not erase/settle them to enable a fresh provider dispatch.
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
