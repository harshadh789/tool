-- ==============================================================================
-- Migration: v4_status_history_atomic.sql
-- Description: Transaction-Atomic PostgreSQL RPC Functions for Itinerary Status Transitions
-- 
-- WHY RPC OVER TRIGGER:
-- 1. The backend application uses Supabase service-role credentials (SUPABASE_SECRET_KEY).
--    In service-role context, auth.uid() in PostgreSQL evaluates to NULL. A trigger
--    cannot reliably identify the actual human actor who initiated the change.
-- 2. By using a PostgreSQL RPC function, the verified actor UUID (p_user_id) from the
--    server's authentication middleware is passed explicitly into the transaction.
-- 3. The itinerary update and the status_history insertion happen within a single
--    PostgreSQL ACID transaction. If either operation fails, the entire transaction
--    aborts and rolls back automatically.
-- 4. Using the RPC as the single authoritative audit writer eliminates duplicate
--    records that would occur if both an application layer and a database trigger
--    attempted to log transitions.
--
-- SECURITY HARDENING:
-- - Both SECURITY DEFINER functions use `SET search_path = pg_catalog, pg_temp` to prevent
--   search-path hijacking attacks.
-- - All application tables (public.itineraries, public.status_history) are explicitly schema-qualified.
-- - Execute privileges are strictly revoked from PUBLIC, anon, and authenticated roles, and
--   granted exclusively to service_role so they can only be called from the verified server backend.
--
-- EXECUTION INSTRUCTIONS:
-- In Supabase Dashboard:
--   1. Log in to https://supabase.com and navigate to your project.
--   2. Click on "SQL Editor" in the left sidebar navigation.
--   3. Click "New query".
--   4. Paste the entire content of this file into the query editor.
--   5. Click "Run" (or press Ctrl+Enter / Cmd+Enter).
--   6. Verify that the functions compile successfully with "Success. No rows returned".
--
-- In psql command line (direct connection to DB pooler):
--   psql "$DATABASE_URL" -f supabase_migration_v4_status_history_atomic.sql
-- ==============================================================================

-- 1. Clean up any previous trigger attempt to prevent duplicate writes
DROP TRIGGER IF EXISTS trg_itinerary_status_history ON public.itineraries;
DROP FUNCTION IF EXISTS public.log_itinerary_status_transition();

-- 2. Create atomic update function for saveItinerary
CREATE OR REPLACE FUNCTION public.update_itinerary_status_atomic(
    p_quote_id VARCHAR(50),
    p_current_version INTEGER,
    p_user_id UUID,
    p_status VARCHAR(50),
    p_is_voucher_mode BOOLEAN,
    p_guest_name VARCHAR(255),
    p_title VARCHAR(255),
    p_start_date DATE,
    p_end_date DATE,
    p_guest_count INTEGER,
    p_total_amount NUMERIC(12, 2),
    p_currency VARCHAR(10),
    p_content JSONB
)
RETURNS public.itineraries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_existing public.itineraries%ROWTYPE;
    v_updated public.itineraries%ROWTYPE;
BEGIN
    -- Row-level lock to prevent concurrent races
    SELECT * INTO v_existing
    FROM public.itineraries
    WHERE quote_id = p_quote_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ITINERARY_NOT_FOUND: Quote ID % does not exist', p_quote_id;
    END IF;

    -- Optimistic concurrency check
    IF v_existing.version != p_current_version THEN
        RAISE EXCEPTION 'CONCURRENCY_CONFLICT: Version mismatch. Expected %, found %', p_current_version, v_existing.version;
    END IF;

    -- Update the itinerary record
    UPDATE public.itineraries
    SET
        status = p_status,
        is_voucher_mode = p_is_voucher_mode,
        guest_name = p_guest_name,
        title = p_title,
        start_date = p_start_date,
        end_date = p_end_date,
        guest_count = p_guest_count,
        total_amount = p_total_amount,
        currency = p_currency,
        content = p_content,
        version = v_existing.version + 1,
        updated_at = NOW()
    WHERE id = v_existing.id
    RETURNING * INTO v_updated;

    -- Single authoritative audit insert: ONLY when status genuinely changed
    IF v_existing.status IS DISTINCT FROM p_status THEN
        INSERT INTO public.status_history (
            itinerary_id,
            user_id,
            old_status,
            new_status,
            created_at
        ) VALUES (
            v_existing.id,
            p_user_id,
            v_existing.status,
            p_status,
            NOW()
        );
    END IF;

    RETURN v_updated;
END;
$$;

-- 3. Create atomic change_status function for quick status transitions
CREATE OR REPLACE FUNCTION public.change_itinerary_status_atomic(
    p_quote_id VARCHAR(50),
    p_current_version INTEGER,
    p_user_id UUID,
    p_new_status VARCHAR(50)
)
RETURNS public.itineraries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_existing public.itineraries%ROWTYPE;
    v_updated public.itineraries%ROWTYPE;
BEGIN
    SELECT * INTO v_existing
    FROM public.itineraries
    WHERE quote_id = p_quote_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ITINERARY_NOT_FOUND: Quote ID % does not exist', p_quote_id;
    END IF;

    -- Optimistic concurrency check: stale versions MUST always raise CONCURRENCY_CONFLICT
    IF v_existing.version != p_current_version THEN
        RAISE EXCEPTION 'CONCURRENCY_CONFLICT: Version mismatch. Expected %, found %', p_current_version, v_existing.version;
    END IF;

    -- Idempotent: If status is already unchanged with matching current version, return without incrementing version or logging
    IF v_existing.status = p_new_status THEN
        RETURN v_existing;
    END IF;

    -- Update status
    UPDATE public.itineraries
    SET
        status = p_new_status,
        version = v_existing.version + 1,
        updated_at = NOW()
    WHERE id = v_existing.id
    RETURNING * INTO v_updated;

    -- Log transition
    INSERT INTO public.status_history (
        itinerary_id,
        user_id,
        old_status,
        new_status,
        created_at
    ) VALUES (
        v_existing.id,
        p_user_id,
        v_existing.status,
        p_new_status,
        NOW()
    );

    RETURN v_updated;
END;
$$;

-- 4. Function permissions and access control: restrict exclusively to service_role
REVOKE ALL ON FUNCTION public.update_itinerary_status_atomic(VARCHAR, INTEGER, UUID, VARCHAR, BOOLEAN, VARCHAR, VARCHAR, DATE, DATE, INTEGER, NUMERIC, VARCHAR, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_itinerary_status_atomic(VARCHAR, INTEGER, UUID, VARCHAR, BOOLEAN, VARCHAR, VARCHAR, DATE, DATE, INTEGER, NUMERIC, VARCHAR, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.change_itinerary_status_atomic(VARCHAR, INTEGER, UUID, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_itinerary_status_atomic(VARCHAR, INTEGER, UUID, VARCHAR) TO service_role;
