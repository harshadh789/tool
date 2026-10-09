require('dotenv').config({ path: '../.env' });
const axios = require('axios');

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_WORKDRIVE_API = 'https://workdrive.zoho.in/api/v1';
const ZOHO_WORKDRIVE_FOLDER_ID = process.env.ZOHO_WORKDRIVE_FOLDER_ID;

let accessToken = null;

async function getZohoToken() {
    if (accessToken) return accessToken;
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
}

async function inspectDuplicates() {
    console.log("Fetching files from WorkDrive...");
    const token = await getZohoToken();
    const response = await axios.get(`${ZOHO_WORKDRIVE_API}/files/${ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
    });
    const files = response.data.data || [];
    const duplicates = [];

    for (const file of files) {
        if (!file.attributes || !file.attributes.name) continue;
        const ext = file.attributes.extn || '';
        
        // We only care about .json files
        if (ext !== 'json') continue;
        
        try {
            const downloadUrl = `${ZOHO_WORKDRIVE_API}/download/${file.id}`;
            const downloadRes = await axios.get(downloadUrl, {
                headers: { Authorization: `Zoho-oauthtoken ${token}` },
                responseType: 'json'
            });
            const data = downloadRes.data;
            if (data && data.id === 'TEST-BTN-001') {
                duplicates.push({
                    fileId: file.id,
                    fileName: file.attributes.name,
                    createdTime: file.attributes.created_time,
                    modifiedTime: file.attributes.modified_time,
                    size: file.attributes.size,
                    data: data
                });
            }
        } catch (e) {
            console.error(`Failed to download ${file.attributes.name}`);
        }
    }
    
    console.log(`Found ${duplicates.length} files with ID TEST-BTN-001`);
    duplicates.forEach((dup, i) => {
        console.log(`\n--- Duplicate ${i + 1} ---`);
        console.log(`File Name: ${dup.fileName}`);
        console.log(`File ID: ${dup.fileId}`);
        console.log(`Created: ${dup.createdTime}, Modified: ${dup.modifiedTime}`);
        console.log(`Timestamp in JSON: ${dup.data.timestamp}`);
        console.log(`Status: ${dup.data.status}`);
        console.log(`Guest: ${dup.data.guest}, Title: ${dup.data.title}`);
        console.log(`Size: ${dup.size} bytes`);
    });
}

inspectDuplicates();
