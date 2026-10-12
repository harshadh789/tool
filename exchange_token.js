const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const code = process.env.ZOHO_AUTH_CODE;

async function exchange() {
    if (!code) {
        console.error("ERROR: ZOHO_AUTH_CODE environment variable is required.");
        process.exit(1);
    }
    try {
        const response = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                grant_type: 'authorization_code',
                client_id: process.env.ZOHO_CLIENT_ID,
                client_secret: process.env.ZOHO_CLIENT_SECRET,
                code: code
            }
        });

        if (response.data.refresh_token) {
            let envContent = fs.readFileSync('.env', 'utf8');
            if(envContent.includes('ZOHO_REFRESH_TOKEN=')) {
                envContent = envContent.replace(/ZOHO_REFRESH_TOKEN=.*/, `ZOHO_REFRESH_TOKEN=${response.data.refresh_token}`);
            } else {
                envContent += `\nZOHO_REFRESH_TOKEN=${response.data.refresh_token}`;
            }
            fs.writeFileSync('.env', envContent);
            console.log("SUCCESS: Refresh token saved to .env");
        } else {
            console.error("FAILED to get refresh token:", response.data);
        }
    } catch (error) {
        console.error("ERROR during exchange:", error.response ? error.response.data : error.message);
    }
}

exchange();
