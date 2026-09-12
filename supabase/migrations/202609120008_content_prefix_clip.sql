-- Forward-compatible clip container discriminator. Existing rows, hashes,
-- policies, grants and source acquisition identities are unchanged. This does
-- not activate prefix acquisition or permit partial artifacts in the old cache.
begin;
alter table public.content_segment_audio
  drop constraint content_segment_audio_timing_basis_check,
  add constraint content_segment_audio_timing_basis_check check (timing_basis in (
    'complete-container','mpeg-frame-count-with-preroll','pcm-sample-count','mpeg-frame-count-with-xing-v1')),
  add constraint content_segment_audio_xing_mime_check check (
    timing_basis <> 'mpeg-frame-count-with-xing-v1' or mime_type = 'audio/mpeg');
commit;
