require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_WORKDRIVE_API = 'https://workdrive.zoho.in/api/v1';
const ZOHO_WORKDRIVE_FOLDER_ID = process.env.ZOHO_WORKDRIVE_FOLDER_ID;

let accessToken = null;

async function run() {
    const response = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
        params: {
            refresh_token: ZOHO_REFRESH_TOKEN,
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token'
        }
    });
    const token = response.data.access_token;
    
    const filesRes = await axios.get(`${ZOHO_WORKDRIVE_API}/files/${ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const files = filesRes.data.data || [];
    
    console.log(`Total files: ${files.length}`);
    for (const f of files) {
        console.log(`- ${f.attributes.name} (ext: ${f.attributes.extn})`);
        if (f.attributes.extn === 'json') {
            try {
                const downloadUrl = `${ZOHO_WORKDRIVE_API}/download/${f.id}`;
                const downloadRes = await axios.get(downloadUrl, {
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    responseType: 'json'
                });
                console.log(`  Guest: ${downloadRes.data.guest}, Title: ${downloadRes.data.title}`);
            } catch (e) {
                console.log(`  Failed to read guest info.`);
            }
        }
    }
}
run();
