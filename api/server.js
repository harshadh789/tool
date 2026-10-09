require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../')));

// Initialize Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Middleware to check Supabase Auth
async function requireAuth(req, res, next) {
    if (!supabase) {
        return res.status(500).json({ success: false, error: 'Authentication is not configured on the server. Please set SUPABASE_URL and SUPABASE_ANON_KEY in .env' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
    }

    req.user = user;
    
    // Check Role
    try {
        const { data: profile } = await supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', user.id)
            .single();
            
        req.userRole = profile ? profile.role : 'USER'; 
    } catch (e) {
        req.userRole = 'USER';
    }

    next();
}

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://accounts.zoho.in'; 
const ZOHO_WORKDRIVE_API = 'https://workdrive.zoho.in/api/v1';
const ZOHO_WORKDRIVE_FOLDER_ID = process.env.ZOHO_WORKDRIVE_FOLDER_ID;
const fs = require('fs');
const REDIRECT_URI = `http://localhost:${process.env.PORT || 3000}/callback`;

let accessToken = null;
let tokenExpiresAt = 0;

async function getZohoToken() {
    if (accessToken && Date.now() < tokenExpiresAt) {
        return accessToken;
    }
    try {
        const response = await axios.post(`https://accounts.zoho.in/oauth/v2/token`, null, {
            params: {
                refresh_token: ZOHO_REFRESH_TOKEN,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token'
            }
        });
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 60000;
        return accessToken;
    } catch (error) {
        console.error("Error fetching Zoho Access Token:", error.response ? error.response.data : error.message);
        throw new Error("Failed to authenticate with Zoho.");
    }
}

// Find a file by name in the WorkDrive folder
async function findFileByName(token, fileName) {
    try {
        const response = await axios.get(`${ZOHO_WORKDRIVE_API}/files/${ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params: { 'search[name]': fileName }
        });
        if (response.data && response.data.data && response.data.data.length > 0) {
            // Find exact match
            return response.data.data.find(f => f.attributes.name === fileName);
        }
        return null;
    } catch (err) {
        console.error("Error finding file:", err.response ? err.response.data : err.message);
        return null;
    }
}

// --- API Routes ---

app.get('/api/auth/config', (req, res) => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase configuration missing on server.' });
    }
    res.json({ success: true, url: SUPABASE_URL, key: SUPABASE_ANON_KEY });
});

// Setup Auth Routes
app.get('/auth', (req, res) => {
    // Scopes for Bigin and WorkDrive
    const scopes = "ZohoBigin.modules.ALL,ZohoBigin.settings.ALL,WorkDrive.files.ALL,WorkDrive.workspace.ALL";
    const authUrl = `${ZOHO_API_DOMAIN}/oauth/v2/auth?scope=${scopes}&client_id=${ZOHO_CLIENT_ID}&response_type=code&access_type=offline&redirect_uri=${REDIRECT_URI}&prompt=consent`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No authorization code provided.");

    try {
        const response = await axios.post(`${ZOHO_API_DOMAIN}/oauth/v2/token`, null, {
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
            if(envContent.includes('ZOHO_REFRESH_TOKEN=')) {
                envContent = envContent.replace(/ZOHO_REFRESH_TOKEN=.*/, `ZOHO_REFRESH_TOKEN=${response.data.refresh_token}`);
            } else {
                envContent += `\nZOHO_REFRESH_TOKEN=${response.data.refresh_token}`;
            }
            fs.writeFileSync('.env', envContent);
            res.send("<h1>Success!</h1><p>Permanent Refresh token has been saved to .env file! You can now use the Itinerary tool, it is connected to Zoho WorkDrive!</p>");
        } else {
            res.send("<h1>Warning</h1><p>No refresh token received. You might need to revoke access in Zoho API console and try again.</p><pre>" + JSON.stringify(response.data, null, 2) + "</pre>");
        }
    } catch (error) {
        res.send("<h1>Error</h1><pre>" + (error.response ? JSON.stringify(error.response.data, null, 2) : error.message) + "</pre>");
    }
});

// Save Itinerary
app.post('/api/saveItinerary', requireAuth, async (req, res) => {
    try {
        const itinerary = req.body;
        if (!itinerary.id) return res.status(400).json({ success: false, error: 'Missing Quotation Number (ID)' });
        
        const token = await getZohoToken();
        const fileName = `${itinerary.id}.json`;
        const fileContent = Buffer.from(JSON.stringify(itinerary, null, 2));

        // Always upload fresh with override — simpler and avoids update-by-id API issues
        const form = new FormData();
        form.append('content', fileContent, { filename: fileName, contentType: 'application/json' });
        form.append('parent_id', ZOHO_WORKDRIVE_FOLDER_ID);
        form.append('override-name-exist', 'true');

        await axios.post(`${ZOHO_WORKDRIVE_API}/upload`, form, {
            headers: { 
                ...form.getHeaders(),
                Authorization: `Zoho-oauthtoken ${token}` 
            }
        });

        console.log(`Saved itinerary ${fileName} to WorkDrive.`);
        res.json({ success: true, message: 'Itinerary saved successfully.' });
    } catch (error) {
        console.error("Error saving itinerary:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Error saving itinerary to Zoho.',
            details: error.response ? error.response.data : error.message,
            envKeys: Object.keys(process.env).filter(k => k.startsWith('ZOHO_')) 
        });
    }
});

// List all Itineraries in the WorkDrive folder
app.get('/api/listItineraries', requireAuth, async (req, res) => {
    if (req.userRole !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Forbidden: Admin access required to view all quotations.' });
    }
    
    try {
        const token = await getZohoToken();
        const response = await axios.get(`${ZOHO_WORKDRIVE_API}/files/${ZOHO_WORKDRIVE_FOLDER_ID}/files`, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });

        const files = (response.data && response.data.data) ? response.data.data : [];
        const jsonFiles = files.filter(f => f.attributes && f.attributes.name && f.attributes.name.endsWith('.json'));

        const itineraries = [];
        for (const file of jsonFiles) {
            try {
                const downloadUrl = `${ZOHO_WORKDRIVE_API}/download/${file.id}`;
                const downloadRes = await axios.get(downloadUrl, {
                    headers: { Authorization: `Zoho-oauthtoken ${token}` },
                    responseType: 'json'
                });
                // Only return summary fields to keep dashboard fast
                const d = downloadRes.data;
                itineraries.push({
                    id: d.id,
                    guest: d.guest,
                    title: d.title,
                    start: d.start,
                    end: d.end,
                    duration: d.duration,
                    status: d.status,
                    isVoucherMode: d.isVoucherMode,
                    timestamp: d.timestamp
                });
            } catch(e) {
                console.warn('Could not parse file:', file.attributes.name, e.message);
            }
        }

        // Sort by timestamp descending
        itineraries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json({ success: true, data: itineraries });
    } catch (error) {
        console.error("Error listing itineraries:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: 'Error listing itineraries from Zoho.' });
    }
});

// Load Itinerary
app.get('/api/getItinerary/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getZohoToken();
        const fileName = `${id}.json`;

        const existingFile = await findFileByName(token, fileName);
        if (!existingFile) {
            return res.status(404).json({ success: false, error: 'Itinerary not found in WorkDrive.' });
        }

        // To download the file content, we use the download_url
        const downloadUrl = `${ZOHO_WORKDRIVE_API}/download/${existingFile.id}`;
        const downloadRes = await axios.get(downloadUrl, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            responseType: 'json'
        });

        res.json({ success: true, data: downloadRes.data });
    } catch (error) {
        console.error("Error loading itinerary:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: 'Error loading itinerary from Zoho.' });
    }
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
module.exports = app;
