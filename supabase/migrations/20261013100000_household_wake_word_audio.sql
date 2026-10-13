-- Private, cross-device household wake-word enrollment samples.
-- The authenticated member's JWT is checked by Supabase Storage RLS.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('household-wake-word-audio', 'household-wake-word-audio', false, 256000, ARRAY['audio/wav', 'audio/x-wav'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Household members read enrolled voice samples"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'household-wake-word-audio'
  AND EXISTS (
    SELECT 1 FROM public.household_members hm
    WHERE hm.household_id::text = split_part(name, '/', 1)
      AND hm.user_id = auth.uid()
  )
);

CREATE POLICY "Household members add voice samples"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'household-wake-word-audio'
  AND (storage.extension(name) = 'wav')
  AND EXISTS (
    SELECT 1 FROM public.household_members hm
    WHERE hm.household_id::text = split_part(name, '/', 1)
      AND hm.user_id = auth.uid()
  )
  AND (
    split_part(name, '/', 2) = 'unknown'
    OR EXISTS (
      SELECT 1 FROM public.wake_words w
      WHERE w.id::text = split_part(name, '/', 2)
        AND w.household_id::text = split_part(name, '/', 1)
    )
  )
);

CREATE POLICY "Household members remove voice samples"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'household-wake-word-audio'
  AND EXISTS (
    SELECT 1 FROM public.household_members hm
    WHERE hm.household_id::text = split_part(name, '/', 1)
      AND hm.user_id = auth.uid()
  )
);
