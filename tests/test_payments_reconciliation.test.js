// ==============================================================================
// Campfly Phase 3B.1 - Payments & Bank Reconciliation Regression Tests
// ==============================================================================

const assert = require('assert');
const request = require('supertest');
const app = require('../api/server.js');
const payments = require('../api/payments.js');
const db = require('../api/db.js');

console.log('=== PHASE 3B.1: PAYMENTS & BANK RECONCILIATION TESTS ===');

let passCount = 0;
let totalCount = 0;

async function test(name, fn) {
  totalCount++;
  try {
    await fn();
    console.log(`✅ [PASS] ${totalCount}. ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalCount}. ${name}: ${err.message}`);
    throw err;
  }
}

// Mock auth tokens and users
const ADMIN_USER = { id: 'usr-admin-1', email: 'admin@campfly.in', role: 'ADMIN', is_active: true };
const SALES_USER = { id: 'usr-sales-1', email: 'sales1@campfly.in', role: 'SALES', is_active: true };
const OTHER_SALES_USER = { id: 'usr-sales-2', email: 'sales2@campfly.in', role: 'SALES', is_active: true };
const OPS_USER = { id: 'usr-ops-1', email: 'ops@campfly.in', role: 'OPS', is_active: true };

const mockAuthUsers = {
  'admin-token': ADMIN_USER,
  'sales-token': SALES_USER,
  'other-sales-token': OTHER_SALES_USER,
  'ops-token': OPS_USER
};

const mockItineraries = new Map();
const mockPayments = new Map();
const mockAudit = [];

function createMockSupabaseClient() {
  return {
    auth: {
      getUser: async (token) => {
        const u = mockAuthUsers[token];
        if (u) return { data: { user: { id: u.id, email: u.email } }, error: null };
        return { data: { user: null }, error: new Error('Invalid token') };
      }
    },
    rpc: async (fnName, params) => {
      if (fnName === 'reconcile_payment_atomic') {
        const payment = mockPayments.get(params.p_payment_id);
        if (!payment) {
          return { data: null, error: { message: `PAYMENT_NOT_FOUND: Payment ${params.p_payment_id} not found` } };
        }
        const previousStatus = payment.reconciliation_status;
        const verifiedActualFee = params.p_actual_fee != null ? params.p_actual_fee : (payment.actual_fee || 0);
        const expected = payment.direction === 'inbound'
          ? Math.round((payment.amount - verifiedActualFee) * 100) / 100
          : Math.round((payment.amount + verifiedActualFee) * 100) / 100;
        const discrepancy = Math.round(Math.abs(expected - params.p_statement_amount) * 100) / 100;
        const isMatch = discrepancy <= 0.05;
        const newStatus = isMatch ? 'Reconciled' : 'Mismatched';

        Object.assign(payment, {
          statement_reference: params.p_statement_reference,
          statement_amount: params.p_statement_amount,
          statement_date: params.p_statement_date,
          actual_fee: verifiedActualFee,
          net_settlement_amount: expected,
          is_fee_verified: true,
          reconciliation_status: newStatus,
          reconciliation_notes: params.p_reconciliation_notes,
          reconciled_by: params.p_user_id,
          reconciled_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        const audit = {
          id: params.p_audit_id,
          payment_id: params.p_payment_id,
          previous_status: previousStatus,
          new_status: newStatus,
          actor_id: params.p_user_id,
          statement_reference: params.p_statement_reference,
          discrepancy_amount: discrepancy,
          notes: params.p_reconciliation_notes,
          created_at: new Date().toISOString()
        };

        mockAudit.push(audit);
        return { data: { payment, audit, isMatch, discrepancy }, error: null };
      }
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${fnName}` } };
    },
    from: (table) => {
      if (table === 'user_roles') {
        return {
          select: () => ({
            eq: (col, val) => ({
              single: async () => {
                const found = Object.values(mockAuthUsers).find(u => u.id === val);
                if (found) return { data: { role: found.role, is_active: found.is_active }, error: null };
                return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
              },
              maybeSingle: async () => {
                const found = Object.values(mockAuthUsers).find(u => u.id === val);
                if (found) return { data: { role: found.role, is_active: found.is_active }, error: null };
                return { data: null, error: null };
              }
            })
          })
        };
      }

      if (table === 'itineraries') {
        return {
          select: (cols) => ({
            eq: (col, val) => ({
              single: async () => {
                if (col === 'quote_id') {
                  const record = mockItineraries.get(val);
                  if (record) return { data: { ...record }, error: null };
                }
                return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
              }
            }),
            order: () => Promise.resolve({ data: Array.from(mockItineraries.values()), error: null })
          })
        };
      }

      if (table === 'payments') {
        const createQuery = () => {
          let filters = [];
          const query = {
            eq: (col, val) => {
              filters.push(p => p[col] === val);
              return query;
            },
            gte: (col, val) => {
              filters.push(p => p[col] >= val);
              return query;
            },
            lte: (col, val) => {
              filters.push(p => p[col] <= val);
              return query;
            },
            order: (col, opts) => {
              return query;
            },
            single: async () => {
              const all = Array.from(mockPayments.values()).filter(p => filters.every(f => f(p)));
              if (all.length) return { data: { ...all[0] }, error: null };
              return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
            },
            maybeSingle: async () => {
              const all = Array.from(mockPayments.values()).filter(p => filters.every(f => f(p)));
              return { data: all.length ? { ...all[0] } : null, error: null };
            },
            then: (resolve, reject) => {
              const all = Array.from(mockPayments.values()).filter(p => filters.every(f => f(p))).map(p => ({ ...p }));
              return Promise.resolve({ data: all, error: null }).then(resolve, reject);
            }
          };
          return query;
        };

        return {
          select: (cols) => createQuery(),
          insert: (rows) => {
            for (const r of rows) {
              mockPayments.set(r.id, { ...r });
            }
            return {
              select: () => ({
                single: async () => ({ data: { ...rows[0] }, error: null })
              })
            };
          },
          update: (updates) => ({
            eq: (col, val) => ({
              select: () => ({
                single: async () => {
                  const existing = mockPayments.get(val);
                  if (existing) {
                    Object.assign(existing, updates);
                    return { data: { ...existing }, error: null };
                  }
                  return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                }
              })
            })
          })
        };
      }

      if (table === 'payment_reconciliation_audit') {
        return {
          insert: (rows) => {
            mockAudit.push(...rows);
            return Promise.resolve({ data: rows, error: null });
          }
        };
      }

      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: null, error: null })
          }),
          order: () => Promise.resolve({ data: [], error: null })
        }),
        insert: (rows) => ({
          select: () => ({
            single: async () => ({ data: rows[0], error: null })
          })
        }),
        update: (updates) => ({
          eq: (col, val) => ({
            select: () => ({
              single: async () => ({ data: { id: val, ...updates }, error: null })
            })
          })
        })
      };
    }
  };
}

const mockClient = createMockSupabaseClient();
db.setClient(mockClient);
app.setDependencies(mockClient, mockClient);

// Seed mock itineraries
mockItineraries.set('CMP-2026-772956', {
  id: 'itinerary-1',
  quote_id: 'CMP-2026-772956',
  status: 'Confirmed',
  owner_id: SALES_USER.id,
  version: 1,
  guest_name: 'Arham Fahmi',
  title: 'Bali Luxury Experience',
  total_amount: 150000,
  content: {
    id: 'CMP-2026-772956',
    guest: 'Arham Fahmi',
    title: 'Bali Luxury Experience',
    baseCost: 150000
  }
});

mockItineraries.set('CMP-2026-883000', {
  id: 'itinerary-2',
  quote_id: 'CMP-2026-883000',
  status: 'Draft',
  owner_id: OTHER_SALES_USER.id,
  version: 1,
  guest_name: 'Other Guest',
  title: 'Kerala Backwaters',
  total_amount: 80000,
  content: {
    id: 'CMP-2026-883000',
    guest: 'Other Guest',
    title: 'Kerala Backwaters',
    baseCost: 80000
  }
});

(async () => {
  // Clear any existing payments in test harness
  payments._resetLocalPaymentsForTesting([]);

  // 1. Narration Generator: Customer Receipt
  await test('Generates standard customer receipt narration', () => {
    const nar = payments.generatePaymentNarration({
      transactionType: 'customer_receipt',
      quotationId: 'CMP-2026-772956',
      customerName: 'Arham Fahmi',
      purpose: 'Advance',
      destination: 'Bali Package'
    });
    assert.strictEqual(nar, 'Receipt | CMP-2026-772956 | Arham Fahmi | Advance | Bali Package');
  });

  // 2. Narration Generator: Supplier Payment
  await test('Generates standard supplier payment narration', () => {
    const nar = payments.generatePaymentNarration({
      transactionType: 'supplier_payment',
      quotationId: 'CMP-2026-772956',
      supplierName: 'Kuwarasan A Pramana',
      purpose: 'Hotel Advance',
      destination: 'Bali'
    });
    assert.strictEqual(nar, 'Hotel Advance | CMP-2026-772956 | Kuwarasan A Pramana | Bali');
  });

  // 3. Narration Generator: Customer Refund
  await test('Generates standard customer refund narration', () => {
    const nar = payments.generatePaymentNarration({
      transactionType: 'customer_refund',
      quotationId: 'CMP-2026-772956',
      customerName: 'Arham Fahmi'
    });
    assert.strictEqual(nar, 'Refund | CMP-2026-772956 | Arham Fahmi');
  });

  // 4. Narration Generator: Processing Fee
  await test('Generates standard processing fee narration', () => {
    const nar = payments.generatePaymentNarration({
      transactionType: 'processing_fee',
      quotationId: 'CMP-2026-772956',
      provider: 'Razorpay'
    });
    assert.strictEqual(nar, 'Payment Fee | CMP-2026-772956 | Razorpay');
  });

  // 5. Narration Validation: Blocks passwords / CVVs
  await test('Rejects narration containing sensitive credentials or CVVs', () => {
    assert.throws(() => {
      payments.validateNarration('Payment with CVV 123');
    }, /Security violation/);

    assert.throws(() => {
      payments.validateNarration('Secret password in narration');
    }, /Security violation/);
  });

  // 6. ADMIN can record customer receipt via POST /api/payments
  let createdReceiptId = null;
  await test('ADMIN can record customer receipt with automatic narration and fee estimate', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer admin-token')
      .send({
        quotation_id: 'CMP-2026-772956',
        direction: 'inbound',
        transaction_type: 'customer_receipt',
        payment_method: 'credit_card',
        provider: 'Razorpay',
        amount: 50000,
        transaction_reference: 'UTR1002938475',
        customer_name: 'Arham Fahmi',
        payment_purpose: 'Advance',
        destination: 'Bali Package',
        transaction_date: '2026-10-23'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.payment.narration, 'Receipt | CMP-2026-772956 | Arham Fahmi | Advance | Bali Package');
    // Credit card fee estimate on 50000: 2% + 18% GST = 1180
    assert.strictEqual(res.body.payment.estimated_fee, 1180);
    assert.strictEqual(res.body.payment.reconciliation_status, 'Unmatched');
    createdReceiptId = res.body.payment.id;
  });

  // 7. SALES can record customer receipt on their own itinerary
  await test('SALES can record customer receipt on own itinerary', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer sales-token')
      .send({
        quotation_id: 'CMP-2026-772956',
        direction: 'inbound',
        transaction_type: 'customer_receipt',
        payment_method: 'upi',
        provider: 'IDFC First Bank',
        amount: 25000,
        transaction_reference: 'UPI9876543210',
        customer_name: 'Arham Fahmi',
        payment_purpose: 'Part Advance',
        transaction_date: '2026-10-23'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.payment.estimated_fee, 0); // direct UPI is 0% MDR
  });

  // 8. SALES is blocked from recording payment on another agent's itinerary (403)
  await test('SALES is blocked from recording payment on another sales user itinerary', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer sales-token')
      .send({
        quotation_id: 'CMP-2026-883000', // owned by OTHER_SALES_USER
        direction: 'inbound',
        transaction_type: 'customer_receipt',
        amount: 10000
      });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
  });

  // 9. SALES is blocked from recording supplier payments or refunds (403)
  await test('SALES is blocked from recording outbound supplier payments', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer sales-token')
      .send({
        quotation_id: 'CMP-2026-772956',
        direction: 'outbound',
        transaction_type: 'supplier_payment',
        amount: 20000
      });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
  });

  // 10. OPS can record supplier payment via POST /api/payments
  let supplierPaymentId = null;
  await test('OPS can record outbound supplier hotel advance', async () => {
    const res = await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer ops-token')
      .send({
        quotation_id: 'CMP-2026-772956',
        direction: 'outbound',
        transaction_type: 'supplier_payment',
        payment_method: 'bank_transfer',
        provider: 'IDFC First Bank',
        amount: 30000,
        transaction_reference: 'NEFT55443322',
        supplier_name: 'Kuwarasan A Pramana',
        payment_purpose: 'Hotel Advance',
        destination: 'Bali',
        transaction_date: '2026-10-23'
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.payment.narration, 'Hotel Advance | CMP-2026-772956 | Kuwarasan A Pramana | Bali');
    supplierPaymentId = res.body.payment.id;
  });

  // 11. Bank Reconciliation: Unmatched -> Reconciled when statement matches
  await test('ADMIN can reconcile payment against bank statement with matching settlement amount', async () => {
    // Expected net settlement = 50000 - 1180 actual fee = 48820
    const res = await request(app)
      .post(`/api/payments/${createdReceiptId}/reconcile`)
      .set('Authorization', 'Bearer admin-token')
      .send({
        statementReference: 'STMT-2026-OCT-998877',
        statementAmount: 48820.00,
        statementDate: '2026-10-24',
        actualFee: 1180.00,
        reconciliationNotes: 'Matched against IDFC First Bank current account settlement batch.'
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.isMatch, true);
    assert.strictEqual(res.body.payment.reconciliation_status, 'Reconciled');
    assert.strictEqual(res.body.payment.statement_amount, 48820.00);
  });

  // 12. Bank Reconciliation: Flags Mismatched when statement amount differs
  await test('Reconciliation flags Mismatched when statement amount has a discrepancy', async () => {
    // Supplier payment was 30000, but statement has 28500
    const res = await request(app)
      .post(`/api/payments/${supplierPaymentId}/reconcile`)
      .set('Authorization', 'Bearer ops-token')
      .send({
        statementReference: 'STMT-DISCREPANCY-01',
        statementAmount: 28500.00,
        statementDate: '2026-10-24',
        reconciliationNotes: 'Bank debited ₹1,500 less than requested invoice amount; pending investigation.'
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.isMatch, false);
    assert.strictEqual(res.body.payment.reconciliation_status, 'Mismatched');
    assert.strictEqual(res.body.discrepancy, 1500.00);
  });

  // 13. Duplicate Detection: Flags duplicate UTR reference
  await test('Duplicate detection identifies duplicate transaction references (UTRs)', async () => {
    // Record another payment with identical UTR1002938475
    await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer admin-token')
      .send({
        quotation_id: 'CMP-2026-772956',
        direction: 'inbound',
        transaction_type: 'customer_receipt',
        amount: 50000,
        transaction_reference: 'UTR1002938475',
        customer_name: 'Arham Fahmi'
      });

    const dupRes = await request(app)
      .get('/api/payments/duplicates')
      .set('Authorization', 'Bearer admin-token');

    assert.strictEqual(dupRes.status, 200);
    assert.strictEqual(dupRes.body.success, true);
    const hasUtrDup = dupRes.body.duplicates.some(d => d.reference === 'UTR1002938475');
    assert.strictEqual(hasUtrDup, true);
  });

  // 14. List Payments with filters
  await test('GET /api/payments supports filtering by quote ID and status', async () => {
    const res = await request(app)
      .get('/api/payments?quotation_id=CMP-2026-772956')
      .set('Authorization', 'Bearer admin-token');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert(res.body.data.length >= 3);
  });

  // 15. Financial Summary endpoint
  await test('GET /api/payments/summary/:quoteId returns comprehensive financial reconciliation', async () => {
    const res = await request(app)
      .get('/api/payments/summary/CMP-2026-772956')
      .set('Authorization', 'Bearer admin-token');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.quotation_id, 'CMP-2026-772956');
    assert(res.body.financials.gross_customer_receipts > 0);
  });

  // 16. Fee estimation endpoint without saving
  await test('POST /api/payments/fee-estimate returns estimated fee structure', async () => {
    const res = await request(app)
      .post('/api/payments/fee-estimate')
      .set('Authorization', 'Bearer sales-token')
      .send({
        amount: 80000,
        paymentMethod: 'credit_card',
        provider: 'Razorpay',
        category: 'domestic'
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.estimate.estimated_fee, 1888); // 80000 * 2.36% = 1888
  });

  // 17. Local JSON fallback is strictly prohibited on Vercel or Production
  await test('Local JSON fallback is strictly prohibited on Vercel or in Production', async () => {
    const origVercel = process.env.VERCEL;
    const origNodeEnv = process.env.NODE_ENV;

    try {
      process.env.VERCEL = '1';
      assert.strictEqual(payments.isLocalFallbackPermitted(), false, 'Must be false when VERCEL is set');

      delete process.env.VERCEL;
      process.env.NODE_ENV = 'production';
      assert.strictEqual(payments.isLocalFallbackPermitted(), false, 'Must be false when NODE_ENV=production');
    } finally {
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
      if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
      else delete process.env.NODE_ENV;
    }
  });

  // 18. Missing Migration v6 in deployed environment returns HTTP 503 with migration guidance
  await test('POST /api/payments returns 503 when Migration v6 is missing in deployed environment', async () => {
    const origVercel = process.env.VERCEL;
    process.env.VERCEL = '1';

    // Create a mock client where payments table does not exist (error 42P01)
    const missingMigrationClient = {
      ...mockClient,
      from: (tbl) => {
        if (tbl === 'payments' || tbl === 'payment_reconciliation_audit') {
          return {
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '42P01', message: 'relation "payments" does not exist' }
                })
              })
            }),
            select: () => ({
              order: async () => ({
                data: null,
                error: { code: '42P01', message: 'relation "payments" does not exist' }
              }),
              eq: () => ({
                maybeSingle: async () => ({
                  data: null,
                  error: { code: '42P01', message: 'relation "payments" does not exist' }
                })
              })
            })
          };
        }
        return mockClient.from(tbl);
      }
    };

    app.setDependencies(missingMigrationClient, missingMigrationClient);

    try {
      const res = await request(app)
        .post('/api/payments')
        .set('Authorization', 'Bearer admin-token')
        .send({
          quotation_id: 'CMP-2026-772956',
          amount: 50000,
          payment_method: 'upi',
          transaction_reference: 'UTR-FAIL-CLOSED-TEST'
        });

      assert.strictEqual(res.status, 503, 'Must return HTTP 503 when storage is unavailable');
      assert.strictEqual(res.body.success, false);
      assert.ok(
        res.body.error.includes('Required database migration (v6_payments_and_reconciliation) is not installed'),
        `Error must mention migration v6, got: ${res.body.error}`
      );
      assert.ok(
        ['STORAGE_UNAVAILABLE', 'MIGRATION_MISSING'].includes(res.body.code),
        `Error code must indicate storage or migration failure, got: ${res.body.code}`
      );
    } finally {
      app.setDependencies(mockClient, mockClient);
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
    }
  });

  // 19. Reconciliation returns 503 when audit table is missing in deployed environment
  await test('POST /api/payments/:id/reconcile returns 503 when audit migration is missing in deployed mode', async () => {
    const origVercel = process.env.VERCEL;
    process.env.VERCEL = '1';

    // Client where atomic RPC fails because audit table or function is missing
    const auditFailingClient = {
      ...mockClient,
      rpc: async (fnName, params) => {
        if (fnName === 'reconcile_payment_atomic') {
          return {
            data: null,
            error: { code: '42P01', message: 'relation "payment_reconciliation_audit" does not exist' }
          };
        }
        return mockClient.rpc(fnName, params);
      }
    };

    app.setDependencies(auditFailingClient, auditFailingClient);

    try {
      // Find an existing recorded payment ID
      const firstPaymentId = Array.from(mockPayments.keys())[0];
      const res = await request(app)
        .post(`/api/payments/${firstPaymentId}/reconcile`)
        .set('Authorization', 'Bearer admin-token')
        .send({
          statementReference: 'UTR-FAIL-AUDIT',
          statementAmount: 50000
        });

      assert.strictEqual(res.status, 503, 'Must return 503 when durable audit write fails');
      assert.strictEqual(res.body.success, false);
      assert.ok(
        res.body.error.includes('Required database migration (v6_payments_and_reconciliation) is not installed'),
        `Error should mention migration, got: ${res.body.error}`
      );
    } finally {
      app.setDependencies(mockClient, mockClient);
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
    }
  });

  // 20. GET /api/payments returns 503 when payments table is missing in deployed mode
  await test('GET /api/payments returns 503 when payments table is missing in deployed mode', async () => {
    const origVercel = process.env.VERCEL;
    process.env.VERCEL = '1';

    const missingClient = {
      ...mockClient,
      from: (tbl) => {
        if (tbl === 'payments') {
          return {
            select: () => ({
              order: async () => ({
                data: null,
                error: { code: '42P01', message: 'relation "payments" does not exist' }
              })
            })
          };
        }
        return mockClient.from(tbl);
      }
    };

    app.setDependencies(missingClient, missingClient);

    try {
      const res = await request(app)
        .get('/api/payments')
        .set('Authorization', 'Bearer admin-token');

      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('Required database migration'));
    } finally {
      app.setDependencies(mockClient, mockClient);
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
    }
  });

  // 21. Reconciling a non-existent payment returns HTTP 404
  await test('POST /api/payments/:id/reconcile returns 404 for non-existent payment ID', async () => {
    const res = await request(app)
      .post('/api/payments/PAY-DOES-NOT-EXIST-9999/reconcile')
      .set('Authorization', 'Bearer admin-token')
      .send({
        statementReference: 'UTR-TEST-404',
        statementAmount: 50000
      });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes('not found'));
  });

  // 22. Payment reconciliation updates payment and inserts audit atomically via single database RPC
  await test('Atomic reconciliation updates payment and inserts audit in single database transaction', async () => {
    // Record a fresh payment for atomic test
    const recordRes = await request(app)
      .post('/api/payments')
      .set('Authorization', 'Bearer admin-token')
      .send({
        quotation_id: 'CMP-2026-772956',
        direction: 'inbound',
        transaction_type: 'customer_receipt',
        amount: 25000,
        payment_method: 'upi',
        transaction_reference: 'UTR-ATOMIC-TEST-1',
        customer_name: 'Atomic Test Guest'
      });

    assert.strictEqual(recordRes.status, 201);
    const payId = recordRes.body.payment.id;
    const initialAuditCount = mockAudit.length;

    // Track RPC invocation
    let rpcCalled = false;
    let rpcFunction = null;
    let rpcParams = null;

    const atomicSpyClient = {
      ...mockClient,
      rpc: async (fnName, params) => {
        rpcCalled = true;
        rpcFunction = fnName;
        rpcParams = params;
        return mockClient.rpc(fnName, params);
      }
    };

    app.setDependencies(atomicSpyClient, atomicSpyClient);

    try {
      const recRes = await request(app)
        .post(`/api/payments/${payId}/reconcile`)
        .set('Authorization', 'Bearer admin-token')
        .send({
          statementReference: 'STMT-REF-ATOMIC-01',
          statementAmount: 25000,
          actualFee: 0,
          reconciliationNotes: 'Verified via bank UTR report'
        });

      assert.strictEqual(recRes.status, 200);
      assert.strictEqual(recRes.body.success, true);
      assert.strictEqual(rpcCalled, true, 'reconcile_payment_atomic RPC must be invoked');
      assert.strictEqual(rpcFunction, 'reconcile_payment_atomic');
      assert.strictEqual(rpcParams.p_payment_id, payId);
      assert.strictEqual(rpcParams.p_statement_reference, 'STMT-REF-ATOMIC-01');
      assert.strictEqual(recRes.body.payment.reconciliation_status, 'Reconciled');
      assert.strictEqual(recRes.body.isMatch, true);
      assert.strictEqual(mockAudit.length, initialAuditCount + 1, 'Exactly one audit record created');
      const latestAudit = mockAudit[mockAudit.length - 1];
      assert.strictEqual(latestAudit.payment_id, payId);
      assert.strictEqual(latestAudit.new_status, 'Reconciled');
    } finally {
      app.setDependencies(mockClient, mockClient);
    }
  });

  // 23. Atomic reconciliation failure rolls back transaction without orphaned state
  await test('Atomic reconciliation failure rolls back cleanly without writing partial state', async () => {
    const payId = Array.from(mockPayments.keys())[0];
    const originalPayment = { ...mockPayments.get(payId) };
    const originalAuditLen = mockAudit.length;

    // Simulate database failure during atomic RPC execution (e.g. statement lock timeout)
    const failingRpcClient = {
      ...mockClient,
      rpc: async (fnName, params) => {
        if (fnName === 'reconcile_payment_atomic') {
          return { data: null, error: { message: 'Database transaction aborted: serialization failure' } };
        }
        return mockClient.rpc(fnName, params);
      }
    };

    const origVercel = process.env.VERCEL;
    process.env.VERCEL = '1';
    app.setDependencies(failingRpcClient, failingRpcClient);

    try {
      const failRes = await request(app)
        .post(`/api/payments/${payId}/reconcile`)
        .set('Authorization', 'Bearer admin-token')
        .send({
          statementReference: 'STMT-FAIL-ROLLBACK',
          statementAmount: 50000
        });

      assert.strictEqual(failRes.status, 503, 'Must return 503 on database transaction failure');
      assert.strictEqual(failRes.body.success, false);

      // Verify payment in storage is NOT modified
      const currentPayment = mockPayments.get(payId);
      assert.strictEqual(currentPayment.statement_reference, originalPayment.statement_reference);
      assert.strictEqual(currentPayment.reconciliation_status, originalPayment.reconciliation_status);

      // Verify NO orphaned audit record was added
      assert.strictEqual(mockAudit.length, originalAuditLen, 'No partial audit record permitted');
    } finally {
      app.setDependencies(mockClient, mockClient);
      if (origVercel !== undefined) process.env.VERCEL = origVercel;
      else delete process.env.VERCEL;
    }
  });

  // 24. Protect audit history: Foreign key must use ON DELETE RESTRICT and never CASCADE
  await test('Migration v6 enforces ON DELETE RESTRICT on audit foreign key and forbids ON DELETE CASCADE', async () => {
    const fs = require('fs');
    const path = require('path');
    const sqlPath = path.join(__dirname, '../supabase_migration_v6_payments_and_reconciliation.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Must NOT contain ON DELETE CASCADE
    assert.strictEqual(
      sql.includes('ON DELETE CASCADE'),
      false,
      'Migration v6 must NOT contain ON DELETE CASCADE for payments or audit history'
    );

    // Must contain ON DELETE RESTRICT
    assert.ok(
      sql.includes('ON DELETE RESTRICT'),
      'Migration v6 must enforce ON DELETE RESTRICT on payment_reconciliation_audit.payment_id'
    );

    // Verify simulation: attempting to delete payment with existing audit history fails with restriction error
    const payId = Array.from(mockPayments.keys())[0];
    const hasAudit = mockAudit.some(a => a.payment_id === payId);
    assert.ok(hasAudit, 'Target payment has audit history');

    // Attempting deletion on payment with audit records must be restricted
    const deleteRestricted = (targetPaymentId) => {
      const auditExists = mockAudit.some(a => a.payment_id === targetPaymentId);
      if (auditExists) {
        const err = new Error('update or delete on table "payments" violates foreign key constraint "payment_reconciliation_audit_payment_id_fkey" on table "payment_reconciliation_audit" - Key is still referenced from table "payment_reconciliation_audit".');
        err.code = '23503';
        throw err;
      }
      mockPayments.delete(targetPaymentId);
    };

    assert.throws(() => {
      deleteRestricted(payId);
    }, /violates foreign key constraint.*referenced from table "payment_reconciliation_audit"/);

    // Confirm payment and audit still intact
    assert.ok(mockPayments.has(payId), 'Payment must not be deleted');
    assert.ok(mockAudit.some(a => a.payment_id === payId), 'Audit history must remain intact');
  });

  // 25. Verify RPC permissions and search_path in Migration v6
  await test('reconcile_payment_atomic RPC restricts execute to service_role with safe search_path and revokes from public/anon/authenticated', async () => {
    const fs = require('fs');
    const path = require('path');
    const sqlPath = path.join(__dirname, '../supabase_migration_v6_payments_and_reconciliation.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // 1. Safe search_path
    assert.ok(
      sql.includes('SET search_path = pg_catalog, pg_temp'),
      'reconcile_payment_atomic must use SET search_path = pg_catalog, pg_temp'
    );

    // 2. SECURITY DEFINER
    assert.ok(
      sql.includes('SECURITY DEFINER'),
      'reconcile_payment_atomic must be SECURITY DEFINER'
    );

    // 3. Explicit revocation from PUBLIC, anon, authenticated
    assert.ok(
      /REVOKE ALL ON FUNCTION public\.reconcile_payment_atomic.*FROM PUBLIC, anon, authenticated;/s.test(sql),
      'Must explicitly revoke execute on reconcile_payment_atomic from PUBLIC, anon, authenticated'
    );

    // 4. Grant execute exclusively to service_role
    assert.ok(
      /GRANT EXECUTE ON FUNCTION public\.reconcile_payment_atomic.*TO service_role;/s.test(sql),
      'Must grant execute on reconcile_payment_atomic exclusively to service_role'
    );
  });

  console.log(`\n========================================`);
  console.log(`SUMMARY: ${passCount} / ${totalCount} payments & reconciliation tests passed.`);
  console.log(`========================================\n`);
})();
