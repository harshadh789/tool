require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const EXPECTED_STAGING_HOST = 'iqqkuqgsvuciunmvtmdr.supabase.co';

function isSafeSupabaseUrl(urlStr) {
    if (!urlStr) return false;
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:') return false;
        if (u.hostname !== EXPECTED_STAGING_HOST) return false;
        if (u.username || u.password) return false;
        if (u.port && u.port !== '443') return false;
        if (u.search || u.hash) return false;
        return true;
    } catch (e) {
        return false;
    }
}

async function runCheck() {
    console.log("=== SUPABASE STAGING READINESS CHECK ===");
    
    const url = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url) {
        console.error("[FAIL] SUPABASE_URL is missing.");
        process.exit(1);
    }
    
    if (!isSafeSupabaseUrl(url)) {
        console.error("[FAIL] SUPABASE_URL does not strictly match the expected staging host or is malformed.");
        process.exit(1);
    }
    console.log("[PASS] Staging hostname matched the expected project.");

    if (!secretKey) {
        console.error("[FAIL] Required server-side secret key is missing.");
        process.exit(1);
    }
    console.log("[PASS] Required server-side key is present (value hidden).");

    const supabaseAdmin = createClient(url, secretKey);
    const tables = [
        'user_roles',
        'itineraries',
        'status_history',
        'secure_share_links'
    ];

    console.log("\n--- Checking Table Access ---");
    let allPassed = true;

    for (const table of tables) {
        try {
            const { error, count } = await supabaseAdmin
                .from(table)
                .select('*', { count: 'exact', head: true });
                
            if (error) {
                console.error(`[FAIL] Could not query ${table}: ${error.message}`);
                allPassed = false;
            } else {
                console.log(`[PASS] Queried ${table} successfully. Row count: ${count}`);
            }
        } catch (e) {
            console.error(`[FAIL] Exception while querying ${table}: ${e.message}`);
            allPassed = false;
        }
    }

    console.log("\n=== CHECK COMPLETE ===");
    if (!allPassed) {
        process.exit(1);
    }
}

runCheck();
