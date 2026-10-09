require('dotenv').config({ path: '../.env' });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const EXPECTED_STAGING_HOST = 'iqqkuqgsvuciunmvtmdr.supabase.co';

const APPROVED_QUOTE_IDS = [
    'CMP-2026-001222',
    'CMP-2026-001333'
];

function parseDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
}

function parseSafeInt(val, logger, fieldName, quoteId) {
    if (val === undefined || val === null || val === '') return null;
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
        logger.warn(`[WARNING] Quote ${quoteId}: Invalid numeric data for ${fieldName}. Setting to null.`);
        return null;
    }
    return parsed;
}

function parseSafeFloat(val, logger, fieldName, quoteId) {
    if (val === undefined || val === null || val === '') return null;
    const parsed = parseFloat(val);
    if (isNaN(parsed) || !isFinite(parsed)) {
        logger.warn(`[WARNING] Quote ${quoteId}: Invalid numeric data for ${fieldName}. Setting to null.`);
        return null;
    }
    return parsed;
}

function validateEnvironment(env) {
    if (env.STAGING_MIGRATION_CONFIRM !== 'true') {
        throw new Error("Safety abort: STAGING_MIGRATION_CONFIRM=true is required to prevent accidental production execution.");
    }
    
    if (!env.SUPABASE_URL) throw new Error("Supabase URL is missing.");
    
    let urlObj;
    try {
        urlObj = new URL(env.SUPABASE_URL);
    } catch(e) {
        throw new Error("Invalid SUPABASE_URL format.");
    }

    if (urlObj.hostname !== EXPECTED_STAGING_HOST) {
        throw new Error("Supabase URL does not match the approved staging environment hostname.");
    }

    const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
    if (!secret) throw new Error("Supabase Secret Key is missing.");

    return { supabaseUrl: env.SUPABASE_URL, supabaseSecret: secret };
}

async function runMigrationProcess(options) {
    const { isExecute, env, getZohoFiles, getZohoFileContent, insertToSupabase, logger } = options;

    const results = { skipped: 0, excluded: 0, imported: 0, failed: 0, duplicateFile: 0, dbConflict: 0 };
    const manifest = [];

    try {
        validateEnvironment(env);
    } catch (err) {
        logger.error(`[FATAL] ${err.message}`);
        throw err;
    }

    logger.log("=== SUPABASE STAGING MIGRATION ===");
    logger.log(`Execution Mode: ${isExecute ? 'LIVE IMPORT' : 'DRY RUN VALIDATION ONLY'}`);
    logger.log("----------------------------------\n");

    try {
        const files = await getZohoFiles();
        const jsonFiles = files.filter(f => f.attributes && f.attributes.extn === 'json');

        // Group files by quote_id to detect duplicate sources safely
        const filesByQuote = {};
        for (const file of jsonFiles) {
            let data;
            try {
                data = await getZohoFileContent(file.id);
            } catch (err) {
                logger.error(`[ERROR] Failed to read WorkDrive file ID ${file.id}`);
                results.failed++;
                continue;
            }

            const quoteId = data.id;
            if (!quoteId) {
                logger.log(`[SKIP] File ID ${file.id} has no quote ID.`);
                results.skipped++;
                continue;
            }

            if (!filesByQuote[quoteId]) filesByQuote[quoteId] = [];
            filesByQuote[quoteId].push({ file, data });
        }

        // Process grouped quote IDs
        for (const quoteId of Object.keys(filesByQuote)) {
            const sources = filesByQuote[quoteId];
            
            if (sources.length > 1) {
                logger.log(`[CONFLICT] Quote ID ${quoteId} has ${sources.length} duplicate source files. Skipped.`);
                results.duplicateFile++;
                continue;
            }

            if (!APPROVED_QUOTE_IDS.includes(quoteId)) {
                logger.log(`[EXCLUDE] Quote ID ${quoteId} is not in the explicit allowlist.`);
                results.excluded++;
                continue;
            }

            const { file, data } = sources[0];

            // Safely map payload
            const record = {
                quote_id: quoteId,
                owner_id: null,
                status: data.status || 'Draft',
                is_voucher_mode: !!data.isVoucherMode,
                guest_name: data.guest || null,
                title: data.title || null,
                start_date: parseDate(data.start),
                end_date: parseDate(data.end),
                guest_count: parseSafeInt(data.adults, logger, 'guest_count', quoteId),
                total_amount: parseSafeFloat(data.baseCost, logger, 'total_amount', quoteId),
                currency: data.currency || null,
                content: data,
                version: 1
            };

            manifest.push({
                quote_id: record.quote_id,
                status: record.status,
                start_date: record.start_date
            });

            if (isExecute) {
                const error = await insertToSupabase(record);
                if (error) {
                    if (error.code === '23505') {
                        logger.log(`[DB CONFLICT] ${quoteId} already exists in database. Skipped without overwrite.`);
                        results.dbConflict++;
                    } else {
                        logger.error(`[ERROR] Failed to insert ${quoteId}: ${error.message}`);
                        results.failed++;
                    }
                } else {
                    logger.log(`[IMPORT SUCCESS] ${quoteId}`);
                    results.imported++;
                }
            }
        }

        logger.log("\n=== MIGRATION CANDIDATE MANIFEST ===");
        if (!isExecute) {
            manifest.forEach(m => logger.log(`- Quote: ${m.quote_id} | Status: ${m.status} | Start: ${m.start_date}`));
        }
        
        logger.log("\n=== SUMMARY ===");
        logger.log(`Included Candidates: ${manifest.length}`);
        logger.log(`Explicitly Excluded: ${results.excluded}`);
        logger.log(`Skipped (Missing ID): ${results.skipped}`);
        logger.log(`Skipped (Duplicate Source): ${results.duplicateFile}`);
        
        if (isExecute) {
            logger.log(`Successfully Imported: ${results.imported}`);
            logger.log(`Conflicts Ignored (DB): ${results.dbConflict}`);
            logger.log(`Failures: ${results.failed}`);
        } else {
            logger.log("\nRun with --execute to perform the import.");
        }

        return results;

    } catch (e) {
        logger.error(`\n[FATAL] Migration script failed: ${e.message}`);
        throw e;
    }
}

// Live execution bindings
if (require.main === module) {
    const isExecute = process.argv.includes('--execute');
    const env = process.env;

    const getZohoFiles = async () => {
        const tokenRes = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                refresh_token: env.ZOHO_REFRESH_TOKEN,
                client_id: env.ZOHO_CLIENT_ID,
                client_secret: env.ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });
        const token = tokenRes.data.access_token;
        const response = await axios.get(`https://workdrive.zoho.in/api/v1/files/${env.ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });
        return response.data.data || [];
    };

    const getZohoFileContent = async (fileId) => {
        const tokenRes = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                refresh_token: env.ZOHO_REFRESH_TOKEN,
                client_id: env.ZOHO_CLIENT_ID,
                client_secret: env.ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });
        const token = tokenRes.data.access_token;
        const res = await axios.get(`https://workdrive.zoho.in/api/v1/download/${fileId}`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            responseType: 'json'
        });
        return res.data;
    };

    // Lazily bind supabase client using validated env
    let supabaseClient = null;
    const insertToSupabase = async (record) => {
        if (!supabaseClient) {
            const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
            supabaseClient = createClient(env.SUPABASE_URL, secret);
        }
        const { error } = await supabaseClient.from('itineraries').insert([record]);
        return error;
    };

    runMigrationProcess({
        isExecute,
        env,
        getZohoFiles,
        getZohoFileContent,
        insertToSupabase,
        logger: console
    }).catch(() => process.exit(1));
}

module.exports = {
    runMigrationProcess,
    validateEnvironment,
    EXPECTED_STAGING_HOST,
    APPROVED_QUOTE_IDS
};
