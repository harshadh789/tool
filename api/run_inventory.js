require('dotenv').config({ path: '../.env' });
const axios = require('axios');

async function getZohoToken() {
    const response = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
        params: {
            refresh_token: process.env.ZOHO_REFRESH_TOKEN,
            client_id: process.env.ZOHO_CLIENT_ID,
            client_secret: process.env.ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token'
        }
    });
    return response.data.access_token;
}

async function run() {
    console.log("=== WORKDRIVE RECONCILED INVENTORY ===");
    const token = await getZohoToken();
    const res = await axios.get(`https://workdrive.zoho.in/api/v1/files/${process.env.ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    
    const files = res.data.data || [];
    let jsonCount = 0;
    let nonJsonCount = 0;
    
    console.log(`Total files examined: ${files.length}`);
    
    for (const f of files) {
        if (f.attributes.extn === 'json') {
            jsonCount++;
            try {
                const downloadRes = await axios.get(`https://workdrive.zoho.in/api/v1/download/${f.id}`, {
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    responseType: 'json'
                });
                const data = downloadRes.data;
                const quoteId = data.id || "MISSING";
                console.log(`[JSON] File: ${f.attributes.name} | QuoteID: ${quoteId} | Status: ${data.status} | Created: ${f.attributes.created_time}`);
            } catch (e) {
                console.log(`[JSON ERROR] File: ${f.attributes.name} | Could not read payload.`);
            }
        } else {
            nonJsonCount++;
            console.log(`[IGNORED] File: ${f.attributes.name} (ext: ${f.attributes.extn})`);
        }
    }
    
    console.log(`\nTotals: JSON Files=${jsonCount}, Non-JSON Excluded=${nonJsonCount}`);
}
run();
