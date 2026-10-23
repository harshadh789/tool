-- ====================================================================
-- Campfly Itinerary Tool - Migration v5: Secure Share Links Hardening
-- ====================================================================
-- Idempotent and repeat-safe.
-- Supports explicit revocation timestamp for public.secure_share_links.

-- 1. Ensure revoked_at column exists on secure_share_links
ALTER TABLE public.secure_share_links 
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- 2. Index for fast token_hash lookup
CREATE INDEX IF NOT EXISTS idx_secure_share_token_lookup 
    ON public.secure_share_links(token_hash);

-- 3. Index for searching links by itinerary
CREATE INDEX IF NOT EXISTS idx_secure_share_itinerary_id 
    ON public.secure_share_links(itinerary_id);

-- 4. Defense-in-depth RLS for secure_share_links
ALTER TABLE public.secure_share_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct public access to secure_share_links" ON public.secure_share_links;
CREATE POLICY "Deny direct public access to secure_share_links"
    ON public.secure_share_links
    FOR ALL
    TO anon, authenticated
    USING (false);
