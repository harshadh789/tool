-- ==============================================================================
-- Campfly Phase 3B.1 - Migration v6: Payments & Bank Reconciliation
-- ==============================================================================
-- Idempotent and repeat-safe migration.
-- Creates tables for storing structured payments, MDR processing fee estimates,
-- net settlements, and bank statement reconciliation audit trails.
-- ==============================================================================

-- 1. Create public.payments table
CREATE TABLE IF NOT EXISTS public.payments (
    id VARCHAR(100) PRIMARY KEY,
    quotation_id VARCHAR(50),
    booking_id VARCHAR(50),
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    transaction_type VARCHAR(30) NOT NULL CHECK (transaction_type IN ('customer_receipt', 'supplier_payment', 'customer_refund', 'processing_fee', 'business_expense')),
    payment_method VARCHAR(30) NOT NULL,
    provider VARCHAR(100) NOT NULL DEFAULT 'IDFC First Bank',
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(10) NOT NULL DEFAULT 'INR',
    transaction_reference VARCHAR(100),
    narration VARCHAR(255) NOT NULL,
    customer_name VARCHAR(255),
    supplier_name VARCHAR(255),
    payment_purpose VARCHAR(100),
    destination VARCHAR(255),
    transaction_date DATE NOT NULL,
    estimated_fee NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    actual_fee NUMERIC(10, 2) DEFAULT NULL,
    is_fee_verified BOOLEAN NOT NULL DEFAULT FALSE,
    net_settlement_amount NUMERIC(12, 2) NOT NULL,
    reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'Unmatched' CHECK (reconciliation_status IN ('Unmatched', 'Matched', 'Reconciled', 'Mismatched')),
    statement_reference VARCHAR(100),
    statement_amount NUMERIC(12, 2),
    statement_date DATE,
    reconciliation_notes TEXT,
    reconciled_by UUID,
    reconciled_at TIMESTAMP WITH TIME ZONE,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Create public.payment_reconciliation_audit table
CREATE TABLE IF NOT EXISTS public.payment_reconciliation_audit (
    id VARCHAR(100) PRIMARY KEY,
    payment_id VARCHAR(100) NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    actor_id UUID,
    statement_reference VARCHAR(100),
    discrepancy_amount NUMERIC(12, 2) DEFAULT 0.00,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure ON DELETE RESTRICT is applied if table previously existed with CASCADE
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'payment_reconciliation_audit_payment_id_fkey'
          AND table_name = 'payment_reconciliation_audit'
    ) THEN
        ALTER TABLE public.payment_reconciliation_audit
            DROP CONSTRAINT payment_reconciliation_audit_payment_id_fkey,
            ADD CONSTRAINT payment_reconciliation_audit_payment_id_fkey
                FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;
    END IF;
END $$;

-- 3. Indexes for fast lookups and duplicate detection
CREATE INDEX IF NOT EXISTS idx_payments_quote_id ON public.payments(quotation_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON public.payments(transaction_reference);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_payments_date ON public.payments(transaction_date);
CREATE INDEX IF NOT EXISTS idx_payments_audit_payment_id ON public.payment_reconciliation_audit(payment_id);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_reconciliation_audit ENABLE ROW LEVEL SECURITY;

-- 5. Defense-in-depth deny policy for direct public / anon access
DROP POLICY IF EXISTS "Deny direct public access to payments" ON public.payments;
CREATE POLICY "Deny direct public access to payments"
    ON public.payments
    FOR ALL
    TO anon, authenticated
    USING (false);

DROP POLICY IF EXISTS "Deny direct public access to payment_reconciliation_audit" ON public.payment_reconciliation_audit;
CREATE POLICY "Deny direct public access to payment_reconciliation_audit"
    ON public.payment_reconciliation_audit
    FOR ALL
    TO anon, authenticated
    USING (false);

-- 6. Table permissions and access control: restrict exclusively to service_role
REVOKE ALL ON public.payments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.payments TO service_role;

REVOKE ALL ON public.payment_reconciliation_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.payment_reconciliation_audit TO service_role;

-- 7. Transaction-Atomic PostgreSQL RPC Function for Payment Reconciliation
-- Updates payment record and creates reconciliation audit entry in a single transaction
CREATE OR REPLACE FUNCTION public.reconcile_payment_atomic(
    p_payment_id VARCHAR(100),
    p_statement_reference VARCHAR(100),
    p_statement_amount NUMERIC(12, 2),
    p_statement_date DATE,
    p_actual_fee NUMERIC(10, 2),
    p_reconciliation_notes TEXT,
    p_user_id UUID,
    p_audit_id VARCHAR(100)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_payment public.payments%ROWTYPE;
    v_previous_status VARCHAR(20);
    v_new_status VARCHAR(20);
    v_verified_actual_fee NUMERIC(10, 2);
    v_expected_settlement NUMERIC(12, 2);
    v_discrepancy NUMERIC(12, 2);
    v_is_match BOOLEAN;
    v_audit public.payment_reconciliation_audit%ROWTYPE;
BEGIN
    -- 1. Lock payment row FOR UPDATE
    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = p_payment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PAYMENT_NOT_FOUND: Payment % not found', p_payment_id;
    END IF;

    v_previous_status := v_payment.reconciliation_status;

    -- 2. Determine actual fee: use parameter if provided, otherwise existing
    IF p_actual_fee IS NOT NULL THEN
        v_verified_actual_fee := p_actual_fee;
    ELSE
        v_verified_actual_fee := COALESCE(v_payment.actual_fee, 0.00);
    END IF;

    -- 3. Calculate expected net settlement
    -- Inbound (customer receipt): net = amount - actual_fee
    -- Outbound (supplier payment / refund): net = amount + actual_fee
    IF v_payment.direction = 'inbound' THEN
        v_expected_settlement := ROUND((v_payment.amount - v_verified_actual_fee), 2);
    ELSE
        v_expected_settlement := ROUND((v_payment.amount + v_verified_actual_fee), 2);
    END IF;

    -- 4. Calculate discrepancy with 0.05 rounding tolerance
    v_discrepancy := ROUND(ABS(v_expected_settlement - p_statement_amount), 2);
    v_is_match := (v_discrepancy <= 0.05);

    IF v_is_match THEN
        v_new_status := 'Reconciled';
    ELSE
        v_new_status := 'Mismatched';
    END IF;

    -- 5. Update payments record
    UPDATE public.payments
    SET
        statement_reference = p_statement_reference,
        statement_amount = p_statement_amount,
        statement_date = COALESCE(p_statement_date, CURRENT_DATE),
        actual_fee = v_verified_actual_fee,
        net_settlement_amount = v_expected_settlement,
        is_fee_verified = TRUE,
        reconciliation_status = v_new_status,
        reconciliation_notes = p_reconciliation_notes,
        reconciled_by = p_user_id,
        reconciled_at = NOW(),
        updated_at = NOW()
    WHERE id = p_payment_id
    RETURNING * INTO v_payment;

    -- 6. Insert audit trail record in the same database transaction
    INSERT INTO public.payment_reconciliation_audit (
        id,
        payment_id,
        previous_status,
        new_status,
        actor_id,
        statement_reference,
        discrepancy_amount,
        notes,
        created_at
    ) VALUES (
        p_audit_id,
        p_payment_id,
        v_previous_status,
        v_new_status,
        p_user_id,
        p_statement_reference,
        v_discrepancy,
        p_reconciliation_notes,
        NOW()
    )
    RETURNING * INTO v_audit;

    -- 7. Return complete atomic result
    RETURN jsonb_build_object(
        'payment', to_jsonb(v_payment),
        'audit', to_jsonb(v_audit),
        'isMatch', v_is_match,
        'discrepancy', v_discrepancy
    );
END;
$$;

-- 8. Restrict atomic reconciliation RPC function exclusively to service_role
REVOKE ALL ON FUNCTION public.reconcile_payment_atomic(VARCHAR, VARCHAR, NUMERIC, DATE, NUMERIC, TEXT, UUID, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_payment_atomic(VARCHAR, VARCHAR, NUMERIC, DATE, NUMERIC, TEXT, UUID, VARCHAR) TO service_role;
