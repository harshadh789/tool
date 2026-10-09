require('dotenv').config();
const axios = require('axios');

const APPROVED_QUOTE_IDS = ['CMP-2026-001222', 'CMP-2026-001333'];

async function checkRecords() {
    console.log("=== RECORD COMPLETENESS CHECK ===");
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
        
        for (const file of jsonFiles) {
            try {
                const downloadRes = await axios.get(`https://workdrive.zoho.in/api/v1/download/${file.id}`, {
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    responseType: 'json'
                });
                const data = downloadRes.data;
                const quoteId = data.id;
                
                if (!APPROVED_QUOTE_IDS.includes(quoteId)) continue;
                
                console.log(`\n=== Quote ID: ${quoteId} ===`);
                console.log(`- Duration string: ${data.duration}`);
                console.log(`- Start date: ${data.start}`);
                console.log(`- End date: ${data.end}`);
                console.log(`- Days array length: ${data.days ? data.days.length : 0}`);
                console.log(`- Hotels array length: ${data.hotels ? data.hotels.length : 0}`);
                console.log(`- Required fields present:`);
                console.log(`  - title: ${!!data.title}`);
                console.log(`  - inc: ${!!data.inc}`);
                console.log(`  - exc: ${!!data.exc}`);
                console.log(`  - terms: ${!!data.terms}`);
                console.log(`  - flights: ${!!data.flights}`);
                console.log(`  - status: ${data.status}`);
                
                // Compare calculated duration with days.length
                if (data.start && data.end) {
                    const diffTime = Math.abs(new Date(data.end) - new Date(data.start));
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    console.log(`- Calculated date difference (nights): ${diffDays}`);
                    console.log(`- Date span requires approx ${diffDays + 1} travel days.`);
                }
                
                // Content of days
                if (data.days && data.days.length > 0) {
                    console.log(`- Day 1 title: ${data.days[0].title}`);
                }
                
            } catch (e) {
                console.error(`Error processing file ${file.attributes.name}:`, e.message);
            }
        }
    } catch (e) {
        console.error("Check failed", e.response ? e.response.data : e.message);
    }
}

checkRecords();
