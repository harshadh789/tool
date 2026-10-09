require('dotenv').config();

// Mock dependencies before requiring server
const axios = require('axios');
const originalAxiosPost = axios.post;
let mockUploadCalled = false;
axios.post = async function(url, data, config) {
    if (url.includes('/upload')) {
        mockUploadCalled = true;
        return { data: { data: [{ attributes: { name: 'uploaded.json' } }] } };
    }
    if (url.includes('/oauth/v2/token')) {
        return { data: { access_token: 'mock-token' } };
    }
    return originalAxiosPost.apply(this, arguments);
};

const supabaseModule = require('@supabase/supabase-js');
supabaseModule.createClient = function(url, key) {
    return {
        auth: {
            getUser: async (token) => {
                if (token === 'valid-admin-token') return { data: { user: { id: 'admin-1' } } };
                if (token === 'valid-sales-token') return { data: { user: { id: 'sales-1' } } };
                return { error: new Error("Invalid token") };
            }
        },
        from: (table) => ({
            select: () => ({
                eq: (col, val) => ({
                    single: async () => {
                        if (val === 'admin-1') return { data: { role: 'ADMIN', is_active: true } };
                        if (val === 'sales-1') return { data: { role: 'SALES', is_active: true } };
                        return { error: new Error("Not found") };
                    }
                })
            })
        })
    };
};

// Override PORT to avoid conflicts
process.env.PORT = 0;
const app = require('../api/server.js');
const request = require('supertest');

async function runTest(name, auth, payload, expectStatus, expectUpload) {
    mockUploadCalled = false; // Reset

    let req = request(app).post('/api/saveItinerary').send(payload);
    if (auth) req = req.set('Authorization', `Bearer ${auth}`);

    const res = await req;

    const passStatus = res.status === expectStatus;
    const passUpload = mockUploadCalled === expectUpload;

    if (passStatus && passUpload) {
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name}`);
        console.error(`  Expected Status: ${expectStatus}, Got: ${res.status}`);
        console.error(`  Expected Upload: ${expectUpload}, Got: ${mockUploadCalled}`);
        console.error(`  Response: ${JSON.stringify(res.body)}`);
    }
}

async function runAll() {
    console.log("=== INTEGRATION TESTS ===");

    // 1. Complete, realistic itinerary can pass validation.
    await runTest("1. Complete, realistic itinerary", "valid-admin-token", {
        id: "TEST-INT-01",
        title: "Bali Trip",
        guest: "John Doe",
        start: "2026-10-10",
        end: "2026-10-14",
        adults: 2,
        baseCost: 1000,
        status: "Requested",
        days: [{ title: "Day 1" }, { title: "Day 2" }, { title: "Day 3" }, { title: "Day 4" }, { title: "Day 5" }],
        hotels: [{ name: "Hotel A", nights: 4 }] // Numeric 4
    }, 200, true);

    // 2. A 5-day itinerary with only one day entry is rejected for Requested status.
    await runTest("2. Incomplete itinerary rejected for Requested", "valid-admin-token", {
        id: "TEST-INT-02",
        title: "Bali Trip",
        guest: "John Doe",
        start: "2026-10-10",
        end: "2026-10-14",
        adults: 2,
        baseCost: 1000,
        status: "Requested",
        days: [{ title: "Day 1" }], // Missing days
        hotels: [{ name: "Hotel A", nights: 4 }]
    }, 400, false);

    // 3. Incomplete Draft follows the intended warning and save policy.
    await runTest("3. Incomplete Draft accepted (warnings don't block)", "valid-admin-token", {
        id: "TEST-INT-03",
        title: "Bali Trip",
        guest: "John Doe",
        start: "2026-10-10",
        end: "2026-10-14",
        adults: 2,
        baseCost: 1000,
        status: "Draft",
        days: [{ title: "Day 1" }], // Missing days, but it's a draft
        hotels: [{ name: "Hotel A", nights: 4 }]
    }, 200, true);

    // 4. Direct API submission cannot bypass validation.
    await runTest("4. Bypassed frontend missing ID", "valid-admin-token", {
        title: "Bali Trip", // No ID
        status: "Draft"
    }, 400, false);

    // 5. Invalid or inconsistent hotel-night data is handled according to the real schema.
    await runTest("5. Text-based hotel nights (UNCERTAIN) are accepted without false rejection", "valid-admin-token", {
        id: "TEST-INT-05",
        title: "Bali Trip",
        guest: "John Doe",
        start: "2026-10-10",
        end: "2026-10-14",
        adults: 2,
        baseCost: 1000,
        status: "Requested",
        days: [{ title: "Day 1" }, { title: "Day 2" }, { title: "Day 3" }, { title: "Day 4" }, { title: "Day 5" }],
        hotels: [{ name: "Hotel A", nights: "Day 1 - Day 4 : Ubud" }] // Text-based
    }, 200, true);

    // 6. Invalid dates and non-finite numeric values are rejected.
    await runTest("6. Invalid dates and numeric values rejected", "valid-admin-token", {
        id: "TEST-INT-06",
        title: "Bali Trip",
        guest: "John Doe",
        start: "2026-10-15",
        end: "2026-10-10", // End before start
        adults: "foo", // Invalid number
        baseCost: 1000,
        status: "Draft",
        days: [{ title: "Day 1" }, { title: "Day 2" }, { title: "Day 3" }, { title: "Day 4" }, { title: "Day 5" }],
        hotels: [{ name: "Hotel A", nights: 4 }]
    }, 400, false);

    // 7. Unauthenticated requests and non-ADMIN users remain blocked from the current WorkDrive save route.
    await runTest("7. Unauthenticated blocked", "", {
        id: "TEST-INT-07",
        title: "Bali Trip",
        guest: "John Doe",
        status: "Draft"
    }, 401, false);

    await runTest("8. Non-ADMIN users blocked", "valid-sales-token", {
        id: "TEST-INT-08",
        title: "Bali Trip",
        guest: "John Doe",
        status: "Draft"
    }, 403, false);

    console.log("=== TESTS COMPLETE ===");
    process.exit(0);
}

runAll();
