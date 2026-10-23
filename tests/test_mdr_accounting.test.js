// ==============================================================================
// Campfly Phase 3B.1 - MDR-Aware Internal Accounting Regression Tests
// ==============================================================================

const assert = require('assert');
const mdr = require('../api/mdr_accounting.js');
const db = require('../api/db.js');

console.log('=== PHASE 3B.1: MDR-AWARE INTERNAL ACCOUNTING TESTS ===');

let passCount = 0;
let totalCount = 0;

function test(name, fn) {
  totalCount++;
  try {
    fn();
    console.log(`✅ [PASS] ${totalCount}. ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalCount}. ${name}: ${err.message}`);
    throw err;
  }
}

// 1. Direct Bank UPI has 0% MDR under Indian law
test('Direct Bank UPI via IDFC First Bank incurs 0% MDR and 0 fee', () => {
  const result = mdr.estimateProcessingFee({
    amount: 50000,
    paymentMethod: 'upi',
    provider: 'IDFC First Bank'
  });
  assert.strictEqual(result.estimated_fee, 0);
  assert.strictEqual(result.effective_rate_pct, 0);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 2. Gateway Bank UPI has 0% MDR
test('Standard Gateway Bank-to-Bank UPI incurs 0% MDR', () => {
  const result = mdr.estimateProcessingFee({
    amount: 75000,
    paymentMethod: 'upi',
    provider: 'Razorpay',
    category: 'gateway_bank_account'
  });
  assert.strictEqual(result.estimated_fee, 0);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 3. PPI Wallet UPI above ₹2000 incurs 1.1% + 18% GST (1.298% effective)
test('Gateway PPI Wallet UPI above ₹2000 incurs 1.1% + 18% GST', () => {
  const amount = 10000;
  const result = mdr.estimateProcessingFee({
    amount,
    paymentMethod: 'upi',
    provider: 'Gateway',
    category: 'gateway_ppi_wallet'
  });
  // base fee = 1.1% of 10000 = 110. GST (18%) = 19.80. Total = 129.80
  assert.strictEqual(result.base_fee, 110);
  assert.strictEqual(result.gst_amount, 19.80);
  assert.strictEqual(result.estimated_fee, 129.80);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 4. Direct Corporate Bank Transfer (NEFT/RTGS/IMPS) has 0 fee
test('Direct NEFT / RTGS / IMPS bank transfer incurs 0 fee', () => {
  const result = mdr.estimateProcessingFee({
    amount: 150000,
    paymentMethod: 'bank_transfer',
    provider: 'IDFC First Bank'
  });
  assert.strictEqual(result.estimated_fee, 0);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 5. RuPay Debit Card incurs 0% MDR under Indian law
test('RuPay Debit Card incurs 0% MDR', () => {
  const result = mdr.estimateProcessingFee({
    amount: 40000,
    paymentMethod: 'debit_card',
    provider: 'Gateway',
    category: 'rupay'
  });
  assert.strictEqual(result.estimated_fee, 0);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 6. Domestic Credit Card incurs 2.0% + 18% GST (2.36% effective)
test('Domestic Credit Card fee is 2.0% + 18% GST (2.36% effective)', () => {
  const amount = 100000;
  const result = mdr.estimateProcessingFee({
    amount,
    paymentMethod: 'credit_card',
    provider: 'Gateway',
    category: 'domestic'
  });
  // base fee = 2% of 100000 = 2000. GST = 360. Total = 2360
  assert.strictEqual(result.base_fee, 2000);
  assert.strictEqual(result.gst_amount, 360);
  assert.strictEqual(result.estimated_fee, 2360);
  assert.strictEqual(result.effective_rate_pct, 2.36);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 7. International Credit Card incurs 3.0% + 18% GST (3.54% effective)
test('International Credit Card fee is 3.0% + 18% GST (3.54% effective)', () => {
  const amount = 100000;
  const result = mdr.estimateProcessingFee({
    amount,
    paymentMethod: 'credit_card',
    provider: 'Gateway',
    category: 'international'
  });
  // base fee = 3000. GST = 540. Total = 3540
  assert.strictEqual(result.base_fee, 3000);
  assert.strictEqual(result.gst_amount, 540);
  assert.strictEqual(result.estimated_fee, 3540);
  assert.strictEqual(result.effective_rate_pct, 3.54);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 8. Netbanking incurs flat fee + 18% GST
test('Netbanking incurs ₹15 flat + 18% GST (₹17.70 total)', () => {
  const result = mdr.estimateProcessingFee({
    amount: 50000,
    paymentMethod: 'netbanking',
    provider: 'Gateway'
  });
  assert.strictEqual(result.base_fee, 15);
  assert.strictEqual(result.gst_amount, 2.70);
  assert.strictEqual(result.estimated_fee, 17.70);
  assert.strictEqual(result.is_surcharged_to_customer, false);
});

// 9. Inbound net settlement deducts actual fee
test('Inbound Net Settlement amount equals gross payment minus actual fee', () => {
  const gross = 100000;
  const fee = 2360;
  const net = mdr.calculateNetSettlement(gross, fee, 'inbound');
  assert.strictEqual(net, 97640);
});

// 10. Outbound net settlement accounts for payment plus fee
test('Outbound Net Settlement accounts for payout amount plus transaction cost', () => {
  const payout = 45000;
  const fee = 10;
  const net = mdr.calculateNetSettlement(payout, fee, 'outbound');
  assert.strictEqual(net, 45010);
});

// 11. Complete itinerary profitability accounting
test('Itinerary profitability correctly computes revenue, supplier cost, fees, and net profit', () => {
  const itinerary = {
    quote_id: 'CMP-2026-772956',
    total_amount: 150000,
    supplier_costs: 95000
  };

  const payments = [
    {
      amount: 50000,
      direction: 'inbound',
      transaction_type: 'customer_receipt',
      actual_fee: 0 // direct UPI
    },
    {
      amount: 100000,
      direction: 'inbound',
      transaction_type: 'customer_receipt',
      actual_fee: 2360 // credit card
    },
    {
      amount: 60000,
      direction: 'outbound',
      transaction_type: 'supplier_payment',
      actual_fee: 0
    }
  ];

  const fin = mdr.calculateItineraryFinancials(itinerary, payments);

  assert.strictEqual(fin.quote_total, 150000);
  assert.strictEqual(fin.gross_customer_receipts, 150000);
  assert.strictEqual(fin.net_customer_paid, 150000);
  assert.strictEqual(fin.balance_due, 0);
  assert.strictEqual(fin.total_supplier_cost, 95000);
  assert.strictEqual(fin.total_supplier_paid, 60000);
  assert.strictEqual(fin.supplier_payable_remaining, 35000);
  assert.strictEqual(fin.total_processing_fees_actual, 2360);
  // Gross profit = 150000 - 95000 = 55000
  assert.strictEqual(fin.gross_profit, 55000);
  // Net profit = 55000 - 2360 = 52640
  assert.strictEqual(fin.net_profit, 52640);
  // Net margin = (52640 / 150000) * 100 = 35.1%
  assert.strictEqual(fin.net_profit_margin_pct, 35.1);
});

// 12. Customer-facing payload never leaks fees or internal financial data
test('Customer-facing itinerary filter NEVER reveals payment processing fees, supplier costs, or net profit', () => {
  const rawRecord = {
    id: 'CMP-2026-772956',
    quote_id: 'CMP-2026-772956',
    status: 'Confirmed',
    guest_name: 'Arham Fahmi',
    title: 'Bali Luxury Experience',
    total_amount: 150000,
    content: {
      id: 'CMP-2026-772956',
      guest: 'Arham Fahmi',
      supplierCosts: { total: 95000, hotel: 60000, transport: 35000 },
      internalProfit: 55000,
      processingFees: 2360,
      commissionPct: 15,
      staffNotes: 'VIP Client, requested ocean view villa'
    }
  };

  const customerView = db.filterCustomerItinerary(rawRecord);

  assert.strictEqual(customerView.supplierCosts, undefined);
  assert.strictEqual(customerView.internalProfit, undefined);
  assert.strictEqual(customerView.processingFees, undefined);
  assert.strictEqual(customerView.commissionPct, undefined);
  assert.strictEqual(customerView.staffNotes, undefined);
  assert.strictEqual(customerView.quote_id, 'CMP-2026-772956');
  assert.strictEqual(customerView.guest, 'Arham Fahmi');
  assert.strictEqual(customerView.bankDetails.name, 'CAMPFLY TOURS LLP');
  assert.strictEqual(customerView.bankDetails.upi, 'Campfly@idfcbank');
});

// 13. Proposed 0.4% UPI MDR rule is disabled by default following Oct 13, 2026 postponement
test('Proposed 0.4% UPI MDR rule is disabled by default following Oct 13, 2026 postponement', () => {
  const rules = mdr.getFeeRules();
  const proposedRule = rules.find(r => r.id === 'proposed_upi_mdr_postponed');
  assert.ok(proposedRule, 'proposed_upi_mdr_postponed rule should exist in rule registry');
  assert.strictEqual(proposedRule.enabled, false, 'Rule must be disabled by default');
  assert.strictEqual(proposedRule.effective_from, null, 'effective_from must be null pending official notification');
  assert.ok(proposedRule.description.includes('Postponed on Oct 13, 2026'), 'Description must note postponement');
});

// 14. Transactions do not trigger 0.4% UPI MDR by default and incur 0 fee under Section 10A
test('UPI transactions do not trigger 0.4% MDR and fall back to 0% MDR', () => {
  const estimate = mdr.estimateProcessingFee({
    amount: 80000,
    paymentMethod: 'upi',
    provider: 'Gateway',
    category: 'proposed_merchant_upi',
    transactionDate: '2026-10-23'
  });
  // Since proposed rule is disabled, standard gateway / zero-fee fallback applies
  assert.strictEqual(estimate.estimated_fee, 0);
  assert.strictEqual(estimate.effective_rate_pct, 0);
  assert.strictEqual(estimate.is_surcharged_to_customer, false);
});

// 15. Future-effective rules are not applied to transactions before effective date
test('Future-effective MDR rule is not applied prematurely', () => {
  mdr.addCustomRule({
    id: 'test_future_rule',
    payment_method: 'upi',
    provider: 'TestPay',
    pct_rate: 1.5,
    enabled: true,
    effective_from: '2026-11-15' // Future date after Diwali
  });

  // Transaction today (2026-10-23) must NOT match future rule
  const estimateCurrent = mdr.estimateProcessingFee({
    amount: 50000,
    paymentMethod: 'upi',
    provider: 'TestPay',
    transactionDate: '2026-10-23'
  });
  assert.strictEqual(estimateCurrent.estimated_fee, 0, 'Current tx must not apply future rule');

  // Transaction after effective date DOES match
  const estimateFuture = mdr.estimateProcessingFee({
    amount: 50000,
    paymentMethod: 'upi',
    provider: 'TestPay',
    transactionDate: '2026-11-20'
  });
  assert.strictEqual(estimateFuture.base_fee, 750); // 1.5% of 50000
  assert.strictEqual(estimateFuture.rule_applied, 'test_future_rule');

  // Clean up
  mdr.resetFeeRules();
});

// 16. Activating proposed UPI MDR requires confirmed effective date and applicability
test('enableRule for proposed UPI MDR rejects without confirmed applicability or invalid date', () => {
  mdr.resetFeeRules();
  
  // Rejects missing date
  assert.throws(() => {
    mdr.enableRule('proposed_upi_mdr_postponed', null);
  }, /valid confirmed effective date/i);

  // Rejects without confirmed applicability
  assert.throws(() => {
    mdr.enableRule('proposed_upi_mdr_postponed', '2026-11-15');
  }, /explicit confirmation of applicability to Campfly's payment arrangement/i);
});

// 17. Activating proposed UPI MDR works once officially confirmed post-Diwali
test('enableRule successfully enables rate once official date and applicability are confirmed', () => {
  mdr.resetFeeRules();

  const confirmed = mdr.enableRule('proposed_upi_mdr_postponed', '2026-11-15', {
    confirmedApplicability: true,
    notes: 'Confirmed by IDFC First Bank / Gateway post-Diwali circular'
  });

  assert.strictEqual(confirmed.enabled, true);
  assert.strictEqual(confirmed.effective_from, '2026-11-15');

  // Pre-effective date tx still 0
  const preTx = mdr.estimateProcessingFee({
    amount: 100000,
    paymentMethod: 'upi',
    category: 'proposed_merchant_upi',
    transactionDate: '2026-10-23'
  });
  assert.strictEqual(preTx.estimated_fee, 0);

  // Post-effective date tx applies 0.4% + 18% GST = 0.472%
  const postTx = mdr.estimateProcessingFee({
    amount: 100000,
    paymentMethod: 'upi',
    category: 'proposed_merchant_upi',
    transactionDate: '2026-11-20'
  });
  // 0.4% of 100000 = 400. GST = 72. Total = 472.
  assert.strictEqual(postTx.base_fee, 400);
  assert.strictEqual(postTx.gst_amount, 72);
  assert.strictEqual(postTx.estimated_fee, 472);
  assert.strictEqual(postTx.rule_applied, 'proposed_upi_mdr_postponed');

  mdr.resetFeeRules();
});

// 18. Estimate explicitly distinguishes estimates from actual charges and never surcharges
test('Processing fee estimate clearly distinguishes estimates from actual settlement charges', () => {
  const estimate = mdr.estimateProcessingFee({
    amount: 50000,
    paymentMethod: 'credit_card',
    provider: 'Gateway',
    category: 'domestic'
  });
  assert.strictEqual(estimate.is_estimate, true);
  assert.strictEqual(estimate.is_actual, false);
  assert.strictEqual(estimate.status, 'ESTIMATE_PENDING_SETTLEMENT');
  assert.strictEqual(estimate.is_surcharged_to_customer, false);
});

console.log(`\n========================================`);
console.log(`SUMMARY: ${passCount} / ${totalCount} MDR accounting tests passed.`);
console.log(`========================================\n`);
