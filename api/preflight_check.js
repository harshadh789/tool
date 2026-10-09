require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const APPROVED_QUOTE_IDS = ['CMP-2026-001222', 'CMP-2026-001333'];

async function preflight() {
    console.log("=== PREFLIGHT CHECK ===");
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
        
        const quoteGroups = {};
        for (const file of jsonFiles) {
            try {
                const downloadRes = await axios.get(`https://workdrive.zoho.in/api/v1/download/${file.id}`, {
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    responseType: 'json'
                });
                const data = downloadRes.data;
                const quoteId = data.id;
                if (!quoteId) continue;
                if (!APPROVED_QUOTE_IDS.includes(quoteId)) continue;
                
                if (!quoteGroups[quoteId]) quoteGroups[quoteId] = [];
                quoteGroups[quoteId].push({ file: file.attributes.name, data });
            } catch (e) {
                console.error(`Error downloading file ${file.attributes.name}`);
            }
        }
        
        let eligible = 0;
        
        for (const id of APPROVED_QUOTE_IDS) {
            const sources = quoteGroups[id] || [];
            console.log(`\nQuote ID: ${id}`);
            
            if (sources.length === 0) {
                console.log(`- Result: EXCLUDED (Missing source file)`);
                continue;
            }
            if (sources.length > 1) {
                console.log(`- Result: EXCLUDED (Duplicate sources: ${sources.length} files)`);
                continue;
            }
            
            const source = sources[0];
            const data = source.data;
            console.log(`- Source Filename: ${source.file}`);
            console.log(`- Status: ${data.status || 'Draft'}`);
            
            // Validate payload
            let warnings = [];
            
            // Required ID match
            if (data.id !== id) {
                warnings.push("Inner ID does not match expected Quote ID.");
            }
            
            // Dates
            if (data.start && isNaN(new Date(data.start).getTime())) warnings.push("start_date is malformed");
            if (data.end && isNaN(new Date(data.end).getTime())) warnings.push("end_date is malformed");
            
            // Numerics
            if (data.adults && isNaN(parseInt(data.adults, 10))) warnings.push("guest_count is non-numeric");
            if (data.baseCost && isNaN(parseFloat(data.baseCost))) warnings.push("total_amount is non-numeric");
            
            if (warnings.length > 0) {
                console.log(`- Validation: WARNINGS FOUND`);
                warnings.forEach(w => console.log(`  * ${w}`));
            } else {
                console.log(`- Validation: PASS (Valid JSON, types correct)`);
                eligible++;
            }
        }
        
        console.log(`\n=== ELIGIBLE COUNT: ${eligible} ===`);
        console.log("Note: Authenticity of these records requires human confirmation.");
        
    } catch (e) {
        console.error("Preflight failed", e.message);
    }
}

preflight();
