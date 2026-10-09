require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

async function compare() {
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
        
        let file1, file2;
        for (const file of jsonFiles) {
            const downloadRes = await axios.get(`https://workdrive.zoho.in/api/v1/download/${file.id}`, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
                responseType: 'json'
            });
            const data = downloadRes.data;
            if (data.id === 'CMP-2026-001222') file1 = data;
            if (data.id === 'CMP-2026-001333') file2 = data;
        }
        
        const diff = {};
        for (const key in file1) {
            if (JSON.stringify(file1[key]) !== JSON.stringify(file2[key])) {
                diff[key] = {
                    '1222': file1[key],
                    '1333': file2[key]
                };
            }
        }
        
        for (const key in file2) {
            if (!file1.hasOwnProperty(key)) {
                diff[key] = {
                    '1222': undefined,
                    '1333': file2[key]
                };
            }
        }
        
        console.log("Differences:");
        console.log(JSON.stringify(diff, null, 2));
    } catch (e) {
        console.error(e.message);
    }
}
compare();
