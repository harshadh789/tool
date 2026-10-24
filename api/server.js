require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { validateItinerary } = require('../validation.js');
const axios = require('axios');
const path = require('path');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const db = require('./db.js');
const payments = require('./payments.js');
const mdrAccounting = require('./mdr_accounting.js');

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

// --- User Management Routes ---
app.get('/api/me', requireAuth, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            role: req.userRole,
            is_active: true
        }
    });
});

app.get('/api/users', requireAuth, async (req, res) => {
    if (req.userRole !== 'ADMIN') return res.status(403).json({ success: false, error: 'Forbidden' });
    try {
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers();
        if (authError) throw authError;
        const { data: rolesData, error: rolesError } = await supabaseAdmin.from('user_roles').select('*');
        if (rolesError) throw rolesError;
        
        const users = authData.users.map(u => {
            const roleObj = rolesData.find(r => r.user_id === u.id) || { role: 'UNASSIGNED', is_active: false };
            return {
                id: u.id,
                email: u.email,
                role: roleObj.role,
                is_active: roleObj.is_active,
                created_at: u.created_at,
                last_sign_in_at: u.last_sign_in_at,
                confirmed_at: u.confirmed_at || u.email_confirmed_at
            };
        });
        res.json({ success: true, users });
    } catch (e) {
        console.error("List users error:", e);
        res.status(500).json({ success: false, error: 'Failed to list users.' });
    }
});

app.post('/api/users', requireAuth, async (req, res) => {
    if (req.userRole !== 'ADMIN') return res.status(403).json({ success: false, error: 'Forbidden' });
    const { email, role } = req.body;
    if (!email || !['ADMIN', 'SALES', 'OPS'].includes(role)) {
        return res.status(400).json({ success: false, error: 'Invalid email or role.' });
    }
    try {
        const appUrl = process.env.APP_URL || (process.env.NODE_ENV === 'production' || process.env.VERCEL 
            ? 'https://tool-five-alpha.vercel.app' 
            : 'http://localhost:3000');
        const inviteOptions = {
            redirectTo: `${appUrl}/dashboard.html`
        };
        const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, inviteOptions);
        if (inviteError) throw inviteError;
        
        const userId = inviteData.user.id;
        const { error: roleError } = await supabaseAdmin.from('user_roles').insert([{
            user_id: userId,
            role: role,
            is_active: true
        }]);
        
        if (roleError) {
            console.error("Role assignment failed for invited user:", userId, roleError);
            return res.status(500).json({ success: false, error: 'User invited but role assignment failed. Please set role manually or retry.' });
        }
        
        res.json({ success: true, message: 'User invited and role assigned successfully.', user_id: userId });
    } catch (e) {
        console.error("Invite user error:", e);
        res.status(500).json({ success: false, error: 'Failed to invite user.' });
    }
});

app.patch('/api/users/:id', requireAuth, async (req, res) => {
    if (req.userRole !== 'ADMIN') return res.status(403).json({ success: false, error: 'Forbidden' });
    const targetId = req.params.id;
    if (targetId === req.user.id) {
        return res.status(400).json({ success: false, error: 'Cannot modify your own account.' });
    }
    const { role, is_active } = req.body;
    
    if ((role && role !== 'ADMIN') || is_active === false) {
        const { data: targetRoleData, error: trErr } = await supabaseAdmin.from('user_roles').select('role, is_active').eq('user_id', targetId).maybeSingle();
        if (trErr) return res.status(500).json({ success: false, error: 'Failed to verify target user role.' });
        
        if (targetRoleData && targetRoleData.role === 'ADMIN' && targetRoleData.is_active) {
            const { count, error: countErr } = await supabaseAdmin.from('user_roles').select('*', { count: 'exact', head: true }).eq('role', 'ADMIN').eq('is_active', true);
            if (countErr) return res.status(500).json({ success: false, error: 'Failed to verify admin count.' });
            if (count <= 1) {
                return res.status(400).json({ success: false, error: 'Cannot demote or deactivate the last active ADMIN.' });
            }
        }
    }
    
    const updates = {};
    if (role && ['ADMIN', 'SALES', 'OPS'].includes(role)) updates.role = role;
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    
    if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: 'No valid updates provided.' });
    
    try {
        // Repair partial invitation recovery: verify user exists in Auth
        const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.getUserById(targetId);
        if (authErr || !authData.user) {
            return res.status(404).json({ success: false, error: 'Target user not found in Auth.' });
        }

        const { data: existingRole, error: existingErr } = await supabaseAdmin.from('user_roles').select('*').eq('user_id', targetId).single();
        
        if (existingRole) {
            const { error: updateError } = await supabaseAdmin.from('user_roles').update(updates).eq('user_id', targetId);
            if (updateError) throw updateError;
        } else {
            const { error: insertError } = await supabaseAdmin.from('user_roles').insert([{
                user_id: targetId,
                role: updates.role || 'SALES',
                is_active: updates.is_active !== undefined ? updates.is_active : true
            }]);
            if (insertError) throw insertError;
        }
        
        res.json({ success: true, message: 'User updated successfully.' });
    } catch (e) {
        console.error("Update user error:", e);
        res.status(500).json({ success: false, error: 'Failed to update user.' });
    }
});

app.post('/api/users/:id/resend', requireAuth, async (req, res) => {
    if (req.userRole !== 'ADMIN') return res.status(403).json({ success: false, error: 'Forbidden' });
    const targetId = req.params.id;
    
    try {
        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(targetId);
        if (userError) throw userError;
        
        const user = userData.user;
        const isConfirmed = !!(user.confirmed_at || user.email_confirmed_at);
        
        if (!isConfirmed) {
            return res.status(400).json({ success: false, error: 'Unsupported action: Cannot reliably resend invitation to unconfirmed account via this API.' });
        }
        
        // Active account: Send Password Reset
        const appUrl = process.env.APP_URL || (process.env.NODE_ENV === 'production' || process.env.VERCEL 
            ? 'https://tool-five-alpha.vercel.app' 
            : 'http://localhost:3000');
        const redirectUrl = `${appUrl}/dashboard.html`;
            
        const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(user.email, {
            redirectTo: redirectUrl
        });
        if (resetError) throw resetError;
        
        res.json({ success: true, message: 'Password reset email sent.' });
    } catch (e) {
        console.error("Password reset error:", e);
        res.status(500).json({ success: false, error: 'Failed to process request.' });
    }
});

app.delete('/api/users/:id', requireAuth, async (req, res) => {
    if (req.userRole !== 'ADMIN') return res.status(403).json({ success: false, error: 'Forbidden' });
    const targetId = req.params.id;
    
    if (targetId === req.user.id) {
        return res.status(400).json({ success: false, error: 'Cannot delete your own account.' });
    }
    
    try {
        // Must be deactivated first
        const { data: roleData, error: roleError } = await supabaseAdmin.from('user_roles').select('is_active, role').eq('user_id', targetId).maybeSingle();
        if (roleError) throw roleError;
        if (roleData && roleData.is_active) {
            return res.status(400).json({ success: false, error: 'User must be deactivated before deletion.' });
        }
        
        // Check linked records
        const { count: itineraryCount, error: itineraryError } = await supabaseAdmin.from('itineraries')
            .select('id', { count: 'exact', head: true }).eq('owner_id', targetId);
        if (itineraryError) throw itineraryError;
        
        const { count: statusCount, error: statusError } = await supabaseAdmin.from('status_history')
            .select('id', { count: 'exact', head: true }).eq('user_id', targetId);
        if (statusError) throw statusError;
            
        const { count: shareCount, error: shareError } = await supabaseAdmin.from('secure_share_links')
            .select('id', { count: 'exact', head: true }).eq('created_by', targetId);
        if (shareError) throw shareError;
            
        if (itineraryCount > 0 || statusCount > 0 || shareCount > 0) {
            return res.status(400).json({ success: false, error: 'Cannot delete user with linked business or audit records. Please keep deactivated.' });
        }
        
        // Preflight: Ensure this is not the last active ADMIN.
        // Even though user must be deactivated before deletion, let's verify just in case
        // the trigger handles it, but we can do a soft preflight if they somehow were active.
        
        // Attempt deletion via auth.admin (will cascade to user_roles)
        const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(targetId);
        if (deleteError) throw deleteError;
        
        res.json({ success: true, message: 'User deleted successfully.' });
    } catch (e) {
        console.error("Delete user error:", e);
        if (e.message && e.message.includes('Concurrency block')) {
            return res.status(400).json({ success: false, error: 'Cannot delete the last active ADMIN.' });
        }
        res.status(500).json({ success: false, error: 'Failed to delete user.' });
    }
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
            let version = req.body.version;
            if (version === undefined || version === null) {
                if (req.body.itinerary && req.body.itinerary.version !== undefined && req.body.itinerary.version !== null) {
                    version = req.body.itinerary.version;
                } else if (payload.version !== undefined && payload.version !== null) {
                    version = payload.version;
                } else {
                    version = null;
                }
            }
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
            if (error.message.includes("Atomic audit service unavailable") || error.message.includes("Status transitions are disabled")) {
                return res.status(503).json({ success: false, error: error.message });
            }
            if (error.message.includes("Audit log failure")) {
                return res.status(500).json({ success: false, error: error.message });
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

async function handleStatusChange(req, res) {
    const provider = process.env.STORAGE_PROVIDER;
    if (provider !== undefined && provider !== 'workdrive' && provider !== 'supabase') {
        return res.status(500).json({ success: false, error: 'Safety abort: Invalid STORAGE_PROVIDER.' });
    }
    const activeProvider = provider === undefined ? 'workdrive' : provider;

    if (activeProvider !== 'supabase') {
        return res.status(400).json({ success: false, error: 'Atomic status transitions with audit history are only supported when STORAGE_PROVIDER=supabase.' });
    }

    if (!isSafeSupabaseUrl(process.env.SUPABASE_URL)) {
        return res.status(500).json({ success: false, error: 'Safety abort: Supabase storage is only permitted in the verified staging environment.' });
    }

    const quoteId = req.params.id || req.body.quoteId || req.body.id;
    const newStatus = req.body.status || req.body.newStatus;
    const version = req.body.version !== undefined ? req.body.version : null;

    if (!quoteId) {
        return res.status(400).json({ success: false, error: 'Missing Quotation Number (ID)' });
    }
    if (!newStatus) {
        return res.status(400).json({ success: false, error: 'Missing new status.' });
    }
    if (version === null || version === undefined) {
        return res.status(400).json({ success: false, error: 'Missing current version for concurrency check.' });
    }

    try {
        const updated = await db.changeStatus(quoteId, newStatus, version, req.user, req.userRole);
        return res.json({
            success: true,
            message: 'Status updated successfully.',
            data: updated,
            version: updated.version,
            status: updated.status
        });
    } catch (error) {
        console.error("Status Change Error:", error.message);
        if (error.message.includes("Concurrency Conflict")) {
            return res.status(409).json({ success: false, error: error.message });
        }
        if (error.message.includes("Itinerary not found")) {
            return res.status(404).json({ success: false, error: error.message });
        }
        if (error.message.includes("Not authorized") || error.message.includes("Unauthorized role")) {
            return res.status(403).json({ success: false, error: error.message });
        }
        if (error.message.includes("Atomic audit service unavailable") || error.message.includes("Status transitions are disabled")) {
            return res.status(503).json({ success: false, error: error.message });
        }
        if (error.message.includes("Audit log failure")) {
            return res.status(500).json({ success: false, error: error.message });
        }
        return res.status(500).json({ success: false, error: 'Failed to update status. Please try again later.' });
    }
}

app.post('/api/itineraries/:id/status', requireAuth, handleStatusChange);
app.patch('/api/itineraries/:id/status', requireAuth, handleStatusChange);
app.post('/api/changeStatus', requireAuth, handleStatusChange);

// ==========================================
// SECURE CUSTOMER ITINERARY SHARING (PHASE 3B)
// ==========================================

// 1. Authenticated Staff: Create Share Link
app.post('/api/itineraries/:id/share', requireAuth, async (req, res) => {
    const quoteId = req.params.id;
    if (!quoteId) return res.status(400).json({ success: false, error: 'Missing Quote ID.' });

    try {
        const link = await db.createShareLink(quoteId, req.body || {}, req.user, req.userRole);
        const host = req.get('host');
        const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
        const shareUrl = `${proto}://${host}/view.html?token=${link.token}`;

        return res.json({
            success: true,
            link: {
                ...link,
                url: shareUrl
            }
        });
    } catch(err) {
        console.error("Create Share Link Error:", err.message);
        if (err.message.includes("Itinerary not found")) {
            return res.status(404).json({ success: false, error: err.message });
        }
        if (err.message.includes("Unauthorized") || err.message.includes("only create share links") || err.message.includes("cannot be shared by Sales")) {
            return res.status(403).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: 'Failed to create share link: ' + err.message });
    }
});

// 2. Authenticated Staff: List Share Links for Itinerary
app.get('/api/itineraries/:id/shares', requireAuth, async (req, res) => {
    const quoteId = req.params.id;
    if (!quoteId) return res.status(400).json({ success: false, error: 'Missing Quote ID.' });

    try {
        const links = await db.listShareLinks(quoteId, req.user, req.userRole);
        return res.json({ success: true, links });
    } catch(err) {
        console.error("List Share Links Error:", err.message);
        if (err.message.includes("Itinerary not found")) {
            return res.status(404).json({ success: false, error: err.message });
        }
        if (err.message.includes("Unauthorized") || err.message.includes("only view share links")) {
            return res.status(403).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: 'Failed to list share links: ' + err.message });
    }
});

// 3. Authenticated Staff: Revoke Share Link
app.post('/api/shares/:linkId/revoke', requireAuth, async (req, res) => {
    const linkId = req.params.linkId;
    if (!linkId) return res.status(400).json({ success: false, error: 'Missing Share Link ID.' });

    try {
        const result = await db.revokeShareLink(linkId, req.user, req.userRole);
        return res.json(result);
    } catch(err) {
        console.error("Revoke Share Link Error:", err.message);
        if (err.message.includes("not found")) {
            return res.status(404).json({ success: false, error: err.message });
        }
        if (err.message.includes("Unauthorized") || err.message.includes("only revoke share links")) {
            return res.status(403).json({ success: false, error: err.message });
        }
        return res.status(500).json({ success: false, error: 'Failed to revoke share link: ' + err.message });
    }
});

// 4. Public / Customer: Fetch Itinerary by Share Token
app.get('/api/public/itinerary/:token', async (req, res) => {
    const token = req.params.token || req.query.token;
    if (!token) return res.status(400).json({ success: false, error: 'Missing share token.' });

    try {
        const itinerary = await db.getItineraryByShareToken(token);
        return res.json({
            success: true,
            itinerary
        });
    } catch(err) {
        console.error("Public Itinerary Fetch Error:", err.message);
        const status = err.statusCode || (err.message.includes("expired") || err.message.includes("revoked") ? 410 : 404);
        return res.status(status).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/api/customer/itinerary', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ success: false, error: 'Missing share token parameter.' });

    try {
        const itinerary = await db.getItineraryByShareToken(token);
        return res.json({
            success: true,
            itinerary
        });
    } catch(err) {
        const status = err.statusCode || (err.message.includes("expired") || err.message.includes("revoked") ? 410 : 404);
        return res.status(status).json({
            success: false,
            error: err.message
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

// ==========================================
// Phase 3B.1 - Payments & Bank Reconciliation APIs
// ==========================================

function handlePaymentError(err, res, defaultStatus = 400) {
    const status = err.status || (
        err.message && (
            err.message.includes('Payment storage unavailable') ||
            err.message.includes('Required database migration') ||
            err.message.includes('temporarily unavailable')
        ) ? 503 : (
            err.message && err.message.includes('not found') ? 404 : defaultStatus
        )
    );
    res.status(status).json({
        success: false,
        error: err.message,
        code: err.code || (status === 503 ? 'STORAGE_UNAVAILABLE' : undefined)
    });
}

app.post('/api/payments', requireAuth, async (req, res) => {
    try {
        const { quotation_id, transaction_type } = req.body;
        
        // SALES role permissions: can only record customer_receipt for own itineraries
        if (req.userRole === 'SALES') {
            if (transaction_type && transaction_type !== 'customer_receipt') {
                return res.status(403).json({ success: false, error: 'Sales can only record customer receipts. Contact Admin/Ops for supplier payments or refunds.' });
            }
            if (quotation_id) {
                const itin = await db.getItinerary(quotation_id, req.user, req.userRole);
                if (!itin) {
                    return res.status(404).json({ success: false, error: 'Itinerary not found or access denied.' });
                }
                if (itin.owner_id !== req.user.id) {
                    return res.status(403).json({ success: false, error: 'Sales can only record payments for their own itineraries.' });
                }
            }
        } else if (req.userRole !== 'ADMIN' && req.userRole !== 'OPS') {
            return res.status(403).json({ success: false, error: 'Unauthorized role.' });
        }

        const newPayment = await payments.recordPayment(req.body, req.user, supabaseAdmin);
        res.status(201).json({ success: true, payment: newPayment });
    } catch(err) {
        console.error("Record payment error:", err.message);
        handlePaymentError(err, res, 400);
    }
});

app.get('/api/payments', requireAuth, async (req, res) => {
    try {
        const filters = {
            quotation_id: req.query.quotation_id,
            direction: req.query.direction,
            status: req.query.status,
            payment_method: req.query.payment_method,
            date_from: req.query.date_from,
            date_to: req.query.date_to,
            search: req.query.search
        };

        if (req.userRole === 'SALES') {
            if (filters.quotation_id) {
                const itin = await db.getItinerary(filters.quotation_id, req.user, req.userRole);
                if (!itin || itin.owner_id !== req.user.id) {
                    return res.status(403).json({ success: false, error: 'Sales can only view payments for their own itineraries.' });
                }
            }
        }

        let results = await payments.listPayments(filters, supabaseAdmin);
        
        // If SALES and no quote specified, restrict results to their own itineraries
        if (req.userRole === 'SALES' && !filters.quotation_id) {
            const myItineraries = await db.listItineraries(req.user, req.userRole);
            const myQuoteIds = new Set(myItineraries.map(i => i.id || i.quote_id));
            results = results.filter(p => p.quotation_id && myQuoteIds.has(p.quotation_id));
        }

        res.json({ success: true, count: results.length, data: results });
    } catch(err) {
        console.error("List payments error:", err.message);
        handlePaymentError(err, res, 500);
    }
});

app.post('/api/payments/:id/reconcile', requireAuth, async (req, res) => {
    try {
        if (req.userRole !== 'ADMIN' && req.userRole !== 'OPS') {
            return res.status(403).json({ success: false, error: 'Only Administrator and Operations staff can reconcile payments.' });
        }

        const { statementReference, statementAmount, statementDate, actualFee, reconciliationNotes } = req.body;
        const result = await payments.reconcilePayment({
            paymentId: req.params.id,
            statementReference,
            statementAmount,
            statementDate,
            actualFee,
            reconciliationNotes,
            user: req.user,
            supabaseAdmin
        });

        res.json({
            success: true,
            payment: result.payment,
            audit: result.audit,
            isMatch: result.isMatch,
            discrepancy: result.discrepancy
        });
    } catch(err) {
        console.error("Reconcile payment error:", err.message);
        handlePaymentError(err, res, 400);
    }
});

app.get('/api/payments/duplicates', requireAuth, async (req, res) => {
    try {
        if (req.userRole !== 'ADMIN' && req.userRole !== 'OPS') {
            return res.status(403).json({ success: false, error: 'Only Administrator and Operations staff can review duplicate payment flags.' });
        }

        const flags = await payments.findDuplicatePayments(supabaseAdmin);
        res.json({ success: true, count: flags.length, duplicates: flags });
    } catch(err) {
        console.error("Check duplicates error:", err.message);
        handlePaymentError(err, res, 500);
    }
});

app.get('/api/payments/summary/:quoteId', requireAuth, async (req, res) => {
    try {
        const { quoteId } = req.params;
        const itin = await db.getItinerary(quoteId, req.user, req.userRole);
        if (!itin) {
            return res.status(404).json({ success: false, error: 'Itinerary not found or access denied.' });
        }

        if (req.userRole === 'SALES' && itin.owner_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'Sales can only view financial summaries for their own itineraries.' });
        }

        const quotePayments = await payments.listPayments({ quotation_id: quoteId }, supabaseAdmin);
        const financials = mdrAccounting.calculateItineraryFinancials(itin, quotePayments);

        res.json({ success: true, quotation_id: quoteId, financials, payments_count: quotePayments.length });
    } catch(err) {
        console.error("Payment summary error:", err.message);
        handlePaymentError(err, res, 500);
    }
});

app.post('/api/payments/fee-estimate', requireAuth, (req, res) => {
    try {
        const { amount, paymentMethod, provider, category, transactionDate } = req.body;
        const estimate = mdrAccounting.estimateProcessingFee({
            amount,
            paymentMethod,
            provider,
            category,
            transactionDate
        });
        res.json({ success: true, estimate });
    } catch(err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL && require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

app.setDependencies = (mockSupabase, mockSupabaseAdmin) => {
    if (mockSupabase) supabase = mockSupabase;
    if (mockSupabaseAdmin) supabaseAdmin = mockSupabaseAdmin;
};

module.exports = app;
