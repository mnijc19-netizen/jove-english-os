-- Attempts include resumable waits for a provider or budget. A lifetime cap of
-- 1000 prevents checkpointing after repeated scheduled polls, even on recovery.
-- Keep the real count, its nonnegative invariant and the worker's six-attempt
-- ordinary retry/backoff policy. No data, grants, RLS or RPC behavior changes.
alter table public.content_items
  drop constraint content_items_attempts_check,
  add constraint content_items_attempts_check check (attempts >= 0);
