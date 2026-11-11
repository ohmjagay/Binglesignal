-- 012: one-time cleanup that makes the story pool ~4x smaller.
-- WHY: the ingest script used to store the same 384-number "meaning vector" inside every article of a story group AND in the
-- group's own column, with 15-digit precision. Every READ/WATCH load had to download all of it. New ingest runs no longer do this;
-- this file cleans the rows that already exist so you do not have to wait 7 days for them to expire.
-- SAFE: only removes duplicate copies and rounds numbers to 3 decimals. No story, headline or summary changes.
-- Safe to run more than once. Paste into Supabase -> SQL Editor -> New query -> Run.

-- 1) Remove the duplicate vector copy from inside each article of a group (keeps the article order).
update public.story_clusters
set stories = coalesce(
  (select jsonb_agg(story - 'embedding' order by position)
   from jsonb_array_elements(stories) with ordinality as item(story, position)),
  '[]'::jsonb)
where jsonb_typeof(stories) = 'array'
  and exists (select 1 from jsonb_array_elements(stories) as item(story) where (story -> 'embedding') is not null);

-- 2) Round each group's vector to 3 decimals (same meaning, a third of the size). Already-rounded rows are skipped.
update public.story_clusters
set embedding = (
  select jsonb_agg(round(value::numeric, 3) order by position)
  from jsonb_array_elements_text(embedding) with ordinality as item(value, position))
where embedding is not null
  and jsonb_typeof(embedding) = 'array'
  and length(embedding::text) > 4500;
