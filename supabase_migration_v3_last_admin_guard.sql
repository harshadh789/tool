-- Migration: v3_last_admin_guard
-- Description: Enforce NOT NULL on is_active and add a concurrency-safe guard to ensure at least one active ADMIN remains.
-- Relies on READ COMMITTED isolation level (PostgreSQL default) to see newly committed rows 
-- after acquiring the transaction-scoped advisory lock.

-- 1. Safely enforce NOT NULL on is_active
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE is_active IS NULL) THEN
    RAISE EXCEPTION 'Cannot enforce NOT NULL on is_active: existing records contain NULL values. Please update them manually first.';
  END IF;
END;
$$;

ALTER TABLE public.user_roles ALTER COLUMN is_active SET DEFAULT true;
ALTER TABLE public.user_roles ALTER COLUMN is_active SET NOT NULL;

-- 2. Concurrency-safe last-admin guard
CREATE OR REPLACE FUNCTION public.ensure_minimum_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  active_admin_count INT;
BEGIN
  -- We only care if an ACTIVE ADMIN is being modified or deleted.
  -- Use IS TRUE and IS DISTINCT FROM TRUE for robust NULL safety.
  
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.role = 'ADMIN' AND OLD.is_active IS TRUE) AND
       (NEW.role != 'ADMIN' OR NEW.is_active IS DISTINCT FROM TRUE OR NEW.user_id != OLD.user_id) THEN
       
       -- Acquire transaction-level advisory lock to serialize concurrent last-admin checks.
       -- The lock ID 123456789 is an arbitrary constant for "last admin check".
       -- This lock is automatically released at the end of the transaction.
       PERFORM pg_catalog.pg_advisory_xact_lock(123456789);
       
       -- Count the remaining active admins, excluding the one being modified.
       -- In a READ COMMITTED transaction (Postgres default), this query will see
       -- the committed state of any previously serialized transactions that held this lock.
       SELECT count(*) INTO active_admin_count
       FROM public.user_roles 
       WHERE role = 'ADMIN' AND is_active IS TRUE AND user_id != OLD.user_id;
       
       IF active_admin_count < 1 THEN
         RAISE EXCEPTION 'Concurrency block: Cannot demote, deactivate, or reassign the last active ADMIN';
       END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF (OLD.role = 'ADMIN' AND OLD.is_active IS TRUE) THEN
       
       PERFORM pg_catalog.pg_advisory_xact_lock(123456789);
       
       SELECT count(*) INTO active_admin_count
       FROM public.user_roles 
       WHERE role = 'ADMIN' AND is_active IS TRUE AND user_id != OLD.user_id;
       
       IF active_admin_count < 1 THEN
         RAISE EXCEPTION 'Concurrency block: Cannot delete the last active ADMIN';
       END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Secure the function against unauthorized execution
REVOKE ALL ON FUNCTION public.ensure_minimum_admin() FROM PUBLIC;

-- Drop trigger if exists to allow safe re-runs
DROP TRIGGER IF EXISTS trg_ensure_minimum_admin ON public.user_roles;

-- Create the trigger
CREATE TRIGGER trg_ensure_minimum_admin
BEFORE UPDATE OR DELETE ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.ensure_minimum_admin();
