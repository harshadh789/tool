-- SQL PATCH: Secure Sales Ownership Policies
-- This script replaces the permissive "Sales can insert/update owned or unassigned itineraries" 
-- policies with strict policies that require the owner_id to explicitly match the authenticated user.
-- It applies ONLY to the public.itineraries table and ONLY to the SALES role.
-- Admin full-access, Sales SELECT, and Ops SELECT policies remain untouched.

-- 1. DROP the overly permissive policies if they exist.
DROP POLICY IF EXISTS "Sales can insert owned or unassigned itineraries" ON public.itineraries;
DROP POLICY IF EXISTS "Sales can update owned or unassigned itineraries" ON public.itineraries;

-- 2. CREATE the strict INSERT policy.
CREATE POLICY "Sales can insert owned itineraries"
ON public.itineraries
FOR INSERT
WITH CHECK (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'SALES' AND is_active = true)
  AND owner_id = auth.uid()
);

-- 3. CREATE the strict UPDATE policy.
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
