// ==============================================================================
// Campfly Itinerary Tool - Real Staging Storage Integration Test
// Verifies direct signed-upload URL and customer PDF download against
// live staging Supabase instance (iqqkuqgsvuciunmvtmdr.supabase.co).
// USES STRICTLY SYNTHETIC TEST DATA (NO REAL CUSTOMER DATA ALTERED)
// ==============================================================================

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const assert = require('assert');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("Missing Supabase staging credentials in .env. Skipping staging storage integration.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
const db = require('../api/db.js');

async function runStagingIntegration() {
    console.log('=== RUNNING REAL STAGING SUPABASE STORAGE INTEGRATION TESTS ===');
    console.log(`Target Supabase Host: ${new URL(SUPABASE_URL).hostname}\n`);

    const synthId = crypto.randomUUID();
    const synthQuoteId = 'CMP-SYNTH-STAGING-' + Math.floor(Math.random() * 1000000);
    const synthToken = crypto.randomBytes(32).toString('hex');
    const synthTokenHash = crypto.createHash('sha256').update(synthToken).digest('hex');
    const validOwnerId = 'af154234-4581-4df4-a99d-e2f885f91112';
    let synthShareLinkId = null;

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
        }
    }

    try {
        // Step 0: Seed synthetic itinerary in staging database
        const { error: seedErr } = await supabase.from('itineraries').insert({
            id: synthId,
            quote_id: synthQuoteId,
            owner_id: validOwnerId,
            status: 'Confirmed',
            is_voucher_mode: false,
            guest_name: 'Synthetic Staging Guest',
            title: 'Synthetic Bali Staging Verification',
            version: 1,
            content: { id: synthQuoteId, title: 'Synthetic Bali Tour' }
        });
        if (seedErr) throw new Error(`Failed to seed synthetic itinerary: ${seedErr.message}`);

        // 1. Authorization: Request signed upload URL
        await test("Server authorizes short-lived signed upload URL for synthetic itinerary (v1)", async () => {
            const result = await db.createItineraryPdfUploadUrl(
                synthQuoteId,
                1,
                { id: validOwnerId },
                'ADMIN'
            );
            assert(result.signedUrl, "Must return signedUrl");
            assert(result.token, "Must return token");
            assert.strictEqual(result.version, 1);
            assert.strictEqual(result.quoteId, synthQuoteId);
            assert.strictEqual(result.path, `${synthId}/v1.pdf`);
        });

        // 2. Version mismatch enforcement
        await test("Requesting signed upload URL with mismatched version is rejected with 409", async () => {
            try {
                await db.createItineraryPdfUploadUrl(
                    synthQuoteId,
                    99,
                    { id: validOwnerId },
                    'ADMIN'
                );
                assert.fail("Should have thrown version mismatch error");
            } catch (err) {
                assert.strictEqual(err.statusCode, 409);
                assert(err.message.includes("Version mismatch"));
            }
        });

        // 3. Role authorization enforcement
        await test("Unauthorized role (OPS) is blocked from requesting signed upload URL with 403", async () => {
            try {
                await db.createItineraryPdfUploadUrl(
                    synthQuoteId,
                    1,
                    { id: validOwnerId },
                    'OPS'
                );
                assert.fail("Should have blocked OPS role");
            } catch (err) {
                assert.strictEqual(err.statusCode, 403);
                assert(err.message.includes("Unauthorized role"));
            }
        });

        // 4. Direct Browser-to-Storage Upload: Upload official PDF directly via signed URL
        const mockPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Campfly Staging Integration Real PDF) >>\nendobj\ntrailer\n<<>>\n%%EOF');
        const staffHash = crypto.createHash('sha256').update(mockPdfBytes).digest('hex');

        // 4a. Seed synthetic share link pointing to this itinerary
        const { data: linkData, error: linkErr } = await supabase.from('secure_share_links').insert({
            itinerary_id: synthId,
            token_hash: synthTokenHash,
            created_by: validOwnerId,
            expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
        }).select().single();
        if (linkErr) throw new Error(`Failed to seed synthetic share link: ${linkErr.message}`);
        synthShareLinkId = linkData.id;

        // 4b. Security Verification: Uploading invalid non-PDF payload to signed URL must be rejected on download (502)
        await test("Direct signed-upload of invalid non-PDF payload is rejected by customer download endpoint with 502", async () => {
            const { signedUrl } = await db.createItineraryPdfUploadUrl(
                synthQuoteId,
                1,
                { id: validOwnerId },
                'ADMIN'
            );

            // Attacker or corrupted client sends HTML pretending to be PDF
            const fakePayload = Buffer.from('<html><body>Fake Corrupted HTML pretending to be PDF</body></html>');
            const fakeUploadRes = await fetch(signedUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/pdf',
                    'x-upsert': 'true'
                },
                body: fakePayload
            });
            assert.strictEqual(fakeUploadRes.status, 200, "Signed URL accepts direct upload");

            // Customer attempts to download the stored document
            try {
                await db.getItineraryPdfByShareToken(synthToken);
                assert.fail("Should have rejected corrupted/non-PDF payload");
            } catch (err) {
                assert.strictEqual(err.statusCode, 502);
                assert(err.message.includes("not a valid PDF file"));
            }
        });

        // 4c. Direct browser-to-storage upload of valid PDF
        let activeSignedUrl = null;
        await test("Direct browser-to-storage upload: PUT valid PDF bytes to signed URL bypasses Vercel function limit", async () => {
            const { signedUrl } = await db.createItineraryPdfUploadUrl(
                synthQuoteId,
                1,
                { id: validOwnerId },
                'ADMIN'
            );
            activeSignedUrl = signedUrl;

            const uploadRes = await fetch(signedUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/pdf'
                },
                body: mockPdfBytes
            });

            assert.strictEqual(uploadRes.status, 200, "Direct PUT to Supabase Storage signed upload URL must return 200");
        });

        // 5. Customer downloads official PDF using share token and verifies exact SHA-256 byte match
        await test("Customer downloads official PDF using share token and receives exact matching SHA-256 hash", async () => {
            const { buffer, quoteId, version } = await db.getItineraryPdfByShareToken(synthToken);
            assert.strictEqual(quoteId, synthQuoteId);
            assert.strictEqual(version, 1);

            const customerHash = crypto.createHash('sha256').update(buffer).digest('hex');
            assert.strictEqual(customerHash, staffHash, "Customer downloaded bytes must match staff uploaded bytes identically");
        });

        // 6a. Single-use credential verification: The same signed URL cannot overwrite an uploaded object
        await test("The same signed URL cannot overwrite an uploaded object (single-use enforced)", async () => {
            const reuseRes = await fetch(activeSignedUrl, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/pdf'
                },
                body: Buffer.from('%PDF-1.4 attempted overwrite')
            });

            // Supabase storage without upsert rejects duplicate upload with 400 or 409 KeyAlreadyExists
            assert(reuseRes.status === 400 || reuseRes.status === 409, `Reuse must fail (received status ${reuseRes.status})`);
        });

        // 6b. Replacement URL refusal: A new signed upload URL is refused when a valid official PDF already exists
        await test("Replacement upload URL is refused with 409 when valid official PDF already exists, preserving customer download", async () => {
            try {
                await db.createItineraryPdfUploadUrl(
                    synthQuoteId,
                    1,
                    { id: validOwnerId },
                    'ADMIN'
                );
                assert.fail("Should have refused creating upload URL for already-published valid PDF");
            } catch (err) {
                assert.strictEqual(err.statusCode, 409);
                assert(err.message.includes("already been published"));
                assert(err.message.includes("Existing document is preserved"));
            }

            // Verify customer can STILL download the untouched valid PDF
            const { buffer } = await db.getItineraryPdfByShareToken(synthToken);
            const customerHash = crypto.createHash('sha256').update(buffer).digest('hex');
            assert.strictEqual(customerHash, staffHash, "Existing valid PDF remains completely intact and downloadable");
        });

        // 6c. A failed replacement upload does not remove the previous valid official PDF
        await test("A failed replacement upload does not remove the previous valid official PDF", async () => {
            try {
                await db.uploadItineraryPdf(
                    synthQuoteId,
                    Buffer.from('CORRUPT_NOT_A_PDF_BINARY'),
                    1,
                    { id: validOwnerId },
                    'ADMIN'
                );
                assert.fail("Should have rejected corrupt upload");
            } catch (err) {
                assert.strictEqual(err.statusCode, 400);
            }

            // Verify customer can STILL download the untouched valid PDF
            const { buffer } = await db.getItineraryPdfByShareToken(synthToken);
            const customerHash = crypto.createHash('sha256').update(buffer).digest('hex');
            assert.strictEqual(customerHash, staffHash, "Valid PDF preserved despite failed replacement upload");
        });

        // 7. Version Isolation: Itinerary edits increment version -> prevents serving stale v1 PDF
        await test("When itinerary version increments to v2, customer requesting PDF receives 404 until v2 PDF is uploaded", async () => {
            await supabase.from('itineraries').update({ version: 2 }).eq('id', synthId);

            try {
                await db.getItineraryPdfByShareToken(synthToken);
                assert.fail("Should have rejected stale PDF with 404");
            } catch (err) {
                assert.strictEqual(err.statusCode, 404);
                assert(err.message.includes("finalized by your travel consultant"));
            }
        });

        // 8. Expired Token Blocking
        await test("Customer PDF download with expired share token returns 410", async () => {
            await supabase.from('secure_share_links').update({
                expires_at: new Date(Date.now() - 3600000).toISOString()
            }).eq('id', synthShareLinkId);

            try {
                await db.getItineraryPdfByShareToken(synthToken);
                assert.fail("Should have rejected expired link");
            } catch (err) {
                assert.strictEqual(err.statusCode, 410);
                assert(err.message.includes("expired"));
            }
        });

        // 9. Revoked Token Blocking
        await test("Customer PDF download with revoked share token returns 410", async () => {
            await supabase.from('secure_share_links').update({
                revoked_at: new Date().toISOString()
            }).eq('id', synthShareLinkId);

            try {
                await db.getItineraryPdfByShareToken(synthToken);
                assert.fail("Should have rejected revoked link");
            } catch (err) {
                assert.strictEqual(err.statusCode, 410);
                assert(err.message.includes("revoked"));
            }
        });

    } finally {
        // Step 10: CLEAN UP ALL SYNTHETIC TEST ARTIFACTS
        console.log('\nCleaning up synthetic staging test data...');
        try {
            await supabase.storage.from('itinerary-pdfs').remove([`${synthId}/v1.pdf`, `${synthId}/v2.pdf`]);
            if (synthShareLinkId) {
                await supabase.from('secure_share_links').delete().eq('id', synthShareLinkId);
            }
            await supabase.from('itineraries').delete().eq('id', synthId);
            console.log('✅ Synthetic staging cleanup complete.\n');
        } catch (cleanupErr) {
            console.warn('Cleanup warning:', cleanupErr.message);
        }
    }

    console.log(`========================================`);
    console.log(`STAGING INTEGRATION SUMMARY: ${passed} / ${total} tests passed.`);
    console.log(`========================================\n`);

    if (passed !== total) {
        process.exit(1);
    }
}

runStagingIntegration().catch(err => {
    console.error("FATAL ERROR IN STAGING INTEGRATION:", err);
    process.exit(1);
});
