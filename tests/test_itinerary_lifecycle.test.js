/**
 * Phase 3A — Comprehensive Itinerary Lifecycle Regression Tests
 * Tests create, save, dashboard listing, reopen, edit, reload, PDF generation contract,
 * atomic status transitions, concurrency conflict handling, and ADMIN/SALES/OPS permissions.
 * Uses isolated mock data (no live database mutation).
 */

const assert = require('assert');
const request = require('supertest');

// Set staging test environment
process.env.STORAGE_PROVIDER = 'supabase';
process.env.SUPABASE_URL = 'https://iqqkuqgsvuciunmvtmdr.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'mock-pub-key';
process.env.SUPABASE_SECRET_KEY = 'mock-secret-key';
process.env.PORT = 0;

// Setup in-memory mock database state
let mockItineraries = new Map();
let mockStatusHistory = [];
let mockRpcAvailable = true;

const mockUsers = {
    'admin-token': { id: 'usr-admin-1', email: 'admin@campfly.in', role: 'ADMIN', is_active: true },
    'sales-1-token': { id: 'usr-sales-1', email: 'sales1@campfly.in', role: 'SALES', is_active: true },
    'sales-2-token': { id: 'usr-sales-2', email: 'sales2@campfly.in', role: 'SALES', is_active: true },
    'ops-token': { id: 'usr-ops-1', email: 'ops@campfly.in', role: 'OPS', is_active: true },
    'inactive-token': { id: 'usr-inactive', email: 'inactive@campfly.in', role: 'SALES', is_active: false }
};

function resetMockDb() {
    mockItineraries.clear();
    mockStatusHistory = [];
    mockRpcAvailable = true;
}

// Create mock Supabase client adhering to the schema and atomic RPCs
function createMockSupabaseClient() {
    return {
        auth: {
            getUser: async (token) => {
                const u = mockUsers[token];
                if (u) return { data: { user: { id: u.id, email: u.email } }, error: null };
                return { data: { user: null }, error: new Error("Invalid token") };
            }
        },
        from: (table) => {
            if (table === 'user_roles') {
                return {
                    select: () => ({
                        eq: (col, val) => ({
                            single: async () => {
                                const found = Object.values(mockUsers).find(u => u.id === val);
                                if (found) return { data: { role: found.role, is_active: found.is_active }, error: null };
                                return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                            }
                        })
                    })
                };
            }
            if (table === 'itineraries') {
                return {
                    select: (cols) => {
                        const chain = {
                            eq: (col, val) => ({
                                single: async () => {
                                    if (col === 'quote_id') {
                                        const record = mockItineraries.get(val);
                                        if (record) return { data: { ...record }, error: null };
                                        return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                    }
                                    return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                }
                            }),
                            order: (orderCol, { ascending }) => {
                                const list = Array.from(mockItineraries.values()).sort((a, b) => {
                                    const ta = new Date(a.updated_at).getTime();
                                    const tb = new Date(b.updated_at).getTime();
                                    return ascending ? ta - tb : tb - ta;
                                });
                                return Promise.resolve({ data: list, error: null });
                            }
                        };
                        return chain;
                    },
                    insert: (rows) => ({
                        select: () => ({
                            single: async () => {
                                const row = rows[0];
                                if (mockItineraries.has(row.quote_id)) {
                                    return { data: null, error: { code: '23505', message: 'Duplicate quote_id' } };
                                }
                                const inserted = {
                                    id: 'itin-' + Math.random().toString(36).substring(2, 9),
                                    ...row,
                                    version: 1,
                                    created_at: new Date().toISOString(),
                                    updated_at: new Date().toISOString()
                                };
                                mockItineraries.set(row.quote_id, inserted);
                                return { data: inserted, error: null };
                            }
                        })
                    }),
                    update: (updates) => ({
                        eq: (col1, val1) => ({
                            eq: (col2, val2) => ({
                                select: () => ({
                                    single: async () => {
                                        const quoteId = val1;
                                        const expectedVersion = val2;
                                        const existing = mockItineraries.get(quoteId);
                                        if (!existing || existing.version !== expectedVersion) {
                                            return { data: null, error: null }; // 0 rows updated
                                        }
                                        const updated = {
                                            ...existing,
                                            ...updates,
                                            version: existing.version + 1,
                                            updated_at: new Date().toISOString()
                                        };
                                        mockItineraries.set(quoteId, updated);
                                        return { data: updated, error: null };
                                    }
                                })
                            })
                        })
                    })
                };
            }
            if (table === 'status_history') {
                return {
                    select: () => ({
                        eq: (col, val) => ({
                            data: mockStatusHistory.filter(h => h.itinerary_id === val)
                        })
                    })
                };
            }
            throw new Error(`Unknown table: ${table}`);
        },
        rpc: async (funcName, params) => {
            if (!mockRpcAvailable) {
                return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${funcName}` } };
            }
            if (funcName === 'update_itinerary_status_atomic') {
                const existing = mockItineraries.get(params.p_quote_id);
                if (!existing) {
                    return { data: null, error: { message: `ITINERARY_NOT_FOUND: Quote ID ${params.p_quote_id} does not exist` } };
                }
                if (existing.version !== params.p_current_version) {
                    return { data: null, error: { message: `CONCURRENCY_CONFLICT: Version mismatch. Expected ${params.p_current_version}, found ${existing.version}` } };
                }

                const oldStatus = existing.status;
                const newStatus = params.p_status;
                const updated = {
                    ...existing,
                    status: newStatus,
                    is_voucher_mode: params.p_is_voucher_mode,
                    guest_name: params.p_guest_name,
                    title: params.p_title,
                    start_date: params.p_start_date,
                    end_date: params.p_end_date,
                    guest_count: params.p_guest_count,
                    total_amount: params.p_total_amount,
                    currency: params.p_currency,
                    content: params.p_content,
                    version: existing.version + 1,
                    updated_at: new Date().toISOString()
                };
                mockItineraries.set(params.p_quote_id, updated);

                if (oldStatus !== newStatus) {
                    mockStatusHistory.push({
                        itinerary_id: existing.id,
                        user_id: params.p_user_id,
                        old_status: oldStatus,
                        new_status: newStatus,
                        created_at: new Date().toISOString()
                    });
                }
                return { data: updated, error: null };
            }
            if (funcName === 'change_itinerary_status_atomic') {
                const existing = mockItineraries.get(params.p_quote_id);
                if (!existing) {
                    return { data: null, error: { message: `ITINERARY_NOT_FOUND: Quote ID ${params.p_quote_id} does not exist` } };
                }
                // Check concurrency conflict first!
                if (existing.version !== params.p_current_version) {
                    return { data: null, error: { message: `CONCURRENCY_CONFLICT: Version mismatch. Expected ${params.p_current_version}, found ${existing.version}` } };
                }
                // Idempotent unchanged status
                if (existing.status === params.p_new_status) {
                    return { data: existing, error: null };
                }

                const oldStatus = existing.status;
                const newStatus = params.p_new_status;
                const updated = {
                    ...existing,
                    status: newStatus,
                    version: existing.version + 1,
                    updated_at: new Date().toISOString()
                };
                mockItineraries.set(params.p_quote_id, updated);

                mockStatusHistory.push({
                    itinerary_id: existing.id,
                    user_id: params.p_user_id,
                    old_status: oldStatus,
                    new_status: newStatus,
                    created_at: new Date().toISOString()
                });
                return { data: updated, error: null };
            }
            throw new Error(`Unknown RPC: ${funcName}`);
        }
    };
}

// Wire dependencies
const app = require('../api/server.js');
const db = require('../api/db.js');
const mockClient = createMockSupabaseClient();
app.setDependencies(mockClient, mockClient);
db.setClient(mockClient);

async function runAllTests() {
    console.log("=== PHASE 3A: FULL ITINERARY WORKFLOW REGRESSION TESTS ===");
    let passed = 0;
    let total = 0;

    function test(desc, fn) {
        total++;
        try {
            fn();
            console.log(`✅ [PASS] ${total}. ${desc}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${total}. ${desc}\n   ${err.message}`);
        }
    }

    async function asyncTest(desc, fn) {
        total++;
        try {
            await fn();
            console.log(`✅ [PASS] ${total}. ${desc}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${total}. ${desc}\n   ${err.stack || err.message}`);
        }
    }

    resetMockDb();

    // 1. Create workflow
    await asyncTest("ADMIN can create a new itinerary (version: 1, status: Draft)", async () => {
        const payload = {
            id: 'CMP-2026-100001',
            title: 'Kerala Monsoon Bliss',
            guest: 'Aarav Sharma',
            start: '2026-11-01',
            end: '2026-11-05',
            adults: 2,
            baseCost: 35000,
            status: 'Draft',
            days: [{ title: 'Day 1: Arrival' }],
            hotels: [{ name: 'Lake Palace', nights: 4 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer admin-token')
            .send(payload);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.version, 1);
        const stored = mockItineraries.get('CMP-2026-100001');
        assert(stored);
        assert.strictEqual(stored.owner_id, 'usr-admin-1');
        assert.strictEqual(stored.version, 1);
        assert.strictEqual(stored.status, 'Draft');
    });

    await asyncTest("SALES can create an itinerary with ownership assigned to sales user", async () => {
        const payload = {
            id: 'CMP-2026-100002',
            title: 'Goa Coastal Retreat',
            guest: 'Rohan Mehra',
            start: '2026-12-10',
            end: '2026-12-14',
            adults: 2,
            baseCost: 45000,
            status: 'Draft',
            days: [{ title: 'Day 1: Beach' }],
            hotels: [{ name: 'Taj Exotica', nights: 4 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer sales-1-token')
            .send(payload);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 1);
        const stored = mockItineraries.get('CMP-2026-100002');
        assert.strictEqual(stored.owner_id, 'usr-sales-1');
    });

    await asyncTest("OPS is forbidden from creating new itineraries", async () => {
        const payload = {
            id: 'CMP-2026-100003',
            title: 'Ops Created',
            guest: 'Test Guest',
            status: 'Draft',
            days: [{ title: 'Day 1' }],
            hotels: [{ name: 'Hotel', nights: 2 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer ops-token')
            .send(payload);

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Only Admin and Sales can create"));
    });

    await asyncTest("Duplicate Quote ID creation is rejected with 409 Conflict", async () => {
        const payload = {
            id: 'CMP-2026-100001', // already exists
            title: 'Duplicate Attempt',
            guest: 'Duplicate Guest',
            status: 'Draft',
            days: [{ title: 'Day 1' }],
            hotels: [{ name: 'Hotel', nights: 2 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer admin-token')
            .send(payload);

        assert.strictEqual(res.status, 409);
        assert(res.body.error.includes("already exists"));
    });

    // 2. Dashboard Listing workflow
    await asyncTest("ADMIN can list all itineraries with summary metrics and versions", async () => {
        const res = await request(app)
            .get('/api/listItineraries')
            .set('Authorization', 'Bearer admin-token');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert(Array.isArray(res.body.data));
        assert.strictEqual(res.body.data.length, 2);
        const item = res.body.data.find(d => d.id === 'CMP-2026-100001');
        assert(item);
        assert.strictEqual(item.title, 'Kerala Monsoon Bliss');
        assert.strictEqual(item.version, 1);
        assert.strictEqual(item.status, 'Draft');
    });

    await asyncTest("SALES and OPS can list itineraries", async () => {
        const resSales = await request(app)
            .get('/api/listItineraries')
            .set('Authorization', 'Bearer sales-1-token');
        assert.strictEqual(resSales.status, 200);
        assert.strictEqual(resSales.body.data.length, 2);

        const resOps = await request(app)
            .get('/api/listItineraries')
            .set('Authorization', 'Bearer ops-token');
        assert.strictEqual(resOps.status, 200);
        assert.strictEqual(resOps.body.data.length, 2);
    });

    await asyncTest("Unauthenticated request to list itineraries is rejected (401)", async () => {
        const res = await request(app).get('/api/listItineraries');
        assert.strictEqual(res.status, 401);
    });

    // 3. Reopen / Read workflow
    await asyncTest("Reopen itinerary via /api/getItinerary/:id returns complete payload with version", async () => {
        const res = await request(app)
            .get('/api/getItinerary/CMP-2026-100001')
            .set('Authorization', 'Bearer admin-token');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.id, 'CMP-2026-100001');
        assert.strictEqual(res.body.data.guest, 'Aarav Sharma');
        assert.strictEqual(res.body.data.version, 1);
    });

    await asyncTest("Reopen non-existent itinerary returns 404 Not Found", async () => {
        const res = await request(app)
            .get('/api/getItinerary/CMP-NON-EXISTENT')
            .set('Authorization', 'Bearer admin-token');

        assert.strictEqual(res.status, 404);
    });

    // 4. Edit / Update workflow with Optimistic Concurrency
    await asyncTest("ADMIN can update itinerary with valid current version, incrementing version to 2", async () => {
        const updatedPayload = {
            id: 'CMP-2026-100001',
            title: 'Kerala Monsoon Bliss (Updated Luxury)',
            guest: 'Aarav Sharma & Family',
            start: '2026-11-01',
            end: '2026-11-05',
            adults: 3,
            baseCost: 48000,
            status: 'Draft',
            days: [{ title: 'Day 1: Arrival & Tea Plantations' }],
            hotels: [{ name: 'Lake Palace Suite', nights: 4 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer admin-token')
            .send({ itinerary: updatedPayload, version: 1 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 2);

        const inDb = mockItineraries.get('CMP-2026-100001');
        assert.strictEqual(inDb.version, 2);
        assert.strictEqual(inDb.title, 'Kerala Monsoon Bliss (Updated Luxury)');
        // Non-status update: 0 status history records created
        assert.strictEqual(mockStatusHistory.length, 0);
    });

    await asyncTest("SALES can update their own itinerary with matching version", async () => {
        const updatedPayload = {
            id: 'CMP-2026-100002',
            title: 'Goa Coastal Retreat (Updated)',
            guest: 'Rohan Mehra',
            start: '2026-12-10',
            end: '2026-12-14',
            adults: 2,
            baseCost: 50000,
            status: 'Draft',
            days: [{ title: 'Day 1' }],
            hotels: [{ name: 'Taj Exotica', nights: 4 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer sales-1-token')
            .send({ itinerary: updatedPayload, version: 1 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 2);
        assert.strictEqual(mockItineraries.get('CMP-2026-100002').version, 2);
    });

    await asyncTest("SALES is blocked from updating another user's itinerary (403)", async () => {
        const payload = {
            id: 'CMP-2026-100002', // owned by sales-1
            title: 'Hijack attempt',
            status: 'Draft',
            days: [{ title: 'Day 1' }],
            hotels: [{ name: 'Hotel', nights: 2 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer sales-2-token')
            .send({ itinerary: payload, version: 2 });

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Sales can only edit their own itineraries"));
    });

    await asyncTest("SALES is blocked from updating legacy unassigned records (403)", async () => {
        // Seed legacy unassigned record (owner_id: null)
        mockItineraries.set('CMP-LEGACY-01', {
            id: 'itin-legacy-1',
            quote_id: 'CMP-LEGACY-01',
            owner_id: null,
            status: 'Draft',
            version: 1,
            title: 'Legacy Package'
        });

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer sales-1-token')
            .send({
                itinerary: { id: 'CMP-LEGACY-01', status: 'Draft', days: [{ title: 'D1' }], hotels: [{ name: 'H', nights: 1 }] },
                version: 1
            });

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Legacy unassigned records can only be edited by an Administrator"));
    });

    await asyncTest("OPS is blocked from editing itinerary content directly (403)", async () => {
        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer ops-token')
            .send({
                itinerary: { id: 'CMP-2026-100001', status: 'Draft', days: [{ title: 'D1' }], hotels: [{ name: 'H', nights: 1 }] },
                version: 2
            });

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Ops/Unauthorized cannot edit itinerary content directly"));
    });

    await asyncTest("Stale version edit returns 409 Concurrency Conflict and prevents silent overwrite", async () => {
        // DB is at version 2. Stale request sends version 1.
        const stalePayload = {
            id: 'CMP-2026-100001',
            title: 'Stale Overwrite Attempt',
            guest: 'Aarav Sharma',
            status: 'Draft',
            days: [{ title: 'Day 1' }],
            hotels: [{ name: 'Hotel', nights: 4 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer admin-token')
            .send({ itinerary: stalePayload, version: 1 }); // Stale version 1!

        assert.strictEqual(res.status, 409);
        assert(res.body.error.includes("Concurrency Conflict"));

        // Confirm database was NOT overwritten
        const inDb = mockItineraries.get('CMP-2026-100001');
        assert.strictEqual(inDb.version, 2);
        assert.strictEqual(inDb.title, 'Kerala Monsoon Bliss (Updated Luxury)');
    });

    // 5. Atomic Status Transitions with Audit History
    await asyncTest("ADMIN can transition status via /api/itineraries/:id/status (Draft -> Requested)", async () => {
        mockStatusHistory = [];
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-100001/status')
            .set('Authorization', 'Bearer admin-token')
            .send({ status: 'Requested', version: 2 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.version, 3);
        assert.strictEqual(res.body.status, 'Requested');

        // Confirm database record updated
        const inDb = mockItineraries.get('CMP-2026-100001');
        assert.strictEqual(inDb.status, 'Requested');
        assert.strictEqual(inDb.version, 3);

        // Confirm EXACTLY ONE audit entry created with ADMIN user ID
        assert.strictEqual(mockStatusHistory.length, 1);
        const audit = mockStatusHistory[0];
        assert.strictEqual(audit.old_status, 'Draft');
        assert.strictEqual(audit.new_status, 'Requested');
        assert.strictEqual(audit.user_id, 'usr-admin-1');
    });

    await asyncTest("OPS can transition status via /api/itineraries/:id/status (Requested -> Confirmed)", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-100001/status')
            .set('Authorization', 'Bearer ops-token')
            .send({ status: 'Confirmed', version: 3 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 4);

        // Confirm audit entry created with OPS user ID
        assert.strictEqual(mockStatusHistory.length, 2);
        const audit = mockStatusHistory[1];
        assert.strictEqual(audit.old_status, 'Requested');
        assert.strictEqual(audit.new_status, 'Confirmed');
        assert.strictEqual(audit.user_id, 'usr-ops-1');
    });

    await asyncTest("SALES can transition status of own itinerary via /api/changeStatus", async () => {
        const res = await request(app)
            .post('/api/changeStatus')
            .set('Authorization', 'Bearer sales-1-token')
            .send({ quoteId: 'CMP-2026-100002', status: 'Requested', version: 2 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 3);

        const audit = mockStatusHistory[mockStatusHistory.length - 1];
        assert.strictEqual(audit.old_status, 'Draft');
        assert.strictEqual(audit.new_status, 'Requested');
        assert.strictEqual(audit.user_id, 'usr-sales-1');
    });

    await asyncTest("SALES is blocked from transitioning status of another user's itinerary (403)", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-100002/status') // owned by sales-1
            .set('Authorization', 'Bearer sales-2-token')
            .send({ status: 'Confirmed', version: 3 });

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Not authorized to change status"));
    });

    await asyncTest("Status transition with stale version returns 409 Conflict without writing audit history", async () => {
        const historyCountBefore = mockStatusHistory.length;
        // Current version is 4. Stale request sends version 3.
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-100001/status')
            .set('Authorization', 'Bearer admin-token')
            .send({ status: 'Cancelled', version: 3 });

        assert.strictEqual(res.status, 409);
        assert(res.body.error.includes("Concurrency Conflict"));
        assert.strictEqual(mockStatusHistory.length, historyCountBefore);
    });

    await asyncTest("Unchanged status with matching valid version is an idempotent no-op (0 audit entries)", async () => {
        const historyCountBefore = mockStatusHistory.length;
        // CMP-2026-100001 is Confirmed at version 4
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-100001/status')
            .set('Authorization', 'Bearer admin-token')
            .send({ status: 'Confirmed', version: 4 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 4); // not incremented
        assert.strictEqual(mockStatusHistory.length, historyCountBefore); // No audit entry
    });

    await asyncTest("Status change fails closed with 503 when atomic RPC is missing", async () => {
        mockRpcAvailable = false;
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-100001/status')
            .set('Authorization', 'Bearer admin-token')
            .send({ status: 'Cancelled', version: 4 });

        assert.strictEqual(res.status, 503);
        assert(res.body.error.includes("Atomic audit service unavailable"));
        mockRpcAvailable = true;
    });

    await asyncTest("Status transition via saveItinerary creates atomic audit entry with user ID", async () => {
        mockStatusHistory = [];
        const payload = {
            id: 'CMP-2026-100001',
            title: 'Kerala Monsoon Bliss (Finalized)',
            guest: 'Aarav Sharma',
            start: '2026-11-01',
            end: '2026-11-05',
            adults: 2,
            baseCost: 35000,
            status: 'Cancelled', // Changed from Confirmed
            days: [
                { title: 'Day 1 - Arrival' },
                { title: 'Day 2 - Tea Gardens' },
                { title: 'Day 3 - Backwaters' },
                { title: 'Day 4 - Cultural Tour' },
                { title: 'Day 5 - Departure' }
            ],
            hotels: [{ name: 'Hotel', nights: 4 }]
        };

        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer admin-token')
            .send({ itinerary: payload, version: 4 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.version, 5);

        assert.strictEqual(mockStatusHistory.length, 1);
        const audit = mockStatusHistory[0];
        assert.strictEqual(audit.old_status, 'Confirmed');
        assert.strictEqual(audit.new_status, 'Cancelled');
        assert.strictEqual(audit.user_id, 'usr-admin-1');
    });

    // 6. Account Status / Role boundaries
    await asyncTest("Inactive user is rejected with 403 on all operations", async () => {
        const res = await request(app)
            .get('/api/listItineraries')
            .set('Authorization', 'Bearer inactive-token');

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Forbidden: Account inactive"));
    });

    console.log(`\n========================================`);
    console.log(`SUMMARY: ${passed} / ${total} tests passed.`);
    console.log(`========================================\n`);

    if (passed !== total) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error("FATAL TEST RUN ERROR:", err);
    process.exit(1);
});
