/**
 * Phase 3B — Secure Customer Itinerary Sharing Regression Tests
 * 
 * Verifies:
 * 1. Cryptographically random token generation and SHA-256 storage (token hash only).
 * 2. Role and ownership permissions for ADMIN, SALES, and OPS.
 * 3. Token validation, expiration rejection, and revocation rejection.
 * 4. Customer-facing data sanitization (stripping supplier costs, profit margins, staff notes, internal IDs).
 * 5. Share link listing and management endpoints.
 */

const assert = require('assert');
const request = require('supertest');
const crypto = require('crypto');

// Set test environment
process.env.STORAGE_PROVIDER = 'supabase';
process.env.SUPABASE_URL = 'https://iqqkuqgsvuciunmvtmdr.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'mock-pub-key';
process.env.SUPABASE_SECRET_KEY = 'mock-secret-key';
process.env.PORT = 0;

// In-memory mock database state
let mockItineraries = new Map();
let mockShareLinks = new Map();

const mockUsers = {
    'admin-token': { id: 'usr-admin-1', email: 'admin@campfly.in', role: 'ADMIN', is_active: true },
    'sales-1-token': { id: 'usr-sales-1', email: 'sales1@campfly.in', role: 'SALES', is_active: true },
    'sales-2-token': { id: 'usr-sales-2', email: 'sales2@campfly.in', role: 'SALES', is_active: true },
    'ops-token': { id: 'usr-ops-1', email: 'ops@campfly.in', role: 'OPS', is_active: true },
    'inactive-token': { id: 'usr-inactive', email: 'inactive@campfly.in', role: 'SALES', is_active: false }
};

function resetMockDb() {
    mockItineraries.clear();
    mockShareLinks.clear();
}

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
                                    if (col === 'id') {
                                        for (const record of mockItineraries.values()) {
                                            if (record.id === val) return { data: { ...record }, error: null };
                                        }
                                        return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                    }
                                    return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                }
                            })
                        };
                        return chain;
                    }
                };
            }

            if (table === 'secure_share_links') {
                return {
                    insert: (rows) => ({
                        select: () => ({
                            single: async () => {
                                const row = rows[0];
                                const id = 'link-' + Math.random().toString(36).substring(2, 9);
                                const record = {
                                    id,
                                    ...row,
                                    revoked_at: null
                                };
                                mockShareLinks.set(id, record);
                                return { data: record, error: null };
                            }
                        })
                    }),
                    select: (cols) => {
                        return {
                            eq: (col, val) => {
                                return {
                                    order: (orderCol, { ascending }) => {
                                        // Searching by itinerary_id
                                        const matches = [];
                                        for (const l of mockShareLinks.values()) {
                                            if (l[col] === val) matches.push({ ...l });
                                        }
                                        matches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                                        return Promise.resolve({ data: matches, error: null });
                                    },
                                    single: async () => {
                                        if (col === 'token_hash') {
                                            for (const l of mockShareLinks.values()) {
                                                if (l.token_hash === val) return { data: { ...l }, error: null };
                                            }
                                            return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                        }
                                        if (col === 'id') {
                                            const found = mockShareLinks.get(val);
                                            if (found) return { data: { ...found }, error: null };
                                            return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                        }
                                        return { data: null, error: { code: 'PGRST116', message: 'Not found' } };
                                    }
                                };
                            }
                        };
                    },
                    update: (updates) => ({
                        eq: (col, val) => ({
                            select: () => ({
                                single: async () => {
                                    const found = mockShareLinks.get(val);
                                    if (!found) return { data: null, error: { message: 'Not found' } };
                                    Object.assign(found, updates);
                                    return { data: { ...found }, error: null };
                                }
                            })
                        })
                    })
                };
            }

            return {};
        }
    };
}

// Instantiate server with mocked adapter
const db = require('../api/db.js');
const serverModule = require('../api/server.js');
const app = serverModule;

const mockClient = createMockSupabaseClient();
db.setClient(mockClient);
if (typeof app.setDependencies === 'function') {
    app.setDependencies(mockClient, mockClient);
}

async function runTests() {
    console.log("=== PHASE 3B: SECURE CUSTOMER SHARING REGRESSION TESTS ===");
    resetMockDb();

    let passed = 0;
    let total = 0;

    async function test(name, fn) {
        total++;
        try {
            await fn();
            console.log(`✅ [PASS] ${total}. ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${total}. ${name}`);
            console.error(err);
            process.exit(1);
        }
    }

    // Seed test itineraries with sensitive fields
    const adminItin = {
        id: 'itin-uuid-1',
        quote_id: 'CMP-2026-SHARE-01',
        owner_id: 'usr-admin-1',
        status: 'Confirmed',
        is_voucher_mode: false,
        guest_name: 'Priya Patel',
        title: 'Himalayan Luxury Escape',
        start_date: '2026-11-10',
        end_date: '2026-11-15',
        guest_count: 2,
        total_amount: 85000,
        currency: 'INR',
        version: 1,
        content: {
            id: 'CMP-2026-SHARE-01',
            title: 'Himalayan Luxury Escape',
            guest: 'Priya Patel',
            adults: 2,
            start: '2026-11-10',
            end: '2026-11-15',
            duration: '6 Days / 5 Nights',
            baseCost: 85000,
            currency: 'INR',
            advAmount: 30000,
            advDate: '2026-10-25',
            balDate: '2026-11-05',
            // SENSITIVE FIELDS TO BE STRIPPED:
            supplierCost: 45000,
            netCost: 45000,
            profitMargin: 40000,
            internalNotes: 'Supplier discount negotiated with Grand Resort. Keep secret from guest.',
            staffNotes: 'VIP guest - direct family of managing director.',
            agentCommission: 5000,
            days: [
                {
                    title: 'Day 1 - Arrival in Manali',
                    desc: 'Private pickup from airport. Check in to mountain view villa.',
                    img: 'https://images.unsplash.com/photo-example-1',
                    stay: 'Manali Heights',
                    internalCost: 5000 // SENSITIVE
                }
            ],
            hotels: [
                {
                    name: 'The Himalayan Resort & Spa',
                    star: '5 star',
                    room: 'Royal Suite',
                    nights: '5 Nights',
                    meals: { b: true, d: true },
                    supplierRate: 35000, // SENSITIVE
                    internalNotes: 'Complimentary room upgrade arranged' // SENSITIVE
                }
            ],
            inc: 'Luxury transport\nDaily breakfast & dinner\nPrivate guided treks',
            exc: 'Airfare\nPersonal shopping',
            terms: 'Standard cancellation charges apply.'
        }
    };

    const salesItin = {
        id: 'itin-uuid-2',
        quote_id: 'CMP-2026-SHARE-02',
        owner_id: 'usr-sales-1', // owned by sales 1
        status: 'Requested',
        is_voucher_mode: false,
        guest_name: 'Rohit Verma',
        title: 'Goa Coastal Serenity',
        start_date: '2026-12-01',
        end_date: '2026-12-05',
        guest_count: 4,
        total_amount: 60000,
        currency: 'INR',
        version: 1,
        content: {
            id: 'CMP-2026-SHARE-02',
            title: 'Goa Coastal Serenity',
            guest: 'Rohit Verma',
            adults: 4,
            baseCost: 60000,
            profitMargin: 15000,
            days: [{ title: 'Day 1 - Beachfront Sunset', desc: 'Welcome drinks at the resort.' }],
            hotels: [{ name: 'Taj Exotica Goa', nights: '4 Nights' }]
        }
    };

    const legacyUnassignedItin = {
        id: 'itin-uuid-3',
        quote_id: 'CMP-2026-SHARE-03',
        owner_id: null, // Legacy unassigned
        status: 'Draft',
        guest_name: 'Legacy Guest',
        title: 'Unassigned Tour',
        content: { id: 'CMP-2026-SHARE-03', title: 'Unassigned Tour' }
    };

    mockItineraries.set('CMP-2026-SHARE-01', adminItin);
    mockItineraries.set('CMP-2026-SHARE-02', salesItin);
    mockItineraries.set('CMP-2026-SHARE-03', legacyUnassignedItin);

    // 1. LINK CREATION & TOKEN SECURITY
    let sharedToken1 = null;
    let shareLinkId1 = null;

    await test("ADMIN can create a secure share link with cryptographically random token", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-01/share')
            .set('Authorization', 'Bearer admin-token')
            .send({ expiresInDays: 30 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert(res.body.link.token);
        assert.strictEqual(typeof res.body.link.token, 'string');
        assert.strictEqual(res.body.link.token.length, 64); // 32 bytes hex = 64 characters
        assert(res.body.link.url.includes('/view.html?token=' + res.body.link.token));

        sharedToken1 = res.body.link.token;
        shareLinkId1 = res.body.link.id;

        // Verify in DB: ONLY token_hash is stored!
        const storedInDb = mockShareLinks.get(shareLinkId1);
        assert(storedInDb);
        assert.strictEqual(storedInDb.itinerary_id, 'itin-uuid-1');
        assert.strictEqual(storedInDb.created_by, 'usr-admin-1');

        // Confirm DB stores exact SHA-256 hash of token
        const expectedHash = crypto.createHash('sha256').update(sharedToken1).digest('hex');
        assert.strictEqual(storedInDb.token_hash, expectedHash);
        assert.strictEqual(storedInDb.token, undefined); // Plaintext token NOT in database
    });

    await test("Default expiration is 30 days into the future", async () => {
        const stored = mockShareLinks.get(shareLinkId1);
        const expiresAt = new Date(stored.expires_at).getTime();
        const now = Date.now();
        const diffDays = Math.round((expiresAt - now) / (1000 * 60 * 60 * 24));
        assert.strictEqual(diffDays, 30);
    });

    // 2. ROLE & OWNERSHIP PERMISSIONS ON SHARE CREATION
    let salesToken = null;
    let salesLinkId = null;

    await test("SALES can create a share link for their own itinerary", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-02/share')
            .set('Authorization', 'Bearer sales-1-token')
            .send({ expiresInDays: 14 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        salesToken = res.body.link.token;
        salesLinkId = res.body.link.id;
    });

    await test("SALES is blocked from creating share links for another agent's itinerary (403)", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-02/share') // owned by sales-1
            .set('Authorization', 'Bearer sales-2-token')
            .send({ expiresInDays: 30 });

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Sales can only create share links for their own itineraries"));
    });

    await test("SALES is blocked from creating share links for legacy unassigned itinerary (403)", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-03/share')
            .set('Authorization', 'Bearer sales-1-token')
            .send({ expiresInDays: 30 });

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Legacy unassigned records cannot be shared by Sales"));
    });

    await test("OPS can create a share link for any itinerary", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-02/share')
            .set('Authorization', 'Bearer ops-token')
            .send({ expiresInDays: 7 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
    });

    await test("Unauthenticated request to create share link is rejected (401)", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-01/share')
            .send({ expiresInDays: 30 });

        assert.strictEqual(res.status, 401);
    });

    await test("Inactive staff user is blocked from creating share link (403)", async () => {
        const res = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-01/share')
            .set('Authorization', 'Bearer inactive-token')
            .send({ expiresInDays: 30 });

        assert.strictEqual(res.status, 403);
    });

    // 3. CUSTOMER DATA SANITIZATION & LEAK PREVENTION
    await test("Customer can retrieve itinerary using valid token without staff authentication", async () => {
        const res = await request(app)
            .get('/api/public/itinerary/' + sharedToken1);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert(res.body.itinerary);
        assert.strictEqual(res.body.itinerary.title, 'Himalayan Luxury Escape');
        assert.strictEqual(res.body.itinerary.guest, 'Priya Patel');
    });

    await test("Customer payload STRICTLY strips supplier costs, profit margins, and internal notes", async () => {
        const res = await request(app)
            .get('/api/public/itinerary/' + sharedToken1);

        const itin = res.body.itinerary;

        // Internal financial secrets MUST BE UNDEFINED
        assert.strictEqual(itin.supplierCost, undefined);
        assert.strictEqual(itin.netCost, undefined);
        assert.strictEqual(itin.profitMargin, undefined);
        assert.strictEqual(itin.agentCommission, undefined);
        assert.strictEqual(itin.internalNotes, undefined);
        assert.strictEqual(itin.staffNotes, undefined);

        // Internal database tokens and IDs MUST BE UNDEFINED
        assert.strictEqual(itin.token_hash, undefined);
        assert.strictEqual(itin.owner_id, undefined);
        assert.strictEqual(itin.version, undefined);

        // Verify hotel internal fields are stripped
        assert(itin.hotels.length > 0);
        const hotel = itin.hotels[0];
        assert.strictEqual(hotel.name, 'The Himalayan Resort & Spa');
        assert.strictEqual(hotel.supplierRate, undefined);
        assert.strictEqual(hotel.internalNotes, undefined);

        // Verify day internal fields are stripped
        assert(itin.days.length > 0);
        const day = itin.days[0];
        assert.strictEqual(day.title, 'Day 1 - Arrival in Manali');
        assert.strictEqual(day.internalCost, undefined);

        // Verify customer-facing verified bank details are included
        assert.strictEqual(itin.bankDetails.name, 'CAMPFLY TOURS LLP');
        assert.strictEqual(itin.bankDetails.account, '10292311723');
        assert.strictEqual(itin.bankDetails.ifsc, 'IDFB0080511');
        assert.strictEqual(itin.bankDetails.upi, 'Campfly@idfcbank');
    });

    // 4. INVALID / MALFORMED TOKEN HANDLING
    await test("Customer request with non-existent token returns 404 Not Found", async () => {
        const fakeToken = crypto.randomBytes(32).toString('hex');
        const res = await request(app)
            .get('/api/public/itinerary/' + fakeToken);

        assert.strictEqual(res.status, 404);
        assert(res.body.error.includes("Invalid or expired share link"));
    });

    await test("Customer request with malformed or short token returns 404 Not Found", async () => {
        const res = await request(app)
            .get('/api/public/itinerary/short-fake-token');

        assert.strictEqual(res.status, 404);
    });

    // 5. EXPIRATION ENFORCEMENT
    await test("Expired token is rejected with 410 Gone / Expired", async () => {
        // Artificially expire the token in mock DB
        const link = mockShareLinks.get(shareLinkId1);
        const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1 hour ago
        link.expires_at = pastDate;

        const res = await request(app)
            .get('/api/public/itinerary/' + sharedToken1);

        assert.strictEqual(res.status, 410);
        assert(res.body.error.includes("This share link has expired"));

        // Restore expiration for revocation test
        link.expires_at = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    });

    // 6. REVOCATION ENFORCEMENT
    await test("ADMIN can revoke an active share link via /api/shares/:linkId/revoke", async () => {
        const res = await request(app)
            .post(`/api/shares/${shareLinkId1}/revoke`)
            .set('Authorization', 'Bearer admin-token');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.id, shareLinkId1);
        assert(res.body.revoked_at);

        // Confirm database record was updated
        const stored = mockShareLinks.get(shareLinkId1);
        assert(stored.revoked_at);
    });

    await test("Revoked token is immediately rejected for customer with 410 Gone / Revoked", async () => {
        const res = await request(app)
            .get('/api/public/itinerary/' + sharedToken1);

        assert.strictEqual(res.status, 410);
        assert(res.body.error.includes("This share link has been revoked"));
    });

    // 7. LISTING SHARE LINKS
    await test("ADMIN can list share links for an itinerary", async () => {
        const res = await request(app)
            .get('/api/itineraries/CMP-2026-SHARE-01/shares')
            .set('Authorization', 'Bearer admin-token');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert(Array.isArray(res.body.links));
        assert(res.body.links.length > 0);

        const link = res.body.links[0];
        assert.strictEqual(link.id, shareLinkId1);
        assert.strictEqual(link.is_active, false); // It was revoked above!
        assert.strictEqual(link.token_hash, undefined); // Token hash NOT exposed to client
        assert.strictEqual(link.token, undefined); // Token NOT exposed to client
    });

    await test("SALES can list share links for own itinerary", async () => {
        const res = await request(app)
            .get('/api/itineraries/CMP-2026-SHARE-02/shares')
            .set('Authorization', 'Bearer sales-1-token');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert(res.body.links.length > 0);
    });

    await test("SALES is blocked from listing share links for another agent's itinerary (403)", async () => {
        const res = await request(app)
            .get('/api/itineraries/CMP-2026-SHARE-02/shares')
            .set('Authorization', 'Bearer sales-2-token');

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Sales can only view share links for their own itineraries"));
    });

    // 8. REVOCATION ROLE PERMISSIONS
    await test("SALES can revoke share link on own itinerary", async () => {
        const res = await request(app)
            .post(`/api/shares/${salesLinkId}/revoke`)
            .set('Authorization', 'Bearer sales-1-token');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
    });

    await test("SALES is blocked from revoking share link on another agent's itinerary (403)", async () => {
        // Create new link on sales-1 itinerary
        const createRes = await request(app)
            .post('/api/itineraries/CMP-2026-SHARE-02/share')
            .set('Authorization', 'Bearer sales-1-token')
            .send({ expiresInDays: 30 });
        const newLinkId = createRes.body.link.id;

        // Sales 2 attempts to revoke
        const res = await request(app)
            .post(`/api/shares/${newLinkId}/revoke`)
            .set('Authorization', 'Bearer sales-2-token');

        assert.strictEqual(res.status, 403);
        assert(res.body.error.includes("Sales can only revoke share links for their own itineraries"));
    });

    await test("Revoking a non-existent share link returns 404", async () => {
        const res = await request(app)
            .post('/api/shares/non-existent-id/revoke')
            .set('Authorization', 'Bearer admin-token');

        assert.strictEqual(res.status, 404);
        assert(res.body.error.includes("Share link not found"));
    });

    await test("Unauthenticated revocation request is rejected (401)", async () => {
        const res = await request(app)
            .post(`/api/shares/${salesLinkId}/revoke`);

        assert.strictEqual(res.status, 401);
    });

    console.log(`\n========================================`);
    console.log(`SUMMARY: ${passed} / ${total} tests passed.`);
    console.log(`========================================\n`);

    if (passed !== total) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error("FATAL ERROR IN TEST SUITE:", err);
    process.exit(1);
});
