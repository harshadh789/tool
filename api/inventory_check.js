require('dotenv').config();
const axios = require('axios');
const { validateItinerary } = require('../validation.js');

async function checkInventory() {
    console.log("=== WORKDRIVE INVENTORY CHECK ===\n");
    try {
        const tokenRes = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                refresh_token: process.env.ZOHO_REFRESH_TOKEN,
                client_id: process.env.ZOHO_CLIENT_ID,
                client_secret: process.env.ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });
        const token = tokenRes.data.access_token;
        
        const filesRes = await axios.get(`https://workdrive.zoho.in/api/v1/files/${process.env.ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });
        
        const files = filesRes.data.data || [];
        const jsonFiles = files.filter(f => f.attributes && f.attributes.extn === 'json');
        
        console.log(`Total Files: ${files.length}`);
        console.log(`JSON Files: ${jsonFiles.length}\n`);

        const quoteCounts = {};
        const records = [];

        for (const file of jsonFiles) {
            try {
                const downloadRes = await axios.get(`https://workdrive.zoho.in/api/v1/download/${file.id}`, {
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    responseType: 'json'
                });
                const data = downloadRes.data;
                const quoteId = data.id || 'NO-ID';

                quoteCounts[quoteId] = (quoteCounts[quoteId] || 0) + 1;
                
                records.push({
                    fileId: file.id,
                    fileName: file.attributes.name,
                    quoteId: quoteId,
                    data: data
                });
            } catch (e) {
                console.error(`[ERROR] Failed to read ${file.attributes.name}: ${e.message}`);
            }
        }

        const duplicates = Object.keys(quoteCounts).filter(id => quoteCounts[id] > 1);
        if (duplicates.length > 0) {
            console.log("=== DUPLICATE QUOTE IDs ===");
            duplicates.forEach(id => console.log(`- ${id} (${quoteCounts[id]} files)`));
            console.log();
        }

        console.log("=== RECORD ANALYSIS ===");
        let candidates = 0;

        for (const rec of records) {
            const { quoteId, data, fileName } = rec;
            console.log(`\nQuote ID: ${quoteId}`);
            console.log(`File: ${fileName}`);
            
            // Check if synthetic
            const isSynthetic = quoteId.includes('TEST') || quoteId === 'CMP-2026-001222' || quoteId === 'CMP-2026-001333';
            if (isSynthetic) {
                console.log(`Classification: Synthetic / Test / Demo (Rejected)`);
                continue;
            }

            // Validation
            const valRes = validateItinerary(data);
            
            console.log(`Status: ${data.status || 'Draft'}`);
            console.log(`Dates: ${data.start} to ${data.end}`);
            console.log(`Days length: ${data.days ? data.days.length : 0}`);
            
            if (valRes.isValid) {
                if (valRes.warnings.length > 0) {
                    console.log(`Classification: Draft with warnings (Not fully complete)`);
                    valRes.warnings.forEach(w => console.log(`  - Warning: ${w}`));
                } else {
                    console.log(`Classification: VALID CANDIDATE FOR HUMAN REVIEW`);
                    candidates++;
                }
            } else {
                console.log(`Classification: Structurally Incomplete (Validation Failed)`);
                valRes.errors.forEach(e => console.log(`  - Error: ${e}`));
            }
        }

        console.log(`\n=== SUMMARY ===`);
        console.log(`Total Candidates for Review: ${candidates}`);

    } catch (e) {
        console.error("Check failed", e.response ? e.response.data : e.message);
    }
}

checkInventory();
