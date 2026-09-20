-- Dedicated local transactional fixtures only. No physical Storage objects.
begin;
insert into auth.users(id,email) values
  ('00000000-0000-4000-8000-000000000081','capacity-a@example.invalid');
insert into public.app_members(user_id) values ('00000000-0000-4000-8000-000000000081');
-- Existing unrelated local fixtures, if any, remain inside the calculation.
update public.recording_storage_limits set limit_bytes = public.recording_capacity_used('') + 100;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000081',true);
do $$
declare root text := '00000000-0000-4000-8000-000000000081/';
begin
  if not public.reserve_recording_upload(root || 'english',60) then raise exception 'First reservation denied'; end if;
  if public.reserve_recording_upload(root || 'ja/japanese',60) then raise exception 'Cross-language overbooking'; end if;
  if not public.reserve_recording_upload(root || 'english',60) then raise exception 'Retry counted twice'; end if;
  begin
    perform public.reserve_recording_upload(root || 'english',61);
    raise exception 'Reservation bytes mutated';
  exception when unique_violation then null; end;
  if public.admit_recording_object(root || 'english','{}') then raise exception 'Unknown size trusted a small reservation'; end if;
  if public.admit_recording_object(root || 'english','{"size":"bad"}') then raise exception 'Invalid size passed'; end if;
  if public.admit_recording_object(root || 'english','{"size":-1}') then raise exception 'Negative size passed'; end if;
  if public.admit_recording_object(root || 'english','{"size":61}') then raise exception 'Upload larger than reservation'; end if;
  -- A legacy client can insert known-size audio under the same allowance.
  insert into storage.objects(bucket_id,name,owner,metadata) values
    ('jove-recordings',root || 'ja/legacy',auth.uid(),'{"size":40}');
  insert into storage.objects(bucket_id,name,owner,metadata) values
    ('jove-recordings',root || 'english',auth.uid(),'{"size":60}');
  if public.reserve_recording_upload(root || 'overflow',1) then raise exception 'Unconfirmed objects not counted'; end if;
  if not public.reserve_recording_upload(root || 'english',60) then raise exception 'Unconfirmed original not recoverable'; end if;
  begin
    insert into storage.objects(bucket_id,name,owner,metadata) values
      ('jove-recordings',root || 'bypass',auth.uid(),'{"size":1}');
    raise exception 'Direct Storage bypass';
  exception when insufficient_privilege then null;
    when raise_exception then
      if sqlerrm <> 'Shared cloud recording storage is full' then raise; end if;
  end;
  update storage.objects set metadata='{"size":1}' where bucket_id='jove-recordings' and name=root || 'english';
  if exists(select 1 from storage.objects where name=root || 'english' and metadata->>'size' <> '60') then
    raise exception 'Original overwrite policy still present'; end if;
  begin
    update public.recording_storage_limits set limit_bytes=1073741824;
    raise exception 'Client changed cloud limit';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.recording_upload_reservations;
    raise exception 'Client erased reservations';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Expiration frees only the reservation, never a materialized object.
update public.recording_storage_limits set limit_bytes = public.recording_capacity_used('') + 100;
insert into public.recording_upload_reservations values
  ('00000000-0000-4000-8000-000000000081/late','00000000-0000-4000-8000-000000000081',60,now()-interval '1 second');
set local role authenticated;
do $$
declare root text := '00000000-0000-4000-8000-000000000081/';
begin
  if not public.reserve_recording_upload(root || 'other-device',100) then raise exception 'Expired reservation not released'; end if;
  if public.admit_recording_object(root || 'late','{"size":60}') then raise exception 'Late upload bypassed current allowance'; end if;
  if public.reserve_recording_upload(root || 'late',60) then raise exception 'Expired reservation renewed without capacity'; end if;
end $$;
reset role;
-- Existing originals remain confirmable even if the operator lowers the limit.
update public.recording_storage_limits set limit_bytes=1;
set local role authenticated;
do $$ begin
  if not public.reserve_recording_upload('00000000-0000-4000-8000-000000000081/english',60) then
    raise exception 'Existing original recovery blocked by full bucket'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000082',true);
do $$ begin
  begin
    perform public.reserve_recording_upload('00000000-0000-4000-8000-000000000082/foreign',1);
    raise exception 'Nonmember reserved capacity';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
