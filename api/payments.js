// ==============================================================================
// Campfly Phase 3B.1 - Payment Description & Bank Reconciliation System
// ==============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { estimateProcessingFee, calculateNetSettlement } = require('./mdr_accounting.js');

const DATA_DIR = path.join(__dirname, '../data');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const AUDIT_FILE = path.join(DATA_DIR, 'payment_reconciliation_audit.json');

/**
 * Determines whether local JSON fallback is permitted.
 * STRICT SAFETY INVARIANTS:
 * 1. NEVER permitted on Vercel (Production or Preview: VERCEL or VERCEL_ENV set).
 * 2. NEVER permitted when NODE_ENV === 'production'.
 * 3. Permitted ONLY in explicitly enabled local-development (ENABLE_LOCAL_PAYMENTS_STORAGE === 'true')
 *    or during local automated testing (NODE_ENV === 'test' or global.__TEST_ALLOW_LOCAL_PAYMENTS__).
 */
function isLocalFallbackPermitted() {
  if (process.env.VERCEL || process.env.VERCEL_ENV) return false;
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.ENABLE_LOCAL_PAYMENTS_STORAGE === 'true') return true;
  if (process.env.NODE_ENV === 'test' || global.__TEST_ALLOW_LOCAL_PAYMENTS__) return true;
  return false;
}

/**
 * Detect missing database table / migration error (Postgres 42P01 or relation does not exist)
 */
function isMissingTableError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = err.code || '';
  return code === '42P01' || msg.includes('does not exist') || msg.includes('relation "payments"') || msg.includes('relation "payment_reconciliation_audit"');
}

// In-memory fallback stores (used only when isLocalFallbackPermitted() is true)
let localPayments = [];
let localAudit = [];

function loadLocalData() {
  if (!isLocalFallbackPermitted()) {
    localPayments = [];
    localAudit = [];
    return;
  }
  if (fs.existsSync(PAYMENTS_FILE)) {
    try {
      localPayments = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
    } catch(e) {
      localPayments = [];
    }
  }
  if (fs.existsSync(AUDIT_FILE)) {
    try {
      localAudit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    } catch(e) {
      localAudit = [];
    }
  }
}

function saveLocalData() {
  if (!isLocalFallbackPermitted()) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(localPayments, null, 2), 'utf8');
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(localAudit, null, 2), 'utf8');
  } catch(e) {
    console.error('Error saving local payments data:', e);
  }
}

loadLocalData();

/**
 * Generate standard, human-readable payment description / narration
 * Format standard examples:
 * - Customer receipt: Receipt | CMP-2026-772956 | Arham Fahmi | Advance | Bali Package
 * - Supplier payment: Hotel Advance | CMP-2026-772956 | Kuwarasan A Pramana | Bali
 * - Customer refund: Refund | CMP-2026-772956 | Arham Fahmi
 * - Processing fee: Payment Fee | CMP-2026-772956 | Payment Provider
 */
function generatePaymentNarration({
  transactionType = 'customer_receipt',
  quotationId = '',
  customerName = '',
  supplierName = '',
  purpose = 'Payment',
  destination = '',
  provider = ''
}) {
  const quote = (quotationId || 'GENERAL').trim();
  const dest = (destination || '').trim();

  switch (transactionType) {
    case 'customer_receipt': {
      const cust = (customerName || 'Guest').trim();
      const purp = (purpose || 'Payment').trim();
      return dest
        ? `Receipt | ${quote} | ${cust} | ${purp} | ${dest}`
        : `Receipt | ${quote} | ${cust} | ${purp}`;
    }
    case 'supplier_payment': {
      const supp = (supplierName || 'Supplier').trim();
      const purp = (purpose || 'Supplier Payment').trim();
      return dest
        ? `${purp} | ${quote} | ${supp} | ${dest}`
        : `${purp} | ${quote} | ${supp}`;
    }
    case 'customer_refund': {
      const cust = (customerName || 'Guest').trim();
      return `Refund | ${quote} | ${cust}`;
    }
    case 'processing_fee': {
      const prov = (provider || 'Payment Provider').trim();
      return `Payment Fee | ${quote} | ${prov}`;
    }
    case 'business_expense': {
      const name = (supplierName || provider || 'Expense').trim();
      return `Expense | ${quote} | ${name} | ${purpose || 'General'}`;
    }
    default:
      return `Transaction | ${quote} | ${customerName || supplierName || 'Campfly'}`;
  }
}

/**
 * Validate narration: required, human readable, max 255 chars, no passwords/credentials
 */
function validateNarration(narration) {
  if (!narration || typeof narration !== 'string' || !narration.trim()) {
    throw new Error('Payment description / narration is required.');
  }
  const clean = narration.trim();
  if (clean.length > 255) {
    throw new Error('Payment narration exceeds 255 character limit.');
  }
  // Prevent credential leakage into bank narrations
  const credentialPatterns = /(password|passwd|secret_key|api_key|bearer\s+[a-z0-9]|cvv|cvc|pin\b)/i;
  if (credentialPatterns.test(clean)) {
    throw new Error('Security violation: Payment narration must not contain passwords, CVVs, or sensitive credentials.');
  }
  return clean;
}

/**
 * Record a new payment transaction with structured fields and automatic narration
 */
async function recordPayment(paymentData, user, supabaseAdmin = null) {
  const {
    quotation_id,
    booking_id = null,
    direction = 'inbound',
    transaction_type = 'customer_receipt',
    payment_method = 'upi',
    provider = 'IDFC First Bank',
    amount,
    currency = 'INR',
    transaction_reference = '',
    narration,
    customer_name = '',
    supplier_name = '',
    payment_purpose = 'Advance',
    destination = '',
    transaction_date = new Date().toISOString().split('T')[0],
    actual_fee = null,
    reconciliation_notes = ''
  } = paymentData;

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('Payment amount must be a positive number.');
  }

  if (!['inbound', 'outbound'].includes(direction)) {
    throw new Error("Payment direction must be either 'inbound' or 'outbound'.");
  }

  const validTypes = ['customer_receipt', 'supplier_payment', 'customer_refund', 'processing_fee', 'business_expense'];
  if (!validTypes.includes(transaction_type)) {
    throw new Error(`Invalid transaction type: ${transaction_type}`);
  }

  // Generate or validate narration
  let finalNarration = narration;
  if (!finalNarration || !finalNarration.trim()) {
    finalNarration = generatePaymentNarration({
      transactionType: transaction_type,
      quotationId: quotation_id,
      customerName: customer_name,
      supplierName: supplier_name,
      purpose: payment_purpose,
      destination: destination,
      provider: provider
    });
  }
  finalNarration = validateNarration(finalNarration);

  // Calculate fee estimates
  const feeEstimation = estimateProcessingFee({
    amount: numAmount,
    paymentMethod: payment_method,
    provider: provider,
    transactionDate: transaction_date
  });

  const estimatedFee = feeEstimation.estimated_fee;
  const verifiedActualFee = actual_fee != null ? (parseFloat(actual_fee) || 0) : null;
  const effectiveFee = verifiedActualFee !== null ? verifiedActualFee : estimatedFee;

  const netSettlementAmount = calculateNetSettlement(numAmount, effectiveFee, direction);

  const paymentRecord = {
    id: `PAY-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    quotation_id: quotation_id ? quotation_id.trim() : null,
    booking_id: booking_id ? booking_id.trim() : null,
    direction,
    transaction_type,
    payment_method: payment_method.toLowerCase().trim(),
    provider: provider.trim(),
    amount: Math.round(numAmount * 100) / 100,
    currency: (currency || 'INR').toUpperCase(),
    transaction_reference: (transaction_reference || '').trim(),
    narration: finalNarration,
    customer_name: (customer_name || '').trim(),
    supplier_name: (supplier_name || '').trim(),
    payment_purpose: (payment_purpose || 'Payment').trim(),
    destination: (destination || '').trim(),
    transaction_date,
    estimated_fee: estimatedFee,
    actual_fee: verifiedActualFee,
    net_settlement_amount: netSettlementAmount,
    is_fee_verified: verifiedActualFee !== null,
    reconciliation_status: 'Unmatched',
    statement_reference: null,
    statement_amount: null,
    statement_date: null,
    reconciliation_notes: (reconciliation_notes || '').trim(),
    reconciled_by: null,
    reconciled_at: null,
    created_by: user ? user.id : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // Attempt Supabase insert if client configured
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin
        .from('payments')
        .insert([paymentRecord])
        .select()
        .single();
      
      if (!error && data) {
        return data;
      }
      
      if (!isLocalFallbackPermitted()) {
        const isMissingTable = isMissingTableError(error);
        const errMsg = isMissingTable
          ? 'Payment storage unavailable: Required database migration (v6_payments_and_reconciliation) is not installed. Payment recording is temporarily unavailable until the migration is applied.'
          : `Payment storage unavailable: Durable database write failed (${error ? error.message : 'Unknown error'}). Payment recording is temporarily unavailable.`;
        const storageErr = new Error(errMsg);
        storageErr.status = 503;
        storageErr.code = isMissingTable ? 'MIGRATION_MISSING' : 'STORAGE_UNAVAILABLE';
        throw storageErr;
      }
      console.warn('Supabase payments insert error, falling back to local storage in test/dev mode:', error ? error.message : 'Unknown');
    } catch(err) {
      if (!isLocalFallbackPermitted()) {
        if (err.status === 503) throw err;
        const isMissingTable = isMissingTableError(err);
        const errMsg = isMissingTable
          ? 'Payment storage unavailable: Required database migration (v6_payments_and_reconciliation) is not installed. Payment recording is temporarily unavailable until the migration is applied.'
          : `Payment storage unavailable: Durable database write failed (${err.message}). Payment recording is temporarily unavailable.`;
        const storageErr = new Error(errMsg);
        storageErr.status = 503;
        storageErr.code = isMissingTable ? 'MIGRATION_MISSING' : 'STORAGE_UNAVAILABLE';
        throw storageErr;
      }
      console.warn('Supabase exception, falling back to local storage in test/dev mode:', err.message);
    }
  }

  if (!isLocalFallbackPermitted()) {
    const storageErr = new Error('Payment storage unavailable: Durable database storage is required in deployed environments, but Supabase client is not configured. Payment recording is temporarily unavailable.');
    storageErr.status = 503;
    storageErr.code = 'STORAGE_UNAVAILABLE';
    throw storageErr;
  }

  // Local storage fallback (strictly guarded: only permitted in local dev or automated test)
  localPayments.unshift(paymentRecord);
  saveLocalData();
  return paymentRecord;
}

/**
 * Reconcile a payment against bank statement or provider settlement report
 * Transition: Unmatched -> Matched -> Reconciled (or Mismatched)
 */
async function reconcilePayment({
  paymentId,
  statementReference,
  statementAmount,
  statementDate,
  actualFee = null,
  reconciliationNotes = '',
  user,
  supabaseAdmin = null
}) {
  if (!statementReference || !statementReference.trim()) {
    throw new Error('Bank statement or settlement reference (UTR / Entry ID) is required for reconciliation.');
  }

  const numStatementAmount = parseFloat(statementAmount);
  if (isNaN(numStatementAmount) || numStatementAmount <= 0) {
    throw new Error('Valid statement amount from bank statement is required.');
  }

  const auditId = `AUDIT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const numActualFee = actualFee != null ? (parseFloat(actualFee) || 0) : null;

  // Authoritative Deployed Transactional Path: Call PostgreSQL atomic RPC function
  if (supabaseAdmin) {
    try {
      if (typeof supabaseAdmin.rpc === 'function') {
        const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('reconcile_payment_atomic', {
          p_payment_id: paymentId,
          p_statement_reference: statementReference.trim(),
          p_statement_amount: numStatementAmount,
          p_statement_date: statementDate || new Date().toISOString().split('T')[0],
          p_actual_fee: numActualFee,
          p_reconciliation_notes: (reconciliationNotes || '').trim(),
          p_user_id: user ? user.id : null,
          p_audit_id: auditId
        });

        if (!rpcError && rpcData) {
          return {
            payment: rpcData.payment,
            audit: rpcData.audit,
            isMatch: rpcData.isMatch,
            discrepancy: rpcData.discrepancy
          };
        }

        if (rpcError) {
          if (rpcError.message && rpcError.message.includes('PAYMENT_NOT_FOUND')) {
            const notFoundErr = new Error(`Payment record not found: ${paymentId}`);
            notFoundErr.status = 404;
            throw notFoundErr;
          }

          const isMissingRpcOrTable = rpcError.code === 'PGRST202' ||
            (rpcError.message && (
              rpcError.message.includes('Could not find the function') ||
              rpcError.message.includes('does not exist')
            )) || isMissingTableError(rpcError);

          if (!isLocalFallbackPermitted()) {
            const errMsg = isMissingRpcOrTable
              ? 'Payment storage unavailable: Required database migration (v6_payments_and_reconciliation) is not installed. Payment reconciliation is temporarily unavailable until the migration is applied.'
              : `Payment reconciliation failure: ${rpcError.message}`;
            const storageErr = new Error(errMsg);
            storageErr.status = 503;
            storageErr.code = isMissingRpcOrTable ? 'MIGRATION_MISSING' : 'STORAGE_UNAVAILABLE';
            throw storageErr;
          }
        }
      } else if (!isLocalFallbackPermitted()) {
        const storageErr = new Error('Payment storage unavailable: Required database migration (v6_payments_and_reconciliation) is not installed. Payment reconciliation is temporarily unavailable until the migration is applied.');
        storageErr.status = 503;
        storageErr.code = 'MIGRATION_MISSING';
        throw storageErr;
      }
    } catch(err) {
      if (!isLocalFallbackPermitted()) throw err;
      if (err.status === 404 || err.status === 503) throw err;
      console.warn('Atomic RPC call failed, falling back to local storage in test/dev mode:', err.message);
    }
  } else if (!isLocalFallbackPermitted()) {
    const storageErr = new Error('Payment storage unavailable: Durable database storage is required in deployed environments, but Supabase client is not configured. Payment reconciliation is temporarily unavailable.');
    storageErr.status = 503;
    storageErr.code = 'STORAGE_UNAVAILABLE';
    throw storageErr;
  }

  // Local fallback (only reached if isLocalFallbackPermitted() is true)
  let payment = localPayments.find(p => p.id === paymentId);
  if (!payment) {
    const notFoundErr = new Error(`Payment record not found: ${paymentId}`);
    notFoundErr.status = 404;
    throw notFoundErr;
  }

  const previousStatus = payment.reconciliation_status;
  const verifiedActualFee = actualFee != null ? (parseFloat(actualFee) || 0) : (payment.actual_fee != null ? payment.actual_fee : 0);
  
  // Compare statement amount against expected net settlement amount
  const expectedSettlement = calculateNetSettlement(payment.amount, verifiedActualFee, payment.direction);
  const discrepancy = Math.abs(expectedSettlement - numStatementAmount);

  // Status decision: if discrepancy <= 0.05 (rounding tolerance), it is Reconciled; otherwise Mismatched
  const isMatch = discrepancy <= 0.05;
  const newStatus = isMatch ? 'Reconciled' : 'Mismatched';

  const updates = {
    statement_reference: statementReference.trim(),
    statement_amount: Math.round(numStatementAmount * 100) / 100,
    statement_date: statementDate || new Date().toISOString().split('T')[0],
    actual_fee: verifiedActualFee,
    net_settlement_amount: expectedSettlement,
    is_fee_verified: true,
    reconciliation_status: newStatus,
    reconciliation_notes: (reconciliationNotes || '').trim(),
    reconciled_by: user ? user.id : null,
    reconciled_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const auditEntry = {
    id: auditId,
    payment_id: paymentId,
    previous_status: previousStatus,
    new_status: newStatus,
    actor_id: user ? user.id : null,
    statement_reference: statementReference.trim(),
    discrepancy_amount: Math.round(discrepancy * 100) / 100,
    notes: (reconciliationNotes || '').trim(),
    created_at: new Date().toISOString()
  };

  Object.assign(payment, updates);
  localAudit.push(auditEntry);
  saveLocalData();

  return { payment, audit: auditEntry, isMatch, discrepancy };
}

/**
 * Find potential duplicate payments by:
 * 1. Matching non-empty transaction reference (UTR/RRN)
 * 2. Matching (quotation_id, amount, transaction_date, direction)
 */
async function findDuplicatePayments(supabaseAdmin = null) {
  let all = [];
  if (supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.from('payments').select('*');
      if (error) {
        if (!isLocalFallbackPermitted()) {
          const isMissingTable = isMissingTableError(error);
          const errMsg = isMissingTable
            ? 'Payment storage unavailable: Required database migration (v6_payments_and_reconciliation) is not installed. Duplicate payment check is temporarily unavailable.'
            : `Payment storage unavailable: Failed to query payments (${error.message}).`;
          const storageErr = new Error(errMsg);
          storageErr.status = 503;
          storageErr.code = isMissingTable ? 'MIGRATION_MISSING' : 'STORAGE_UNAVAILABLE';
          throw storageErr;
        }
      } else if (data) {
        all = data;
      }
    } catch(err) {
      if (!isLocalFallbackPermitted()) throw err;
    }
  } else if (!isLocalFallbackPermitted()) {
    const storageErr = new Error('Payment storage unavailable: Durable database storage is required in deployed environments, but Supabase client is not configured.');
    storageErr.status = 503;
    storageErr.code = 'STORAGE_UNAVAILABLE';
    throw storageErr;
  }

  if (!all.length && isLocalFallbackPermitted()) {
    all = [...localPayments];
  }

  const duplicatesByRef = {};
  const duplicatesByPattern = {};

  all.forEach(p => {
    // 1. Check UTR/Reference duplicates
    if (p.transaction_reference && p.transaction_reference.trim()) {
      const ref = p.transaction_reference.trim().toUpperCase();
      if (!duplicatesByRef[ref]) duplicatesByRef[ref] = [];
      duplicatesByRef[ref].push(p);
    }

    // 2. Check Quote + Amount + Date + Direction pattern duplicates
    if (p.quotation_id && p.amount) {
      const key = `${p.quotation_id}|${p.amount}|${p.transaction_date}|${p.direction}`;
      if (!duplicatesByPattern[key]) duplicatesByPattern[key] = [];
      duplicatesByPattern[key].push(p);
    }
  });

  const flagList = [];

  Object.entries(duplicatesByRef).forEach(([ref, records]) => {
    if (records.length > 1) {
      flagList.push({
        type: 'DUPLICATE_REFERENCE',
        reference: ref,
        count: records.length,
        payments: records.map(r => ({ id: r.id, quote_id: r.quotation_id, amount: r.amount, narration: r.narration, date: r.transaction_date }))
      });
    }
  });

  Object.entries(duplicatesByPattern).forEach(([key, records]) => {
    if (records.length > 1) {
      // If already flagged under reference, don't double flag unless references differ
      const refs = new Set(records.map(r => r.transaction_reference || ''));
      if (refs.size > 1 || refs.has('')) {
        flagList.push({
          type: 'DUPLICATE_PATTERN',
          pattern: key,
          count: records.length,
          payments: records.map(r => ({ id: r.id, quote_id: r.quotation_id, amount: r.amount, narration: r.narration, date: r.transaction_date, reference: r.transaction_reference }))
        });
      }
    }
  });

  return flagList;
}

/**
 * List payments with flexible filters
 */
async function listPayments(filters = {}, supabaseAdmin = null) {
  let list = [];
  if (supabaseAdmin) {
    try {
      let q = supabaseAdmin.from('payments').select('*').order('created_at', { ascending: false });
      if (filters.quotation_id) q = q.eq('quotation_id', filters.quotation_id);
      if (filters.direction) q = q.eq('direction', filters.direction);
      if (filters.status) q = q.eq('reconciliation_status', filters.status);
      if (filters.payment_method) q = q.eq('payment_method', filters.payment_method.toLowerCase());
      if (filters.date_from) q = q.gte('transaction_date', filters.date_from);
      if (filters.date_to) q = q.lte('transaction_date', filters.date_to);

      const { data, error } = await q;
      if (error) {
        if (!isLocalFallbackPermitted()) {
          const isMissingTable = isMissingTableError(error);
          const errMsg = isMissingTable
            ? 'Payment storage unavailable: Required database migration (v6_payments_and_reconciliation) is not installed. Payment list is temporarily unavailable.'
            : `Payment storage unavailable: Failed to list payments (${error.message}).`;
          const storageErr = new Error(errMsg);
          storageErr.status = 503;
          storageErr.code = isMissingTable ? 'MIGRATION_MISSING' : 'STORAGE_UNAVAILABLE';
          throw storageErr;
        }
      } else if (data) {
        list = data;
      }
    } catch(err) {
      if (!isLocalFallbackPermitted()) throw err;
    }
  } else if (!isLocalFallbackPermitted()) {
    const storageErr = new Error('Payment storage unavailable: Durable database storage is required in deployed environments, but Supabase client is not configured.');
    storageErr.status = 503;
    storageErr.code = 'STORAGE_UNAVAILABLE';
    throw storageErr;
  }

  if (!list.length && isLocalFallbackPermitted()) {
    list = [...localPayments];
    if (filters.quotation_id) {
      list = list.filter(p => p.quotation_id === filters.quotation_id);
    }
    if (filters.direction) {
      list = list.filter(p => p.direction === filters.direction);
    }
    if (filters.status) {
      list = list.filter(p => p.reconciliation_status === filters.status);
    }
    if (filters.payment_method) {
      list = list.filter(p => p.payment_method === filters.payment_method.toLowerCase());
    }
    if (filters.date_from) {
      list = list.filter(p => p.transaction_date >= filters.date_from);
    }
    if (filters.date_to) {
      list = list.filter(p => p.transaction_date <= filters.date_to);
    }
  }

  // Text search in narration, customer name, reference
  if (filters.search) {
    const s = filters.search.toLowerCase().trim();
    list = list.filter(p => 
      (p.narration && p.narration.toLowerCase().includes(s)) ||
      (p.transaction_reference && p.transaction_reference.toLowerCase().includes(s)) ||
      (p.customer_name && p.customer_name.toLowerCase().includes(s)) ||
      (p.supplier_name && p.supplier_name.toLowerCase().includes(s)) ||
      (p.quotation_id && p.quotation_id.toLowerCase().includes(s))
    );
  }

  return list;
}

/**
 * Reset local test payments (for test harness only)
 */
function _resetLocalPaymentsForTesting(initial = []) {
  localPayments = [...initial];
  localAudit = [];
}

module.exports = {
  isLocalFallbackPermitted,
  generatePaymentNarration,
  validateNarration,
  recordPayment,
  reconcilePayment,
  findDuplicatePayments,
  listPayments,
  _resetLocalPaymentsForTesting
};
