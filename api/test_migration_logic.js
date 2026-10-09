const { runMigrationProcess, validateEnvironment, EXPECTED_STAGING_HOST } = require('./migrate_to_supabase');

// Mock logger that collects outputs silently
class MockLogger {
    constructor() {
        this.logs = [];
        this.errors = [];
        this.warns = [];
    }
    log(msg) { this.logs.push(msg); }
    error(msg) { this.errors.push(msg); }
    warn(msg) { this.warns.push(msg); }
    printAll() {
        this.logs.forEach(m => console.log(m));
        this.warns.forEach(m => console.warn(m));
        this.errors.forEach(m => console.error(m));
    }
    reset() { this.logs = []; this.errors = []; this.warns = []; }
}

async function runTests() {
    console.log("=== RUNNING ISOLATED MIGRATION LOGIC TESTS ===");
    let passed = 0;
    let failed = 0;

    const assertThrows = (fn, errorSnippet, name) => {
        try {
            fn();
            console.error(`[FAIL] ${name} (Did not throw)`);
            failed++;
        } catch (e) {
            if (e.message.includes(errorSnippet)) {
                console.log(`[PASS] ${name}`);
                passed++;
            } else {
                console.error(`[FAIL] ${name} (Threw wrong error: ${e.message})`);
                failed++;
            }
        }
    };

    const assertEqual = (actual, expected, name) => {
        if (actual === expected) {
            console.log(`[PASS] ${name}`);
            passed++;
        } else {
            console.error(`[FAIL] ${name} (Expected ${expected}, got ${actual})`);
            failed++;
        }
    };

    // 1. Correct staging reference is accepted
    const validEnv = {
        STAGING_MIGRATION_CONFIRM: 'true',
        SUPABASE_URL: `https://${EXPECTED_STAGING_HOST}`,
        SUPABASE_SECRET_KEY: 'mock-key'
    };
    try {
        validateEnvironment(validEnv);
        console.log("[PASS] Correct staging reference is accepted");
        passed++;
    } catch(e) {
        console.error("[FAIL] Correct staging reference is accepted. Error:", e.message);
        failed++;
    }

    // 2. Wrong or production reference is rejected
    assertThrows(
        () => validateEnvironment({ ...validEnv, SUPABASE_URL: 'https://production-ref.supabase.co' }),
        "does not match the approved staging environment hostname",
        "Wrong or production reference is rejected"
    );

    // 3. Missing staging confirmation is rejected
    assertThrows(
        () => validateEnvironment({ ...validEnv, STAGING_MIGRATION_CONFIRM: 'false' }),
        "Safety abort: STAGING_MIGRATION_CONFIRM=true is required",
        "Missing staging confirmation is rejected"
    );

    // Setup Mock Dependencies for Migration Routine
    const defaultMocks = () => {
        let insertedRecords = [];
        let dbConflicts = [];
        return {
            insertedRecords,
            dbConflicts,
            getZohoFiles: async () => ([
                { id: 'f1', attributes: { extn: 'json' } },
                { id: 'f2', attributes: { extn: 'json' } }, // duplicate source
                { id: 'f3', attributes: { extn: 'json' } }, // duplicate source
                { id: 'f4', attributes: { extn: 'json' } }, // unknown
                { id: 'f5', attributes: { extn: 'json' } }, // malformed num
                { id: 'f6', attributes: { extn: 'json' } }  // db conflict
            ]),
            getZohoFileContent: async (id) => {
                const mocks = {
                    'f1': { id: 'CMP-2026-001222', status: 'Draft' }, // approved
                    'f2': { id: 'TEST-BTN-001', status: 'Draft' }, // duplicate source file 1
                    'f3': { id: 'TEST-BTN-001', status: 'Requested' }, // duplicate source file 2
                    'f4': { id: 'UNKNOWN-123', status: 'Draft' }, // unknown
                    'f5': { id: 'CMP-2026-001333', adults: 'two', baseCost: '$400' }, // approved, malformed nums
                    'f6': { id: 'CMP-2026-001222', status: 'Draft' } // DB conflict trigger (same as f1, handled by DB)
                };
                return mocks[id] || {};
            },
            insertToSupabase: async (record) => {
                if (dbConflicts.includes(record.quote_id)) {
                    return { code: '23505' }; // unique constraint error
                }
                insertedRecords.push(record);
                return null;
            },
            logger: new MockLogger()
        };
    };

    // 4. Missing --execute prevents writes
    let mocks = defaultMocks();
    await runMigrationProcess({ isExecute: false, env: validEnv, ...mocks });
    assertEqual(mocks.insertedRecords.length, 0, "Missing --execute prevents writes");

    // Execution with --execute
    mocks = defaultMocks();
    // simulate that CMP-2026-001222 will conflict in DB on second row f6 (wait f1 already inserts it)
    // Actually our test feeds both f1 and f6 as 'CMP-2026-001222' so f1 & f6 are duplicate sources? No, different file IDs mapping to same quote_id.
    // The script catches duplicate sources locally if quote_id matches! So f1 & f6 will be caught as a source duplicate.
    // Let's modify the mock to feed a DB conflict directly.
    mocks.dbConflicts.push('CMP-2026-001222'); 
    
    // Adjust files for correct test routing
    mocks.getZohoFiles = async () => ([
        { id: 'f1', attributes: { extn: 'json' } }, // DB Conflict
        { id: 'f2', attributes: { extn: 'json' } }, // dup source
        { id: 'f3', attributes: { extn: 'json' } }, // dup source
        { id: 'f4', attributes: { extn: 'json' } }, // unknown ID
        { id: 'f5', attributes: { extn: 'json' } }  // malformed numbers -> successful import with nulls
    ]);

    const results = await runMigrationProcess({ isExecute: true, env: validEnv, ...mocks });
    
    // 5. Approved quote IDs are the only IDs eligible for import
    // f5 (CMP-2026-001333) should be imported. f1 is db conflict.
    assertEqual(results.imported, 1, "Approved quote IDs are the only IDs eligible for import");
    
    // 6. Unknown and excluded quote IDs are rejected
    // f4 is UNKNOWN-123
    assertEqual(results.excluded, 1, "Unknown and excluded quote IDs are rejected");
    
    // 7. Duplicate source records are skipped
    // f2 and f3 have the same quote_id (TEST-BTN-001)
    assertEqual(results.duplicateFile, 1, "Duplicate source records are skipped");
    
    // 8. Malformed numeric values never produce NaN
    const f5Record = mocks.insertedRecords.find(r => r.quote_id === 'CMP-2026-001333');
    if (f5Record && f5Record.guest_count === null && f5Record.total_amount === null) {
        console.log("[PASS] Malformed numeric values never produce NaN in the insertion payload");
        passed++;
    } else {
        console.error("[FAIL] Malformed numeric values did not become null");
        failed++;
    }

    // 9. Existing quote-ID conflicts are skipped without overwriting
    assertEqual(results.dbConflict, 1, "Existing quote-ID conflicts are skipped without overwriting");

    // 10. Sensitive values are not printed
    let logsSafe = true;
    const allLogs = [...mocks.logger.logs, ...mocks.logger.warns, ...mocks.logger.errors].join(' ');
    if (allLogs.includes('two') || allLogs.includes('$400') || allLogs.includes('sensitive_name')) {
        logsSafe = false;
    }
    if (logsSafe) {
        console.log("[PASS] Sensitive values are not printed by validation or error handling");
        passed++;
    } else {
        console.error("[FAIL] Sensitive values are not printed");
        failed++;
    }

    console.log(`\nTests finished. Passed: ${passed}, Failed: ${failed}`);
}

runTests().catch(e => console.error("Test framework error", e));
