const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const code = '1000.24768489ecb317f4d042b3d4924053a6.a4a5afb026046475c5a55d0c1fc73c31';

async function exchange() {
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
