const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = 3001;

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

app.get('/auth', (req, res) => {
    // Scopes for Bigin and WorkDrive
    const scopes = "ZohoBigin.modules.ALL,ZohoBigin.settings.ALL,WorkDrive.files.ALL,WorkDrive.workspace.ALL";
    const authUrl = `https://accounts.zoho.in/oauth/v2/auth?scope=${scopes}&client_id=${ZOHO_CLIENT_ID}&response_type=code&access_type=offline&redirect_uri=${REDIRECT_URI}&prompt=consent`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No authorization code provided.");

    try {
        const response = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                grant_type: 'authorization_code',
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                code: code
            }
        });

        if (response.data.refresh_token) {
            let envContent = fs.readFileSync('.env', 'utf8');
            envContent = envContent.replace(/ZOHO_REFRESH_TOKEN=.*/, `ZOHO_REFRESH_TOKEN=${response.data.refresh_token}`);
            fs.writeFileSync('.env', envContent);
            res.send("<h1>Success!</h1><p>Refresh token has been saved to .env file. You can close this window and I will continue.</p>");
        } else {
            res.send("<h1>Warning</h1><p>No refresh token received. You might need to revoke access in Zoho API console and try again.</p><pre>" + JSON.stringify(response.data, null, 2) + "</pre>");
        }
    } catch (error) {
        res.send("<h1>Error</h1><pre>" + (error.response ? JSON.stringify(error.response.data, null, 2) : error.message) + "</pre>");
    }
});

app.listen(PORT, () => {
    console.log(`Auth Server running on http://localhost:${PORT}`);
    console.log(`\n=> Please visit http://localhost:${PORT}/auth to authorize Zoho.`);
});
