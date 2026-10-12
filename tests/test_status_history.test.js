const assert = require('assert');
const db = require('../api/db.js');

async function runTests() {
    console.log("=== RUNNING STATUS HISTORY REGRESSION TESTS ===");
    console.log("Note: Mocked tests verify application logic, parameter contracts, role checks, and atomic RPC simulation.");
    console.log("Live PostgreSQL transaction atomicity remains pending manual migration execution on staging/production.\n");
    
    let passed = 0;
    let total = 0;

    async function test(desc, fn) {
        total++;
        try {
            await fn();
            console.log(`✅ [PASS] ${total}. ${desc}`);
            passed++;
        } catch (e) {
            console.error(`❌ [FAIL] ${total}. ${desc}`);
            console.error("   Error:", e.message);
            throw e;
        }
    }

    // In-memory mock database state
    let mockItineraries = [];
    let mockStatusHistory = [];
    let simulateAuditError = false;
    let simulateRpcMissing = false;
    let rpcCallCount = 0;

    // Build mock Supabase client simulating atomic PostgreSQL RPC and fallback table queries
    const mockSupabase = {
        rpc: async (fnName, params) => {
            rpcCallCount++;
            if (simulateRpcMissing) {
                return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${fnName}` } };
            }

            if (fnName === 'update_itinerary_status_atomic') {
                const existing = mockItineraries.find(i => i.quote_id === params.p_quote_id);
                if (!existing) {
                    return { data: null, error: new Error('ITINERARY_NOT_FOUND') };
                }
                if (existing.version !== params.p_current_version) {
                    return { data: null, error: new Error('CONCURRENCY_CONFLICT: Version mismatch') };
                }

                // If transaction fails during status_history insert:
                if (simulateAuditError) {
                    // In a PostgreSQL transaction, an exception in status_history aborts the ENTIRE transaction.
                    // The update to itineraries is NEVER committed.
                    return {
                        data: null,
                        error: new Error('status_history constraint violation: transaction aborted and rolled back')
                    };
                }

                const oldStatus = existing.status;
                const newStatus = params.p_status;
                const isStatusChange = oldStatus !== newStatus;

                // Atomic transaction commit: update itinerary record
                existing.status = newStatus;
                existing.is_voucher_mode = params.p_is_voucher_mode;
                existing.guest_name = params.p_guest_name;
                existing.title = params.p_title;
                existing.start_date = params.p_start_date;
                existing.end_date = params.p_end_date;
                existing.guest_count = params.p_guest_count;
                existing.total_amount = params.p_total_amount;
                existing.currency = params.p_currency;
                existing.content = params.p_content;
                existing.version = existing.version + 1;
                existing.updated_at = new Date().toISOString();

                // Single authoritative insert into status_history ONLY on genuine change
                if (isStatusChange) {
                    mockStatusHistory.push({
                        id: 'hist_' + (mockStatusHistory.length + 1),
                        itinerary_id: existing.id,
                        user_id: params.p_user_id, // Explicit verified actor ID passed into RPC
                        old_status: oldStatus,
                        new_status: newStatus,
                        created_at: new Date().toISOString()
                    });
                }

                return { data: { ...existing }, error: null };
            }

            if (fnName === 'change_itinerary_status_atomic') {
                const existing = mockItineraries.find(i => i.quote_id === params.p_quote_id);
                if (!existing) {
                    return { data: null, error: new Error('ITINERARY_NOT_FOUND') };
                }

                if (existing.version !== params.p_current_version) {
                    return { data: null, error: new Error('CONCURRENCY_CONFLICT: Version mismatch') };
                }

                // Idempotent no-op if status is unchanged with valid current version
                if (existing.status === params.p_new_status) {
                    return { data: { ...existing }, error: null };
                }

                if (simulateAuditError) {
                    return {
                        data: null,
                        error: new Error('status_history constraint violation: transaction aborted and rolled back')
                    };
                }

                const oldStatus = existing.status;
                existing.status = params.p_new_status;
                existing.version = existing.version + 1;
                existing.updated_at = new Date().toISOString();

                mockStatusHistory.push({
                    id: 'hist_' + (mockStatusHistory.length + 1),
                    itinerary_id: existing.id,
                    user_id: params.p_user_id,
                    old_status: oldStatus,
                    new_status: params.p_new_status,
                    created_at: new Date().toISOString()
                });

                return { data: { ...existing }, error: null };
            }

            return { data: null, error: { code: 'PGRST202', message: `Could not find the function ${fnName}` } };
        },

        from: (tableName) => {
            if (tableName === 'itineraries') {
                return {
                    select: (cols) => {
                        return {
                            eq: (col, val) => {
                                return {
                                    single: async () => {
                                        const found = mockItineraries.find(i => i[col] === val);
                                        if (found) return { data: { ...found }, error: null };
                                        return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                    }
                                };
                            }
                        };
                    },
                    update: (updates) => {
                        return {
                            eq: (col1, val1) => {
                                return {
                                    eq: (col2, val2) => {
                                        const executeUpdate = () => {
                                            const idx = mockItineraries.findIndex(i => i[col1] === val1 && i[col2] === val2);
                                            if (idx === -1) {
                                                return { data: null, error: new Error("Concurrency Conflict: version mismatch") };
                                            }
                                            mockItineraries[idx] = { ...mockItineraries[idx], ...updates };
                                            return { data: { ...mockItineraries[idx] }, error: null };
                                        };
                                        return {
                                            then: (resolve, reject) => {
                                                const res = executeUpdate();
                                                return Promise.resolve(res).then(resolve, reject);
                                            },
                                            select: () => ({
                                                single: async () => executeUpdate()
                                            })
                                        };
                                    }
                                };
                            }
                        };
                    }
                };
            }
            if (tableName === 'status_history') {
                return {
                    insert: async (rows) => {
                        if (simulateAuditError) {
                            return { data: null, error: new Error("Simulated database constraint failure on status_history insert") };
                        }
                        for (const row of rows) {
                            mockStatusHistory.push({
                                id: 'hist_' + (mockStatusHistory.length + 1),
                                ...row
                            });
                        }
                        return { data: rows, error: null };
                    }
                };
            }
            throw new Error(`Unknown table in mock: ${tableName}`);
        }
    };

    // Inject mock client into db layer
    db.setClient(mockSupabase);

    const testAdmin = { id: 'admin-uuid-001' };
    const testSales1 = { id: 'sales-uuid-001' };
    const testSales2 = { id: 'sales-uuid-002' };
    const testOps = { id: 'ops-uuid-001' };

    function createValidPayload(id, status, guest = "John Doe", title = "Bali Trip") {
        return {
            id: id,
            title: title,
            guest: guest,
            start: "2026-10-10",
            end: "2026-10-14",
            adults: 2,
            baseCost: 1000,
            status: status,
            days: [
                { title: "Day 1" },
                { title: "Day 2" },
                { title: "Day 3" },
                { title: "Day 4" },
                { title: "Day 5" }
            ],
            hotels: [
                { name: "Hotel A", nights: 4 }
            ]
        };
    }

    // Setup initial test records
    function resetDb() {
        mockItineraries = [
            {
                id: 'itin-uuid-001',
                quote_id: 'QUOTE-001',
                owner_id: 'sales-uuid-001',
                status: 'Draft',
                is_voucher_mode: false,
                guest_name: 'John Doe',
                title: 'Bali Trip',
                start_date: '2026-10-10',
                end_date: '2026-10-14',
                guest_count: 2,
                total_amount: 1000,
                currency: 'USD',
                content: createValidPayload('QUOTE-001', 'Draft'),
                version: 1,
                updated_at: new Date('2026-10-10T10:00:00Z').toISOString()
            },
            {
                id: 'itin-uuid-002',
                quote_id: 'QUOTE-002',
                owner_id: null, // Legacy unassigned
                status: 'Draft',
                is_voucher_mode: false,
                guest_name: 'Jane Doe',
                title: 'Kerala Trip',
                start_date: '2026-10-10',
                end_date: '2026-10-14',
                guest_count: 2,
                total_amount: 2000,
                currency: 'USD',
                content: createValidPayload('QUOTE-002', 'Draft', 'Jane Doe', 'Kerala Trip'),
                version: 1,
                updated_at: new Date('2026-10-10T10:00:00Z').toISOString()
            }
        ];
        mockStatusHistory = [];
        simulateAuditError = false;
        simulateRpcMissing = false;
        rpcCallCount = 0;
    }

    // --- TEST 1: Exactly one history record per successful status transition with verified actor ---
    await test("Draft → Requested records exactly one transition with authenticated actor", async () => {
        resetDb();
        const payload = createValidPayload('QUOTE-001', 'Requested');

        const updated = await db.updateItinerary('QUOTE-001', payload, 1, testSales1, 'SALES');
        assert.strictEqual(updated.status, 'Requested', 'Itinerary status should be updated to Requested');
        assert.strictEqual(updated.version, 2, 'Version should increment to 2');

        assert.strictEqual(mockStatusHistory.length, 1, 'Exactly one status_history record should be created');
        const entry = mockStatusHistory[0];
        assert.strictEqual(entry.itinerary_id, 'itin-uuid-001', 'Must record correct itinerary UUID');
        assert.strictEqual(entry.user_id, 'sales-uuid-001', 'Must record verified acting user ID from server auth');
        assert.strictEqual(entry.old_status, 'Draft', 'Previous status must be Draft');
        assert.strictEqual(entry.new_status, 'Requested', 'New status must be Requested');
        assert.ok(entry.created_at, 'Must have transition timestamp');
    });

    // --- TEST 2: Updating other itinerary fields without status change does NOT create false transition ---
    await test("Updating other itinerary fields without status change creates zero audit records", async () => {
        resetDb();
        // First transition to Requested
        await db.updateItinerary('QUOTE-001', createValidPayload('QUOTE-001', 'Requested'), 1, testSales1, 'SALES');
        assert.strictEqual(mockStatusHistory.length, 1, 'Initial transition recorded');

        // Now update only guest name and title; status remains Requested
        const payload = createValidPayload('QUOTE-001', 'Requested', 'John Doe Modified', 'Bali Trip Extended');

        const updated2 = await db.updateItinerary('QUOTE-001', payload, 2, testSales1, 'SALES');
        assert.strictEqual(updated2.guest_name, 'John Doe Modified');
        assert.strictEqual(updated2.version, 3);
        assert.strictEqual(updated2.status, 'Requested');

        // Status history count MUST STILL BE 1 (no false transition)
        assert.strictEqual(mockStatusHistory.length, 1, 'Zero new audit rows created when status did not change');
    });

    // --- TEST 3: Failed or stale-version update does not create an audit record ---
    await test("Failed or stale-version update creates zero audit records", async () => {
        resetDb();
        const payload = createValidPayload('QUOTE-001', 'Requested');

        // Try to update with stale version 999
        let errorThrown = false;
        try {
            await db.updateItinerary('QUOTE-001', payload, 999, testSales1, 'SALES');
        } catch (err) {
            errorThrown = true;
            assert.ok(err.message.includes('Concurrency Conflict'), 'Should throw Concurrency Conflict error');
        }
        assert.ok(errorThrown, 'Expected error on stale version');

        // Verify status_history has 0 entries
        assert.strictEqual(mockStatusHistory.length, 0, 'No audit row created on stale update failure');

        // Verify itinerary was untouched
        const current = mockItineraries.find(i => i.quote_id === 'QUOTE-001');
        assert.strictEqual(current.status, 'Draft', 'Itinerary status remains Draft');
        assert.strictEqual(current.version, 1, 'Itinerary version remains 1');
    });

    // --- TEST 4: Transaction atomicity: audit failure aborts itinerary update entirely ---
    await test("Transactional atomicity: itinerary update and audit record cannot commit independently", async () => {
        resetDb();
        simulateAuditError = true; // Force transaction abort on audit write

        const payload = createValidPayload('QUOTE-001', 'Requested');

        let auditErrorCaught = false;
        try {
            await db.updateItinerary('QUOTE-001', payload, 1, testSales1, 'SALES');
        } catch (err) {
            auditErrorCaught = true;
            assert.ok(err.message.includes('Audit log failure'), 'Should throw Audit log failure');
        }
        assert.ok(auditErrorCaught, 'Expected failure due to audit write failure');

        // Check that the itinerary was never committed to Requested!
        const current = mockItineraries.find(i => i.quote_id === 'QUOTE-001');
        assert.strictEqual(current.status, 'Draft', 'Itinerary update aborted: status remains Draft');
        assert.strictEqual(current.version, 1, 'Itinerary version remains 1 (uncommitted)');
        assert.strictEqual(mockStatusHistory.length, 0, 'Zero audit rows committed');
    });

    // --- TEST 5: Unauthorized roles cannot bypass existing status permissions ---
    await test("Unauthorized roles cannot bypass status permissions or create audit records", async () => {
        resetDb();
        const payload = createValidPayload('QUOTE-001', 'Requested');

        // 5a. OPS cannot edit or transition status directly via saveItinerary
        let opsBlocked = false;
        try {
            await db.updateItinerary('QUOTE-001', payload, 1, testOps, 'OPS');
        } catch (err) {
            opsBlocked = true;
            assert.ok(err.message.includes('Ops/Unauthorized cannot edit'), 'Ops edit blocked message');
        }
        assert.ok(opsBlocked, 'OPS role must be blocked from updating status');

        // 5b. SALES rep 2 cannot edit SALES rep 1's itinerary
        let crossSalesBlocked = false;
        try {
            await db.updateItinerary('QUOTE-001', payload, 1, testSales2, 'SALES');
        } catch (err) {
            crossSalesBlocked = true;
            assert.ok(err.message.includes('Sales can only edit their own'), 'Cross-sales blocked message');
        }
        assert.ok(crossSalesBlocked, 'Cross-sales tampering must be blocked');

        // 5c. SALES rep cannot edit unassigned legacy record
        let legacyBlocked = false;
        try {
            await db.updateItinerary('QUOTE-002', createValidPayload('QUOTE-002', 'Requested', 'Jane Doe', 'Kerala Trip'), 1, testSales1, 'SALES');
        } catch (err) {
            legacyBlocked = true;
            assert.ok(err.message.includes('Legacy unassigned records'), 'Legacy unassigned blocked message');
        }
        assert.ok(legacyBlocked, 'Sales cannot edit unassigned legacy record');

        // Status history must have 0 rows
        assert.strictEqual(mockStatusHistory.length, 0, 'Zero status history created from unauthorized attempts');
    });

    // --- TEST 6: Repeated requests do not produce duplicate history entries for same unchanged status ---
    await test("Repeated requests do not produce duplicate history entries for unchanged status", async () => {
        resetDb();
        const payload = createValidPayload('QUOTE-001', 'Requested');

        // Request 1: Draft -> Requested (transition)
        const res1 = await db.updateItinerary('QUOTE-001', payload, 1, testSales1, 'SALES');
        assert.strictEqual(res1.status, 'Requested');
        assert.strictEqual(mockStatusHistory.length, 1, 'First transition produces 1 history row');

        // Request 2: Send same status 'Requested' with updated version 2 (no status transition)
        const res2 = await db.updateItinerary('QUOTE-001', payload, 2, testSales1, 'SALES');
        assert.strictEqual(res2.status, 'Requested');
        assert.strictEqual(res2.version, 3);
        assert.strictEqual(mockStatusHistory.length, 1, 'Repeated request does NOT add duplicate history row');

        // Request 3: Send same status 'Requested' with updated version 3
        const res3 = await db.updateItinerary('QUOTE-001', payload, 3, testSales1, 'SALES');
        assert.strictEqual(res3.status, 'Requested');
        assert.strictEqual(res3.version, 4);
        assert.strictEqual(mockStatusHistory.length, 1, 'Third request still has exactly 1 history row');
    });

    // --- TEST 7: Quick status transition via changeStatus() records transition atomically ---
    await test("changeStatus() records transition atomically with verified user", async () => {
        resetDb();
        // ADMIN transitions QUOTE-001 from Draft to Requested
        const res = await db.changeStatus('QUOTE-001', 'Requested', 1, testAdmin, 'ADMIN');
        assert.strictEqual(res.status, 'Requested');
        assert.strictEqual(res.version, 2);
        assert.strictEqual(mockStatusHistory.length, 1);
        assert.strictEqual(mockStatusHistory[0].user_id, 'admin-uuid-001', 'Must record ADMIN user ID, not owner_id');

        // Repeated changeStatus with same status is a no-op
        const resSame = await db.changeStatus('QUOTE-001', 'Requested', 2, testAdmin, 'ADMIN');
        assert.strictEqual(resSame.status, 'Requested');
        assert.strictEqual(mockStatusHistory.length, 1, 'No duplicate history on same status');
    });

    // --- TEST 8: Fail closed on status transition when atomic RPC is missing ---
    await test("Fail-closed: updateItinerary fails closed with 503 error when RPC is missing", async () => {
        resetDb();
        simulateRpcMissing = true; // RPC function is not installed in database

        const payload = createValidPayload('QUOTE-001', 'Requested'); // status transition Draft -> Requested

        let threwError = false;
        try {
            await db.updateItinerary('QUOTE-001', payload, 1, testSales1, 'SALES');
        } catch (err) {
            threwError = true;
            assert.ok(
                err.message.includes('Atomic audit service unavailable') ||
                err.message.includes('Status transitions are disabled'),
                `Expected clear fail-closed message, got: ${err.message}`
            );
        }
        assert.ok(threwError, 'Must throw error when RPC is missing and status is changing');

        // Itinerary status must remain unchanged in database
        const current = mockItineraries.find(i => i.quote_id === 'QUOTE-001');
        assert.strictEqual(current.status, 'Draft', 'Itinerary status remains unchanged (Draft)');
        assert.strictEqual(current.version, 1, 'Itinerary version remains 1');
        assert.strictEqual(mockStatusHistory.length, 0, 'No unaudited status history record created');
    });

    // --- TEST 9: Non-status updates succeed safely when atomic RPC is missing ---
    await test("Safe non-status update succeeds even when atomic RPC is missing", async () => {
        resetDb();
        simulateRpcMissing = true; // RPC missing, but status is NOT changing (Draft -> Draft)

        const payload = createValidPayload('QUOTE-001', 'Draft', 'John Doe Updated', 'Bali Trip Extended');

        const updated = await db.updateItinerary('QUOTE-001', payload, 1, testSales1, 'SALES');
        assert.strictEqual(updated.status, 'Draft', 'Status remains Draft');
        assert.strictEqual(updated.guest_name, 'John Doe Updated', 'Guest name was updated');
        assert.strictEqual(updated.version, 2, 'Version incremented');
        assert.strictEqual(mockStatusHistory.length, 0, 'Zero status history records created for non-status update');
    });

    // --- TEST 10: changeStatus() fails closed when atomic RPC is missing ---
    await test("Fail-closed: changeStatus fails closed when atomic RPC is missing", async () => {
        resetDb();
        simulateRpcMissing = true;

        let threwError = false;
        try {
            await db.changeStatus('QUOTE-001', 'Requested', 1, testAdmin, 'ADMIN');
        } catch (err) {
            threwError = true;
            assert.ok(
                err.message.includes('Atomic audit service unavailable'),
                `Expected fail-closed message, got: ${err.message}`
            );
        }
        assert.ok(threwError, 'changeStatus must fail closed when RPC is missing');

        const current = mockItineraries.find(i => i.quote_id === 'QUOTE-001');
        assert.strictEqual(current.status, 'Draft', 'Itinerary status remains Draft');
        assert.strictEqual(current.version, 1, 'Itinerary version remains 1');
        assert.strictEqual(mockStatusHistory.length, 0, 'Zero status history records created');
    });

    // --- TEST 11: changeStatus() with unchanged status but stale version must raise CONCURRENCY_CONFLICT ---
    await test("changeStatus: stale version always raises Concurrency Conflict even when status is unchanged", async () => {
        resetDb();
        // Itinerary is at version 1 with status 'Draft'. Caller attempts changeStatus with status 'Draft' but stale version 999.
        let threwConflict = false;
        try {
            await db.changeStatus('QUOTE-001', 'Draft', 999, testAdmin, 'ADMIN');
        } catch (err) {
            threwConflict = true;
            assert.ok(
                err.message.includes('Concurrency Conflict'),
                `Expected Concurrency Conflict error, got: ${err.message}`
            );
        }
        assert.ok(threwConflict, 'Stale version must raise Concurrency Conflict even if status is unchanged');

        const current = mockItineraries.find(i => i.quote_id === 'QUOTE-001');
        assert.strictEqual(current.version, 1, 'Version must not change on conflict');
        assert.strictEqual(mockStatusHistory.length, 0, 'Zero audit records created');
    });

    // --- TEST 12: changeStatus() with unchanged status and current version is an idempotent no-op ---
    await test("changeStatus: unchanged status with valid current version is a no-op and creates no audit record", async () => {
        resetDb();
        // Itinerary is at version 1 with status 'Draft'. Caller calls changeStatus with status 'Draft' and current version 1.
        const res = await db.changeStatus('QUOTE-001', 'Draft', 1, testAdmin, 'ADMIN');
        assert.strictEqual(res.status, 'Draft', 'Status remains Draft');
        assert.strictEqual(res.version, 1, 'Version does NOT increment on unchanged status no-op');

        const current = mockItineraries.find(i => i.quote_id === 'QUOTE-001');
        assert.strictEqual(current.version, 1, 'Database version remains 1');
        assert.strictEqual(mockStatusHistory.length, 0, 'Zero status history records created');
    });

    console.log(`\nAll status history regression tests passed: ${passed}/${total}`);
}

runTests().catch(err => {
    console.error("Fatal test error:", err);
    process.exit(1);
});
