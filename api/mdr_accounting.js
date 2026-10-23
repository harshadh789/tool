// ==============================================================================
// Campfly Phase 3B.1 - MDR-Aware Internal Accounting Engine
// ==============================================================================
// REGULATORY COMPLIANCE & BUSINESS RULES:
// 1. Under Section 10A of the Indian Payment and Settlement Systems Act, 2007,
//    person-to-merchant (P2M) UPI and RuPay debit card transactions incur 0% MDR.
// 2. PPI Wallets (Paytm/PhonePe wallets via gateway) > ₹2,000 may incur up to 1.1% interchange.
// 3. Payment Aggregator standard rates (e.g. Razorpay, Cashfree, PayU):
//    - Domestic Credit Cards: 2.0% + 18% GST = 2.36% effective
//    - International Credit Cards: 3.0% + 18% GST = 3.54% effective
//    - Netbanking: Flat ₹15 + 18% GST = ₹17.70
//    - Direct IDFC First Bank Current Account Transfers (NEFT/RTGS/IMPS/Direct UPI): ₹0
// 4. CRITICAL BUSINESS RULE:
//    MDR and payment-processing fees MUST NEVER be surcharged or automatically
//    added to the customer quotation, customer view page, or customer PDF.
//    All fees are recorded strictly as internal business expenses.
// ==============================================================================

const GST_RATE_PCT = 18.0;

// Configurable Fee Rules Engine
// Supports effective dates, transaction limits, provider overrides, and active/inactive status
const DEFAULT_FEE_RULES = [
  {
    id: 'idfc_direct_upi',
    provider: 'IDFC First Bank',
    payment_method: 'upi',
    category: 'direct_bank',
    pct_rate: 0.0,
    flat_fee: 0.0,
    gst_applicable: false,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Direct Current Account UPI via IDFC First Bank (Zero MDR mandate under Section 10A)'
  },
  {
    id: 'idfc_direct_bank_transfer',
    provider: 'IDFC First Bank',
    payment_method: 'bank_transfer',
    category: 'direct_bank',
    pct_rate: 0.0,
    flat_fee: 0.0,
    gst_applicable: false,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Direct NEFT / RTGS / IMPS Corporate Account receipt (Zero Fee)'
  },
  {
    id: 'gateway_upi_bank',
    provider: 'Gateway',
    payment_method: 'upi',
    category: 'gateway_bank_account',
    pct_rate: 0.0,
    flat_fee: 0.0,
    gst_applicable: false,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Standard Gateway UPI Bank-to-Bank (0% MDR under Section 10A)'
  },
  {
    id: 'proposed_upi_mdr_postponed',
    provider: 'Gateway',
    payment_method: 'upi',
    category: 'proposed_merchant_upi',
    pct_rate: 0.4,
    flat_fee: 0.0,
    gst_applicable: true,
    min_amount: 0,
    max_amount: null,
    // The proposed 0.4% UPI MDR rollout was postponed on October 13, 2026, until immediately after Diwali.
    // The new effective date will be notified separately.
    // STRICT RULE: Must NOT be treated as active by default.
    enabled: false,
    effective_from: null, // Pending official post-Diwali notification and provider confirmation
    effective_to: null,
    description: 'Proposed 0.4% UPI MDR (Postponed on Oct 13, 2026 until post-Diwali; Inactive pending official confirmation)'
  },
  {
    id: 'gateway_upi_ppi',
    provider: 'Gateway',
    payment_method: 'upi',
    category: 'gateway_ppi_wallet',
    pct_rate: 1.1,
    flat_fee: 0.0,
    gst_applicable: true,
    min_amount: 2000.01,
    max_amount: null,
    enabled: true,
    effective_from: '2023-04-01',
    effective_to: null,
    description: 'PPI Wallet UPI Interchange above ₹2,000 (1.1% + 18% GST)'
  },
  {
    id: 'gateway_rupay_debit',
    provider: 'Gateway',
    payment_method: 'debit_card',
    category: 'rupay',
    pct_rate: 0.0,
    flat_fee: 0.0,
    gst_applicable: false,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'RuPay Debit Card (Zero MDR mandate under Section 10A)'
  },
  {
    id: 'gateway_standard_debit',
    provider: 'Gateway',
    payment_method: 'debit_card',
    category: 'standard',
    pct_rate: 0.9,
    flat_fee: 0.0,
    gst_applicable: true,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Visa / Mastercard Debit Card (0.9% + 18% GST)'
  },
  {
    id: 'gateway_domestic_credit_card',
    provider: 'Gateway',
    payment_method: 'credit_card',
    category: 'domestic',
    pct_rate: 2.0,
    flat_fee: 0.0,
    gst_applicable: true,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Domestic Credit Card (2.0% + 18% GST = 2.36% effective)'
  },
  {
    id: 'gateway_intl_credit_card',
    provider: 'Gateway',
    payment_method: 'credit_card',
    category: 'international',
    pct_rate: 3.0,
    flat_fee: 0.0,
    gst_applicable: true,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'International Credit Card (3.0% + 18% GST = 3.54% effective)'
  },
  {
    id: 'gateway_netbanking',
    provider: 'Gateway',
    payment_method: 'netbanking',
    category: 'standard',
    pct_rate: 0.0,
    flat_fee: 15.0,
    gst_applicable: true,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Net Banking (₹15 flat + 18% GST = ₹17.70)'
  },
  {
    id: 'cash_payment',
    provider: 'Cash',
    payment_method: 'cash',
    category: 'cash',
    pct_rate: 0.0,
    flat_fee: 0.0,
    gst_applicable: false,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: '2020-01-01',
    effective_to: null,
    description: 'Cash in Hand / Counter Deposit (Zero Fee)'
  }
];

let activeFeeRules = JSON.parse(JSON.stringify(DEFAULT_FEE_RULES));

/**
 * Configure or update MDR fee rules
 */
function setFeeRules(rules) {
  if (Array.isArray(rules)) {
    activeFeeRules = JSON.parse(JSON.stringify(rules));
  }
}

function getFeeRules() {
  return JSON.parse(JSON.stringify(activeFeeRules));
}

function resetFeeRules() {
  activeFeeRules = JSON.parse(JSON.stringify(DEFAULT_FEE_RULES));
  return getFeeRules();
}

/**
 * Enable a specific fee rule only when official effective date and provider applicability are confirmed.
 */
function enableRule(ruleId, confirmedEffectiveFromDate, options = {}) {
  if (!confirmedEffectiveFromDate || isNaN(new Date(confirmedEffectiveFromDate).getTime())) {
    throw new Error('A valid confirmed effective date (YYYY-MM-DD) is required to activate an MDR fee rule.');
  }
  const rule = activeFeeRules.find(r => r.id === ruleId);
  if (!rule) {
    throw new Error(`Fee rule with ID '${ruleId}' not found.`);
  }
  if (ruleId === 'proposed_upi_mdr_postponed') {
    if (!options.confirmedApplicability) {
      throw new Error("Proposed UPI MDR rule requires explicit confirmation of applicability to Campfly's payment arrangement and official notification after Diwali.");
    }
  }
  rule.enabled = true;
  rule.effective_from = confirmedEffectiveFromDate;
  if (options.provider) rule.provider = options.provider;
  if (options.category) rule.category = options.category;
  if (options.pct_rate != null) rule.pct_rate = options.pct_rate;
  if (options.notes) rule.confirmation_notes = options.notes;
  return rule;
}

/**
 * Disable a specific fee rule (e.g. postponed or repealed regulations).
 */
function disableRule(ruleId, reason = '') {
  const rule = activeFeeRules.find(r => r.id === ruleId);
  if (!rule) {
    throw new Error(`Fee rule with ID '${ruleId}' not found.`);
  }
  rule.enabled = false;
  if (reason) rule.disabled_reason = reason;
  return rule;
}

/**
 * Add or override a custom fee rule for specific providers or commercial arrangements.
 */
function addCustomRule(ruleConfig) {
  if (!ruleConfig.id || !ruleConfig.payment_method || ruleConfig.pct_rate == null) {
    throw new Error('Custom rule requires at least id, payment_method, and pct_rate.');
  }
  const existingIdx = activeFeeRules.findIndex(r => r.id === ruleConfig.id);
  const formatted = {
    provider: 'Gateway',
    category: 'standard',
    flat_fee: 0.0,
    gst_applicable: true,
    min_amount: 0,
    max_amount: null,
    enabled: true,
    effective_from: new Date().toISOString().split('T')[0],
    effective_to: null,
    ...ruleConfig
  };
  if (existingIdx >= 0) {
    activeFeeRules[existingIdx] = formatted;
  } else {
    activeFeeRules.unshift(formatted);
  }
  return formatted;
}

/**
 * Calculate internal fee estimate for a payment
 * NEVER returns surcharge to customer.
 */
function estimateProcessingFee({
  amount,
  paymentMethod,
  provider = 'IDFC First Bank',
  category = null,
  transactionDate = new Date().toISOString()
}) {
  const numericAmount = parseFloat(amount) || 0;
  if (numericAmount <= 0) {
    return {
      estimated_fee: 0,
      base_fee: 0,
      gst_amount: 0,
      effective_rate_pct: 0,
      rule_applied: 'zero_amount',
      description: 'Zero transaction amount',
      is_estimate: true,
      is_actual: false,
      status: 'ESTIMATE_PENDING_SETTLEMENT',
      is_surcharged_to_customer: false
    };
  }

  const normalizedMethod = (paymentMethod || 'upi').toLowerCase().trim();
  const normalizedProvider = (provider || 'IDFC First Bank').trim();
  const txDate = new Date(transactionDate);

  // Match best active rule
  const matchedRule = activeFeeRules.find(rule => {
    // 1. Explicitly check if rule is enabled
    if (rule.enabled === false) return false;

    // 2. Check payment method
    if (rule.payment_method !== normalizedMethod) return false;
    
    // 3. Check provider match (if rule specifies exact provider, otherwise Gateway wildcard)
    if (rule.provider !== 'Gateway' && normalizedProvider && 
        !normalizedProvider.toLowerCase().includes(rule.provider.toLowerCase()) &&
        !rule.provider.toLowerCase().includes(normalizedProvider.toLowerCase())) {
      return false;
    }

    // 4. Check category if provided
    if (category && rule.category && rule.category !== category) {
      return false;
    }

    // 5. Amount bounds
    if (rule.min_amount != null && numericAmount < rule.min_amount) return false;
    if (rule.max_amount != null && numericAmount > rule.max_amount) return false;

    // 6. Effective Date bounds (require confirmed effective_from date)
    if (!rule.effective_from) return false;
    const effFrom = new Date(rule.effective_from);
    if (isNaN(effFrom.getTime()) || effFrom > txDate) return false; // Future-effective rules are NOT active
    if (rule.effective_to) {
      const effTo = new Date(rule.effective_to);
      if (!isNaN(effTo.getTime()) && effTo < txDate) return false;
    }

    return true;
  }) || {
    pct_rate: 0.0,
    flat_fee: 0.0,
    gst_applicable: false,
    description: 'Default zero-fee fallback'
  };

  const pctFee = (numericAmount * (matchedRule.pct_rate || 0)) / 100;
  const flatFee = matchedRule.flat_fee || 0;
  const baseFee = pctFee + flatFee;

  let gstAmount = 0;
  if (matchedRule.gst_applicable && baseFee > 0) {
    gstAmount = (baseFee * GST_RATE_PCT) / 100;
  }

  const totalEstimatedFee = Math.round((baseFee + gstAmount) * 100) / 100;
  const effectiveRate = numericAmount > 0 ? (totalEstimatedFee / numericAmount) * 100 : 0;

  return {
    estimated_fee: totalEstimatedFee,
    base_fee: Math.round(baseFee * 100) / 100,
    gst_amount: Math.round(gstAmount * 100) / 100,
    effective_rate_pct: Math.round(effectiveRate * 1000) / 1000,
    rule_applied: matchedRule.id || 'default_fallback',
    description: matchedRule.description,
    is_estimate: true,
    is_actual: false,
    status: 'ESTIMATE_PENDING_SETTLEMENT',
    is_surcharged_to_customer: false // STRICT INVARIANT: Always false!
  };
}

/**
 * Calculates net settlement amount
 * Direction:
 *   'inbound' (customer receipt): net = amount - actual_fee
 *   'outbound' (supplier payment / refund): net = amount + actual_fee
 */
function calculateNetSettlement(amount, actualFee = 0, direction = 'inbound') {
  const numAmount = parseFloat(amount) || 0;
  const numFee = parseFloat(actualFee) || 0;

  if (direction === 'inbound') {
    return Math.round((numAmount - numFee) * 100) / 100;
  } else {
    // For outbound payments, the total cash drain is the payout + any transaction fee incurred
    return Math.round((numAmount + numFee) * 100) / 100;
  }
}

/**
 * Calculate complete itinerary profitability accounting for supplier costs and payment fees
 */
function calculateItineraryFinancials(itinerary, payments = []) {
  const quoteTotal = parseFloat(itinerary.total_amount || itinerary.baseCost || 0);

  let totalCustomerReceipts = 0;
  let totalCustomerRefunds = 0;
  let totalSupplierPayments = 0;
  let totalProcessingFees = 0;
  let totalEstimatedFees = 0;

  payments.forEach(p => {
    const amt = parseFloat(p.amount) || 0;
    const actualFee = parseFloat(p.actual_fee) || 0;
    const estFee = parseFloat(p.estimated_fee) || 0;

    totalProcessingFees += actualFee;
    totalEstimatedFees += estFee;

    if (p.transaction_type === 'customer_receipt' || (p.direction === 'inbound' && p.transaction_type !== 'refund')) {
      totalCustomerReceipts += amt;
    } else if (p.transaction_type === 'customer_refund') {
      totalCustomerRefunds += amt;
    } else if (p.transaction_type === 'supplier_payment') {
      totalSupplierPayments += amt;
    }
  });

  const netCustomerPaid = totalCustomerReceipts - totalCustomerRefunds;
  const balanceDueFromCustomer = Math.max(0, quoteTotal - netCustomerPaid);

  // Supplier Costs recorded on itinerary (if internal notes or content present)
  let totalSupplierCost = 0;
  if (itinerary.content && itinerary.content.supplierCosts) {
    totalSupplierCost = parseFloat(itinerary.content.supplierCosts.total) || 0;
  } else if (itinerary.supplier_costs) {
    totalSupplierCost = parseFloat(itinerary.supplier_costs) || 0;
  }

  // Fees to use: actual fees if present, otherwise estimated fees
  const feesIncurred = totalProcessingFees > 0 ? totalProcessingFees : totalEstimatedFees;

  const grossProfit = quoteTotal - totalSupplierCost;
  const netProfit = grossProfit - feesIncurred;
  const netProfitMarginPct = quoteTotal > 0 ? Math.round((netProfit / quoteTotal) * 1000) / 10 : 0;

  return {
    quote_total: quoteTotal,
    gross_customer_receipts: Math.round(totalCustomerReceipts * 100) / 100,
    customer_refunds: Math.round(totalCustomerRefunds * 100) / 100,
    net_customer_paid: Math.round(netCustomerPaid * 100) / 100,
    balance_due: Math.round(balanceDueFromCustomer * 100) / 100,
    total_supplier_cost: Math.round(totalSupplierCost * 100) / 100,
    total_supplier_paid: Math.round(totalSupplierPayments * 100) / 100,
    supplier_payable_remaining: Math.max(0, Math.round((totalSupplierCost - totalSupplierPayments) * 100) / 100),
    total_processing_fees_actual: Math.round(totalProcessingFees * 100) / 100,
    total_processing_fees_estimated: Math.round(totalEstimatedFees * 100) / 100,
    fees_incurred: Math.round(feesIncurred * 100) / 100,
    gross_profit: Math.round(grossProfit * 100) / 100,
    net_profit: Math.round(netProfit * 100) / 100,
    net_profit_margin_pct: netProfitMarginPct,
    currency: itinerary.currency || 'INR'
  };
}

module.exports = {
  GST_RATE_PCT,
  DEFAULT_FEE_RULES,
  setFeeRules,
  getFeeRules,
  resetFeeRules,
  enableRule,
  disableRule,
  addCustomRule,
  estimateProcessingFee,
  calculateNetSettlement,
  calculateItineraryFinancials
};
