require('dotenv').config({ path: '../.env' });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_WORKDRIVE_API = 'https://workdrive.zoho.in/api/v1';
const ZOHO_WORKDRIVE_FOLDER_ID = process.env.ZOHO_WORKDRIVE_FOLDER_ID;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

let accessToken = null;

async function getZohoToken() {
    if (accessToken) return accessToken;
    try {
        const response = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                refresh_token: ZOHO_REFRESH_TOKEN,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });
        accessToken = response.data.access_token;
        return accessToken;
    } catch (error) {
        console.error("Error fetching Zoho token.");
        throw error;
    }
}

async function runDryRun() {
    console.log("=== Phase 2A Migration Dry-Run ===");
    
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
        console.log("[WARNING] Supabase Service Role Key is missing. Dry-run will only analyze WorkDrive records.");
    }

    if (!ZOHO_REFRESH_TOKEN) {
        console.log("[BLOCKED] Zoho credentials not fully configured.");
        return;
    }

    let token;
    try {
        token = await getZohoToken();
    } catch (e) {
        return;
    }

    console.log("Fetching files from WorkDrive...");
    let files = [];
    try {
        const response = await axios.get(`${ZOHO_WORKDRIVE_API}/files/${ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });
        files = (response.data && response.data.data) ? response.data.data : [];
    } catch (e) {
        console.error("Failed to list files from WorkDrive.");
        return;
    }

    const jsonFiles = files.filter(f => f.attributes && f.attributes.name && f.attributes.name.endsWith('.json'));
    
    console.log(`Total files found: ${files.length}`);
    console.log(`Valid JSON records targeted: ${jsonFiles.length}`);

    // Explicit conflict resolution mapping.
    // Key: Quote ID, Value: File ID of the selected source record.
    const conflictResolutions = {
        // Example: 'TEST-BTN-001': 'zsznd36e1e3bca51b4fa1a2d9b31d23055c03'
    };

    const report = {
        validRecords: 0,
        invalidRecords: 0,
        duplicateQuoteIds: 0,
        missingIdentifiers: 0,
        unmappedFieldsFound: 0,
        conflicts: [],
        resolvedConflicts: [],
        proposedImports: []
    };

    // Group files by quote ID to detect duplicates first
    const filesByQuoteId = {};
    for (const file of jsonFiles) {
        try {
            const downloadUrl = `${ZOHO_WORKDRIVE_API}/download/${file.id}`;
            const downloadRes = await axios.get(downloadUrl, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
                responseType: 'json'
            });
            const data = downloadRes.data;

            if (!data || !data.id) {
                report.missingIdentifiers++;
                continue;
            }

            const quoteId = data.id;
            if (!filesByQuoteId[quoteId]) filesByQuoteId[quoteId] = [];
            filesByQuoteId[quoteId].push({ file, data });
        } catch (e) {
            report.invalidRecords++;
            console.error(`Error parsing ${file.attributes.name}`);
        }
    }

    // Process each quote ID group
    for (const [quoteId, records] of Object.entries(filesByQuoteId)) {
        let selectedRecord = records[0];

        if (records.length > 1) {
            report.duplicateQuoteIds++;
            if (conflictResolutions[quoteId]) {
                const resolvedFileId = conflictResolutions[quoteId];
                const found = records.find(r => r.file.id === resolvedFileId);
                if (found) {
                    selectedRecord = found;
                    report.resolvedConflicts.push(`Resolved ${quoteId} using file ${resolvedFileId}`);
                } else {
                    report.conflicts.push(`Unresolved duplicate: ${quoteId}. Resolution file ID not found.`);
                    continue; // Skip import for this quote ID completely
                }
            } else {
                report.conflicts.push(`Unresolved duplicate: ${quoteId} across ${records.length} files. Must be explicitly resolved before migration.`);
                continue; // Skip import for this quote ID completely
            }
        }

        const data = selectedRecord.data;

        // Construct proposed import
        const proposed = {
            quote_id: quoteId,
            status: data.status || 'Draft',
            is_voucher_mode: !!data.isVoucherMode,
            guest_name: data.guest || null,
            title: data.title || null,
            start_date: data.start || null,
            end_date: data.end || null,
            guest_count: data.adults ? parseInt(data.adults) : null,
            total_amount: data.baseCost ? parseFloat(data.baseCost) : null,
            currency: data.currency || null,
            content: data // full payload retention
        };

        report.proposedImports.push(proposed);
        report.validRecords++;
    }

    console.log("\n=== DRY-RUN RESULTS ===");
    console.log(`Valid Records Ready to Import: ${report.validRecords}`);
    console.log(`Invalid JSON Files: ${report.invalidRecords}`);
    console.log(`Missing Identifiers (No quote ID): ${report.missingIdentifiers}`);
    console.log(`Duplicate Quote IDs: ${report.duplicateQuoteIds}`);
    if (report.conflicts.length > 0) {
        console.log("Conflicts Detected:");
        report.conflicts.forEach(c => console.log(`  - ${c}`));
    }
    
    console.log("\nSample Proposed Record mapping:");
    if (report.proposedImports.length > 0) {
        const sample = report.proposedImports[0];
        console.log(JSON.stringify({ 
            ...sample, 
            guest_name: "[REDACTED]",
            guest_count: "[REDACTED]",
            total_amount: "[REDACTED]",
            content: "[OMITTED FULL PAYLOAD]" 
        }, null, 2));
    }
    
    console.log("\nMigration strategy: Records will be imported retaining their full original JSON payload in the 'content' column to prevent data loss. 'owner_id' will default to NULL (Unassigned) since legacy WorkDrive records lack verified ownership mapping. Admins must assign owners post-migration.");
}

runDryRun();
