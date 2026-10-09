const { runMigrationProcess, APPROVED_QUOTE_IDS } = require('../api/migrate_to_supabase.js');

async function runTest() {
    console.log("=== MIGRATION SAFEGUARD TESTS ===");

    // 1. Check if rejected quote IDs are in the manifest
    const hasRejected1 = APPROVED_QUOTE_IDS.includes('CMP-2026-001222');
    const hasRejected2 = APPROVED_QUOTE_IDS.includes('CMP-2026-001333');
    if (!hasRejected1 && !hasRejected2) {
        console.log("[PASS] Rejected demo IDs are not in the approved manifest.");
    } else {
        console.error("[FAIL] Rejected demo IDs found in the approved manifest.");
    }

    const mockEnv = {
        STAGING_MIGRATION_CONFIRM: 'true',
        SUPABASE_URL: 'https://iqqkuqgsvuciunmvtmdr.supabase.co',
        SUPABASE_SECRET_KEY: 'mock-key'
    };

    const mockGetZohoFiles = async () => [];
    const mockGetZohoFileContent = async () => ({});
    const mockInsertToSupabase = async () => null;

    // 2. An empty manifest cannot proceed to the write phase.
    try {
        await runMigrationProcess({
            isExecute: true,
            env: mockEnv,
            getZohoFiles: mockGetZohoFiles,
            getZohoFileContent: mockGetZohoFileContent,
            insertToSupabase: mockInsertToSupabase,
            logger: { log: () => {}, error: () => {}, warn: () => {} }
        });
        console.error("[FAIL] Script did not fail closed on an empty manifest.");
    } catch (err) {
        if (err.message.includes("APPROVED_QUOTE_IDS manifest is empty")) {
            console.log("[PASS] Script fails closed on empty manifest.");
        } else {
            console.error(`[FAIL] Unexpected error message: ${err.message}`);
        }
    }

    // 3. Existing staging safeguards remain intact.
    try {
        await runMigrationProcess({
            isExecute: true,
            env: { ...mockEnv, SUPABASE_URL: 'https://production.supabase.co' },
            getZohoFiles: mockGetZohoFiles,
            getZohoFileContent: mockGetZohoFileContent,
            insertToSupabase: mockInsertToSupabase,
            logger: { log: () => {}, error: () => {}, warn: () => {} }
        });
        console.error("[FAIL] Script did not reject invalid staging host.");
    } catch (err) {
        if (err.message.includes("does not match the approved staging environment hostname")) {
            console.log("[PASS] Staging URL safeguard remains intact.");
        } else {
            console.error(`[FAIL] Unexpected error message: ${err.message}`);
        }
    }
}

runTest();
