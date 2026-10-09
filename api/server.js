require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { validateItinerary } = require('../validation.js');
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const db = require('./db.js');

const EXPECTED_STAGING_HOST = 'iqqkuqgsvuciunmvtmdr.supabase.co';

function isSafeSupabaseUrl(urlStr) {
    if (!urlStr) return false;
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'https:') return false;
        if (u.hostname !== EXPECTED_STAGING_HOST) return false;
        if (u.username || u.password) return false;
        if (u.port && u.port !== '443') return false;
        if (u.search || u.hash) return false;
        return true;
    } catch (e) {
        return false;
    }
}
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../')));

// Initialize Supabase (Public Client for Auth Validation)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
let supabaseAdmin = null;
if (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}

// Middleware to check Supabase Auth
async function requireAuth(req, res, next) {
    if (!supabase || !supabaseAdmin) {
        return res.status(500).json({ success: false, error: 'Authentication is not fully configured on the server.' });
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
    
    // Check Role using privileged client
    try {
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('user_roles')
            .select('role, is_active')
            .eq('user_id', user.id)
            .single();
            
        if (profileError || !profile || profile.is_active !== true) {
            return res.status(403).json({ success: false, error: 'Forbidden: Account inactive or role unassigned.' });
        }
        
        const validRoles = ['ADMIN', 'SALES', 'OPS'];
        if (!validRoles.includes(profile.role)) {
            return res.status(403).json({ success: false, error: 'Forbidden: Invalid role assignment.' });
        }
        
        req.userRole = profile.role; 
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Internal server error during role validation.' });
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
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
        return res.status(500).json({ success: false, error: 'Supabase configuration missing on server.' });
    }
    // Only return the safe publishable key to the client. The secret key is never sent.
    res.json({ success: true, url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY });
});

// Safe configuration validation endpoint
app.get('/api/admin/config-check', requireAuth, (req, res) => {
    if (req.userRole !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    const envVars = {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY: !!process.env.SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
        SUPABASE_SECRET_KEY: !!process.env.SUPABASE_SECRET_KEY,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        ZOHO_CLIENT_ID: !!process.env.ZOHO_CLIENT_ID,
        ZOHO_WORKDRIVE_FOLDER_ID: !!process.env.ZOHO_WORKDRIVE_FOLDER_ID
    };
    const missing = Object.keys(envVars).filter(k => !envVars[k]);
    res.json({ success: true, configured: envVars, missing_potential: missing });
});

// Setup Auth Routes
app.get('/auth', (req, res) => {
    // Disabled for security. Reauthorization requires a separate secure, deliberate workflow.
    res.status(403).send("<h1>Forbidden</h1><p>OAuth endpoints are disabled. Reauthorization requires a deliberate, secure administrative workflow.</p>");
});

app.get('/callback', async (req, res) => {
    // Disabled for security. 
    res.status(403).send("<h1>Forbidden</h1><p>OAuth endpoints are disabled.</p>");
});

app.post('/api/saveItinerary', requireAuth, async (req, res) => {
    const provider = process.env.STORAGE_PROVIDER;
    if (provider !== undefined && provider !== 'workdrive' && provider !== 'supabase') {
        return res.status(500).json({ success: false, error: 'Safety abort: Invalid STORAGE_PROVIDER.' });
    }
    const activeProvider = provider === undefined ? 'workdrive' : provider;

    if (activeProvider === 'supabase') {
        if (!isSafeSupabaseUrl(process.env.SUPABASE_URL)) {
            return res.status(500).json({ success: false, error: 'Safety abort: Supabase storage is only permitted in the verified staging environment.' });
        }
        try {
            const payload = req.body.itinerary || req.body;
            const version = req.body.version || null;
            if (!payload.id) return res.status(400).json({ success: false, error: 'Missing Quotation Number (ID)' });
            
            let data;
            if (!version) {
                data = await db.createItinerary(payload.id, payload, req.user, req.userRole);
            } else {
                data = await db.updateItinerary(payload.id, payload, version, req.user, req.userRole);
            }
            return res.json({ success: true, message: 'Itinerary saved to Supabase.', version: data.version });
        } catch (error) {
            console.error("Supabase Save Error:", error.message);
            if (error.message.includes("Concurrency Conflict") || error.message.includes("Conflict:")) {
                return res.status(409).json({ success: false, error: error.message });
            }
            if (error.message.includes("Validation failed") || error.message.includes("Missing")) {
                return res.status(400).json({ success: false, error: error.message });
            }
            if (error.message.includes("Not authorized") || error.message.includes("Only Admin") || error.message.includes("Sales can only edit their own itineraries") || error.message.includes("Legacy unassigned records") || error.message.includes("Ops/Unauthorized")) {
                return res.status(403).json({ success: false, error: error.message });
            }
            return res.status(500).json({ success: false, error: 'Failed to sync itinerary with cloud storage. Please try again later.' });
        }
    }

    // Write access is temporarily restricted to Admin because WorkDrive does not support safe atomic ownership checks.
    if (req.userRole !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Forbidden: Write access is temporarily restricted to Administrators pending database migration.' });
    }

    try {
        const itinerary = req.body.itinerary || req.body;
        if (!itinerary.id) return res.status(400).json({ success: false, error: 'Missing Quotation Number (ID)' });
        
        const valRes = validateItinerary(itinerary);
        if (!valRes.isValid) {
            return res.status(400).json({ 
                success: false, 
                error: 'Validation failed: ' + valRes.errors.join('; ') 
            });
        }

        
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
        console.error("Error saving itinerary:", error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to sync itinerary with cloud storage. Please try again later.'
        });
    }
});

app.get('/api/listItineraries', requireAuth, async (req, res) => {
    const provider = process.env.STORAGE_PROVIDER;
    if (provider !== undefined && provider !== 'workdrive' && provider !== 'supabase') {
        return res.status(500).json({ success: false, error: 'Safety abort: Invalid STORAGE_PROVIDER.' });
    }
    const activeProvider = provider === undefined ? 'workdrive' : provider;

    if (activeProvider === 'supabase') {
        if (!isSafeSupabaseUrl(process.env.SUPABASE_URL)) {
            return res.status(500).json({ success: false, error: 'Safety abort: Supabase storage is only permitted in the verified staging environment.' });
        }
        try {
            const data = await db.listItineraries(req.user, req.userRole);
            const mapped = data.map(d => ({
                id: d.quote_id,
                guest: d.guest_name,
                title: d.title,
                start: d.start_date,
                end: d.end_date,
                status: d.status,
                isVoucherMode: d.is_voucher_mode,
                timestamp: new Date(d.updated_at).getTime(),
                version: d.version
            }));
            return res.json({ success: true, data: mapped });
        } catch(error) {
            console.error("Supabase List Error:", error.message);
            return res.status(500).json({ success: false, error: 'Error listing itineraries from Supabase.' });
        }
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

app.get('/api/getItinerary/:id', requireAuth, async (req, res) => {
    const provider = process.env.STORAGE_PROVIDER;
    if (provider !== undefined && provider !== 'workdrive' && provider !== 'supabase') {
        return res.status(500).json({ success: false, error: 'Safety abort: Invalid STORAGE_PROVIDER.' });
    }
    const activeProvider = provider === undefined ? 'workdrive' : provider;

    if (activeProvider === 'supabase') {
        if (!isSafeSupabaseUrl(process.env.SUPABASE_URL)) {
            return res.status(500).json({ success: false, error: 'Safety abort: Supabase storage is only permitted in the verified staging environment.' });
        }
        try {
            const data = await db.getItinerary(req.params.id, req.user, req.userRole);
            if (!data) return res.status(404).json({ success: false, error: 'Itinerary not found in Supabase.' });
            
            const content = { ...data.content, version: data.version };
            return res.json({ success: true, data: content });
        } catch(error) {
            console.error("Supabase Get Error:", error.message);
            return res.status(500).json({ success: false, error: 'Error loading itinerary from Supabase.' });
        }
    }

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
