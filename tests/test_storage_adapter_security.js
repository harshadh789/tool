require('dotenv').config();
const request = require('supertest');

// We don't want to actually connect to WorkDrive if Supabase fails.
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
                return { data: { user: { id: 'admin-1' } } };
            }
        },
        from: (table) => {
            return {
                select: () => ({
                    eq: () => ({
                        single: async () => ({ data: { role: 'ADMIN', is_active: true } })
                    })
                }),
                insert: () => ({
                    select: () => ({
                        single: async () => {
                            throw new Error("Simulated Supabase failure");
                        }
                    })
                }),
                update: () => ({
                    eq: () => ({
                        eq: () => ({
                            select: () => ({
                                single: async () => {
                                    throw new Error("Simulated Supabase failure");
                                }
                            })
                        })
                    })
                })
            };
        }
    };
};

process.env.PORT = 0;
const app = require('../api/server.js');

async function testUrl(name, url, expectSuccess) {
    mockUploadCalled = false;
    process.env.STORAGE_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = url;
    
    const res = await request(app)
        .post('/api/saveItinerary')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ itinerary: { id: "SEC-01", status: "Draft" } });
    
    // In our mock, if Supabase succeeds passing validation, it hits our mocked failure -> 500
    // If it fails validation, it gets caught by the guard -> 500 "Safety abort"
    // To distinguish, we check the error message.
    const isGuardTriggered = res.body.error && res.body.error.includes('Safety abort');
    
    // If expectSuccess is true, the guard should NOT trigger (isGuardTriggered = false)
    const passed = (expectSuccess && !isGuardTriggered) || (!expectSuccess && isGuardTriggered);

    if (passed) {
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name} - URL: ${url} - Guard triggered: ${isGuardTriggered}`);
    }
}

async function runAll() {
    console.log("=== ADAPTER SECURITY TESTS ===");
    
    // 1. The exact staging URL is accepted.
    await testUrl("Exact staging URL accepted", "https://iqqkuqgsvuciunmvtmdr.supabase.co", true);
    
    // 2. A trailing slash is handled as intended.
    await testUrl("Trailing slash accepted", "https://iqqkuqgsvuciunmvtmdr.supabase.co/", true);
    
    // 3. Malformed URLs are rejected.
    await testUrl("Malformed URL rejected", "not-a-url", false);
    await testUrl("Empty URL rejected", "", false);
    
    // 4. Lookalike hostnames are rejected.
    await testUrl("Lookalike domain rejected", "https://iqqkuqgsvuciunmvtmdr.supabase.co.attacker.example", false);
    await testUrl("Lookalike query rejected", "https://attacker.example/?host=iqqkuqgsvuciunmvtmdr.supabase.co", false);
    
    // 5. URLs with credentials, non-default ports, query strings or fragments are rejected.
    await testUrl("Credentials rejected", "https://user:pass@iqqkuqgsvuciunmvtmdr.supabase.co", false);
    await testUrl("Non-default port rejected", "https://iqqkuqgsvuciunmvtmdr.supabase.co:8443", false);
    await testUrl("Query string rejected", "https://iqqkuqgsvuciunmvtmdr.supabase.co/?apiKey=foo", false);
    await testUrl("Fragment rejected", "https://iqqkuqgsvuciunmvtmdr.supabase.co/#foo", false);
    
    // 6. HTTP is rejected.
    await testUrl("HTTP protocol rejected", "http://iqqkuqgsvuciunmvtmdr.supabase.co", false);
    
    // 7. Production and unknown hosts are rejected.
    await testUrl("Production host rejected", "https://campfly-prod.supabase.co", false);
    
    // 8. Invalid STORAGE_PROVIDER values fail closed.
    async function testProvider(name, val, expectGuardError, expectedProvider) {
        if (val === undefined) {
            delete process.env.STORAGE_PROVIDER;
        } else {
            process.env.STORAGE_PROVIDER = val;
        }
        process.env.SUPABASE_URL = "https://iqqkuqgsvuciunmvtmdr.supabase.co";
        mockUploadCalled = false;
        
        const res = await request(app)
            .post('/api/saveItinerary')
            .set('Authorization', 'Bearer valid-admin-token')
            .send({ itinerary: { id: "SEC-02", status: "Draft" } });
            
        let isGuardTriggered = !!(res.body.error && res.body.error.includes("Invalid STORAGE_PROVIDER"));
        let passed = isGuardTriggered === expectGuardError;
        
        // if expectedProvider is workdrive, we expect WorkDrive mock to be called (mockUploadCalled) or blocked by something else (here we mock Workdrive as success)
        if (passed && !expectGuardError && expectedProvider === 'workdrive') {
            passed = mockUploadCalled === true;
        } else if (passed && !expectGuardError && expectedProvider === 'supabase') {
            // Simulated Supabase failure will trigger generic 500
            passed = res.status === 500 && res.body.error && res.body.error.includes("Failed to sync");
        }
        
        if (passed) {
            console.log(`[PASS] ${name}`);
        } else {
            console.error(`[FAIL] ${name} - Val: '${val}' - GuardTriggered: ${isGuardTriggered} - UploadCalled: ${mockUploadCalled} - Status: ${res.status} - Error: ${res.body.error}`);
        }
    }
    
    await testProvider("Provider setting absent (undefined)", undefined, false, 'workdrive');
    await testProvider("Explicit workdrive", "workdrive", false, 'workdrive');
    await testProvider("Explicit supabase with correct staging URL", "supabase", false, 'supabase');
    await testProvider("Empty string", "", true, null);
    await testProvider("Whitespace string", "   ", true, null);
    await testProvider("Typo string", "supabse", true, null);
    await testProvider("Unknown provider", "aws", true, null);
    
    // 9. A failed Supabase operation never triggers a WorkDrive write.
    process.env.STORAGE_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = "https://iqqkuqgsvuciunmvtmdr.supabase.co";
    mockUploadCalled = false;
    const failRes = await request(app)
        .post('/api/saveItinerary')
        .set('Authorization', 'Bearer valid-admin-token')
        .send({ itinerary: { id: "SEC-01", status: "Draft" } });
    
    if (!mockUploadCalled && failRes.status === 500 && !failRes.body.error.includes("Safety abort")) {
        console.log("[PASS] Failed Supabase operation does not trigger WorkDrive write.");
    } else {
        console.error("[FAIL] Failed Supabase triggered WorkDrive or bad status.", { mockUploadCalled, status: failRes.status, error: failRes.body.error });
    }

    // 10. The secret key remains server-side and is not returned by `/api/auth/config`.
    // The server uses SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY from initial require.
    const confRes = await request(app).get('/api/auth/config');
    const secretKeyStr = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || 'secret';
    if (!JSON.stringify(confRes.body).includes(secretKeyStr)) {
         console.log("[PASS] Secret key not returned by /api/auth/config.");
    } else {
         console.error("[FAIL] Secret key exposed by /api/auth/config.");
    }

    console.log("=== TESTS COMPLETE ===");
    process.exit(0);
}

runAll();
