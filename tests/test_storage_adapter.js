require('dotenv').config();

// Override for tests
process.env.STORAGE_PROVIDER = 'supabase';
process.env.SUPABASE_URL = 'https://iqqkuqgsvuciunmvtmdr.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'mock-secret';
process.env.SUPABASE_PUBLISHABLE_KEY = 'mock-pub';
process.env.PORT = 0;

let mockDB = {
    itineraries: [
        { id: '1', quote_id: 'LEGACY-01', owner_id: null, version: 1, content: { id: 'LEGACY-01', status: 'Draft' }, status: 'Draft' },
        { id: '2', quote_id: 'SALES-01', owner_id: 'sales-1', version: 1, content: { id: 'SALES-01', status: 'Draft' }, status: 'Draft' },
        { id: '3', quote_id: 'OTHER-01', owner_id: 'sales-2', version: 1, content: { id: 'OTHER-01', status: 'Draft' }, status: 'Draft' }
    ],
    status_history: []
};

const supabaseModule = require('@supabase/supabase-js');
supabaseModule.createClient = function(url, key) {
    return {
        auth: {
            getUser: async (token) => {
                if (token === 'valid-admin-token') return { data: { user: { id: 'admin-1' } } };
                if (token === 'valid-sales-token') return { data: { user: { id: 'sales-1' } } };
                if (token === 'valid-ops-token') return { data: { user: { id: 'ops-1' } } };
                return { error: new Error("Invalid token") };
            }
        },
        from: (table) => {
            return {
                select: () => {
                    return {
                        eq: (col, val) => {
                            if (table === 'user_roles') {
                                return {
                                    single: async () => {
                                        if (val === 'admin-1') return { data: { role: 'ADMIN', is_active: true } };
                                        if (val === 'sales-1') return { data: { role: 'SALES', is_active: true } };
                                        if (val === 'ops-1') return { data: { role: 'OPS', is_active: true } };
                                        return { error: new Error("Not found") };
                                    }
                                };
                            }
                            if (table === 'itineraries' && col === 'quote_id') {
                                return {
                                    single: async () => {
                                        const record = mockDB.itineraries.find(r => r.quote_id === val);
                                        if (record) return { data: record };
                                        return { error: { code: 'PGRST116' } };
                                    }
                                };
                            }
                            return { single: async () => ({ error: { code: 'PGRST116' } }) };
                        },
                        order: () => {
                            return { data: mockDB.itineraries };
                        }
                    };
                },
                insert: (arr) => {
                    return {
                        select: () => ({
                            single: async () => {
                                if (mockDB.itineraries.find(r => r.quote_id === arr[0].quote_id)) {
                                    return { error: { code: '23505' } }; // Duplicate
                                }
                                const newRecord = { ...arr[0], id: Math.random().toString() };
                                mockDB.itineraries.push(newRecord);
                                return { data: newRecord };
                            }
                        })
                    };
                },
                update: (updates) => {
                    let chain = {
                        eq: (col1, val1) => {
                            return {
                                eq: (col2, val2) => {
                                    return {
                                        select: () => ({
                                            single: async () => {
                                                const idx = mockDB.itineraries.findIndex(r => r[col1] === val1 && r[col2] === val2);
                                                if (idx >= 0) {
                                                    mockDB.itineraries[idx] = { ...mockDB.itineraries[idx], ...updates };
                                                    return { data: mockDB.itineraries[idx] };
                                                }
                                                return { error: new Error("Missing record or conflict") };
                                            }
                                        })
                                    };
                                }
                            };
                        }
                    };
                    return chain;
                }
            };
        }
    };
};

const app = require('../api/server.js');
const request = require('supertest');

async function runTest(name, auth, payload, expectStatus, expectResponseSnippet) {
    let req = request(app).post('/api/saveItinerary').send(payload);
    if (auth) req = req.set('Authorization', `Bearer ${auth}`);

    const res = await req;

    const passStatus = res.status === expectStatus;
    const passSnippet = expectResponseSnippet ? JSON.stringify(res.body).includes(expectResponseSnippet) : true;

    if (passStatus && passSnippet) {
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name}`);
        console.error(`  Expected Status: ${expectStatus}, Got: ${res.status}`);
        console.error(`  Expected Snippet: ${expectResponseSnippet}`);
        console.error(`  Response: ${JSON.stringify(res.body)}`);
    }
}

async function runAll() {
    console.log("=== STORAGE ADAPTER TESTS ===");

    // 1. Create a new itinerary with version 1
    await runTest("Create new itinerary (ADMIN)", "valid-admin-token", {
        itinerary: { id: "NEW-01", status: "Draft" }
    }, 200, '"version":1');

    // 2. Duplicate quote ID rejected
    await runTest("Duplicate quote ID rejected", "valid-admin-token", {
        itinerary: { id: "NEW-01", status: "Draft" }
    }, 409, 'Conflict');

    // 3. Successful update increments the version
    await runTest("Update increments version", "valid-admin-token", {
        itinerary: { id: "NEW-01", status: "Draft", guest: "John" },
        version: 1
    }, 200, '"version":2');

    // 4. Stale-version update returns 409
    await runTest("Stale version returns 409", "valid-admin-token", {
        itinerary: { id: "NEW-01", status: "Draft" },
        version: 1 // Already at version 2
    }, 409, 'Concurrency Conflict');

    // 5. ADMIN can modify an unassigned legacy record
    await runTest("ADMIN modifies legacy record", "valid-admin-token", {
        itinerary: { id: "LEGACY-01", status: "Draft" },
        version: 1
    }, 200, '"version":2');

    // 6. SALES can modify its own itinerary
    await runTest("SALES modifies own record", "valid-sales-token", {
        itinerary: { id: "SALES-01", status: "Draft" },
        version: 1
    }, 200, '"version":2');

    // 7. SALES cannot modify another user's itinerary
    await runTest("SALES blocked from other's record", "valid-sales-token", {
        itinerary: { id: "OTHER-01", status: "Draft" },
        version: 1
    }, 403, 'can only edit their own');

    // 8. SALES cannot modify an unassigned legacy itinerary
    await runTest("SALES blocked from legacy record", "valid-sales-token", {
        itinerary: { id: "LEGACY-01", status: "Draft" },
        version: 2
    }, 403, 'Legacy unassigned');

    // 9. OPS cannot modify
    await runTest("OPS blocked from creating", "valid-ops-token", {
        itinerary: { id: "OPS-01", status: "Draft" }
    }, 403, 'Only Admin and Sales');

    await runTest("OPS blocked from updating", "valid-ops-token", {
        itinerary: { id: "NEW-01", status: "Draft" },
        version: 2
    }, 403, 'cannot edit itinerary');

    // 10. List itineraries for SALES (should return 200, check the items)
    const listRes = await request(app).get('/api/listItineraries').set('Authorization', `Bearer valid-sales-token`);
    if (listRes.status === 200 && listRes.body.data.length > 0) {
        console.log("[PASS] SALES can list itineraries.");
    } else {
        console.error("[FAIL] SALES cannot list itineraries.", listRes.body);
    }

    // 11. Staging target rejection
    process.env.SUPABASE_URL = 'https://wrong.supabase.co';
    const rejectRes = await request(app).get('/api/listItineraries').set('Authorization', `Bearer valid-admin-token`);
    if (rejectRes.status === 500 && rejectRes.body.error.includes('Safety abort')) {
        console.log("[PASS] Staging URL protection works.");
    } else {
        console.error("[FAIL] Staging URL protection failed.", rejectRes.body);
    }

    console.log("=== TESTS COMPLETE ===");
    process.exit(0);
}

runAll();
