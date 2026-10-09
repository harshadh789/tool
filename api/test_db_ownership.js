const Module = require('module');
const originalRequire = Module.prototype.require;

// The current 'db' database state for our mock
const mockDB = {
    'CMP-ADMIN': { quote_id: 'CMP-ADMIN', owner_id: 'admin-uuid', status: 'Draft', version: 1 },
    'CMP-SALES1': { quote_id: 'CMP-SALES1', owner_id: 'sales1-uuid', status: 'Draft', version: 1 },
    'CMP-SALES2': { quote_id: 'CMP-SALES2', owner_id: 'sales2-uuid', status: 'Draft', version: 1 },
    'CMP-UNASSIGNED': { quote_id: 'CMP-UNASSIGNED', owner_id: null, status: 'Draft', version: 1 }
};

// Mock Supabase Client
Module.prototype.require = function(request) {
    if (request === '@supabase/supabase-js') {
        return {
            createClient: () => {
                return {
                    from: (table) => {
                        return {
                            select: () => ({
                                eq: (field, val) => {
                                    return {
                                        single: async () => {
                                            if (field === 'quote_id' && mockDB[val]) {
                                                return { data: mockDB[val], error: null };
                                            }
                                            return { data: null, error: { code: 'PGRST116' } };
                                        }
                                    };
                                }
                            })
                        };
                    }
                };
            }
        };
    }
    return originalRequire.apply(this, arguments);
};

process.env.SUPABASE_URL = 'http://mock';
process.env.SUPABASE_SECRET_KEY = 'mock';

const db = require('./db.js');

async function runTests() {
    console.log("=== Running Isolated db.js Ownership Tests ===");
    let passed = 0;
    let failed = 0;

    const assertThrows = async (promise, expectedErrorMsg, testName) => {
        try {
            await promise;
            console.error(`[FAIL] ${testName} (Did not throw)`);
            failed++;
        } catch (e) {
            if (e.message.includes(expectedErrorMsg)) {
                console.log(`[PASS] ${testName}`);
                passed++;
            } else {
                console.error(`[FAIL] ${testName} (Threw wrong error: ${e.message})`);
                failed++;
            }
        }
    };

    const admin = { id: 'admin-uuid' };
    const sales1 = { id: 'sales1-uuid' };
    const sales2 = { id: 'sales2-uuid' };

    // Test 1: Admin can edit Sales record
    try {
        await db.updateItinerary('CMP-SALES1', { status: 'Confirmed' }, 1, admin, 'ADMIN');
        // If it throws "Update failed" because our mock doesn't implement .update(), it means authorization passed!
        // Wait, our mock only implements .select().eq().single(), so it will crash on update() if auth passes.
        // Let's just catch the crash to prove it passed auth.
    } catch (e) {
        if (e.message.includes("Cannot read properties of undefined (reading 'eq')") || e.message.includes("update is not a function")) {
            console.log(`[PASS] Admin can edit Sales record (Authorization passed)`);
            passed++;
        } else {
            console.error(`[FAIL] Admin can edit Sales record. Error: ${e.message}`);
            failed++;
        }
    }

    // Test 2: Sales1 can edit their own record
    try {
        await db.updateItinerary('CMP-SALES1', { status: 'Confirmed' }, 1, sales1, 'SALES');
        // Will crash at .update() if auth passes
    } catch (e) {
        if (e.message.includes("Cannot read properties of undefined (reading 'eq')") || e.message.includes("update is not a function")) {
            console.log(`[PASS] Sales1 can edit their own record (Authorization passed)`);
            passed++;
        } else {
            console.error(`[FAIL] Sales1 can edit their own record. Error: ${e.message}`);
            failed++;
        }
    }

    // Test 3: Sales1 cannot edit Sales2's record
    await assertThrows(
        db.updateItinerary('CMP-SALES2', { status: 'Confirmed' }, 1, sales1, 'SALES'),
        "Sales can only edit their own itineraries",
        "Sales1 cannot edit Sales2's record"
    );

    // Test 4: Sales1 cannot edit Unassigned legacy record
    await assertThrows(
        db.updateItinerary('CMP-UNASSIGNED', { status: 'Confirmed' }, 1, sales1, 'SALES'),
        "Legacy unassigned records can only be edited by an Administrator",
        "Sales1 cannot edit Unassigned legacy record"
    );

    // Test 5: Ops cannot edit
    await assertThrows(
        db.updateItinerary('CMP-SALES1', { status: 'Confirmed' }, 1, admin, 'OPS'), // Using ops role
        "Ops/Unauthorized cannot edit itinerary content directly",
        "Ops cannot edit any record"
    );

    console.log(`\nTests finished. Passed: ${passed}, Failed: ${failed}`);
}

runTests();
