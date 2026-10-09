-- Phase 2D Staging Bootstrap Schema

-- 1. Create user_roles table (Resolves inconsistency: script previously assumed this existed)
CREATE TABLE IF NOT EXISTS public.user_roles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
    role VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure strict CHECK constraint for roles (repeat-safe)
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS valid_roles;
ALTER TABLE public.user_roles ADD CONSTRAINT valid_roles CHECK (role IN ('ADMIN', 'SALES', 'OPS'));

-- 2. Create itineraries table
CREATE TABLE IF NOT EXISTS public.itineraries (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    quote_id VARCHAR(50) UNIQUE NOT NULL,
    owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Draft',
    is_voucher_mode BOOLEAN DEFAULT FALSE,
    guest_name VARCHAR(255),
    title VARCHAR(255),
    start_date DATE,
    end_date DATE,
    guest_count INTEGER,
    total_amount NUMERIC(12, 2),
    currency VARCHAR(10),
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for searching quotes
CREATE INDEX IF NOT EXISTS idx_itineraries_quote_id ON public.itineraries(quote_id);
CREATE INDEX IF NOT EXISTS idx_itineraries_owner_id ON public.itineraries(owner_id);

-- 3. Create status_history table
CREATE TABLE IF NOT EXISTS public.status_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    itinerary_id UUID REFERENCES public.itineraries(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    old_status VARCHAR(50),
    new_status VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_history_itinerary ON public.status_history(itinerary_id);

-- 4. Create secure_share_links table
CREATE TABLE IF NOT EXISTS public.secure_share_links (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    itinerary_id UUID REFERENCES public.itineraries(id) ON DELETE CASCADE NOT NULL,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_secure_share_itinerary ON public.secure_share_links(itinerary_id);
CREATE INDEX IF NOT EXISTS idx_secure_share_token ON public.secure_share_links(token_hash);


-- Enable RLS
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itineraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secure_share_links ENABLE ROW LEVEL SECURITY;

-- Note: The API runs with a Secret key (Service Role) bypassing RLS, 
-- thus relying on programmatic backend checks.
-- RLS policies below serve as defense-in-depth against direct client access.

-- RLS for user_roles (defense-in-depth)
DROP POLICY IF EXISTS "Users can read own role" ON public.user_roles;
CREATE POLICY "Users can read own role" 
ON public.user_roles FOR SELECT 
USING (auth.uid() = user_id);

-- RLS for itineraries

-- ADMIN: All operations
DROP POLICY IF EXISTS "Admins can do everything on itineraries" ON public.itineraries;
CREATE POLICY "Admins can do everything on itineraries"
ON public.itineraries
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'ADMIN' AND is_active = true)
);

-- SALES: SELECT
DROP POLICY IF EXISTS "Sales can select all itineraries" ON public.itineraries;
CREATE POLICY "Sales can select all itineraries"
ON public.itineraries
FOR SELECT
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'SALES' AND is_active = true)
);

-- SALES: INSERT
DROP POLICY IF EXISTS "Sales can insert owned or unassigned itineraries" ON public.itineraries;
DROP POLICY IF EXISTS "Sales can insert owned itineraries" ON public.itineraries;
CREATE POLICY "Sales can insert owned itineraries"
ON public.itineraries
FOR INSERT
WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'SALES' AND is_active = true)
  AND owner_id = auth.uid()
);

-- SALES: UPDATE
DROP POLICY IF EXISTS "Sales can update owned or unassigned itineraries" ON public.itineraries;
DROP POLICY IF EXISTS "Sales can update owned itineraries" ON public.itineraries;
CREATE POLICY "Sales can update owned itineraries"
ON public.itineraries
FOR UPDATE
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'SALES' AND is_active = true)
  AND owner_id = auth.uid()
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'SALES' AND is_active = true)
  AND owner_id = auth.uid()
);

-- OPS: SELECT
DROP POLICY IF EXISTS "Ops can read all itineraries" ON public.itineraries;
CREATE POLICY "Ops can read all itineraries"
ON public.itineraries
FOR SELECT
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'OPS' AND is_active = true)
);

-- Clean up the old broad policy if it exists in the database
DROP POLICY IF EXISTS "Sales can read all, edit owned or unassigned itineraries" ON public.itineraries;
