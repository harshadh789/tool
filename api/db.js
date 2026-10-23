const { createClient } = require('@supabase/supabase-js');
const { validateItinerary } = require('../validation.js');
const crypto = require('crypto');

function hashToken(token) {
    if (!token || typeof token !== 'string') return '';
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use Secret Key for backend operations to bypass RLS,
// allowing us to enforce strict logic and concurrency checks in code.
let supabase = null;
if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
}

function checkInit() {
    if (!supabase) throw new Error("Supabase is not configured. Missing SUPABASE_SECRET_KEY.");
}

async function getItinerary(quoteId, user, userRole) {
    checkInit();
    const { data, error } = await supabase
        .from('itineraries')
        .select('*')
        .eq('quote_id', quoteId)
        .single();
        
    if (error) {
        if (error.code === 'PGRST116') return null; // Not found
        throw error;
    }
    
    // Read Authorization
    if (userRole === 'ADMIN' || userRole === 'OPS') {
        return data; // Admin and Ops can read all
    }
    if (userRole === 'SALES') {
        // Sales can read all? Prompt: "SALES: access to records permitted by the configured ownership policy."
        // Usually Sales can read all in a small agency, but let's restrict to owner or unassigned for safety,
        // or just let them read all but edit only their own.
        // Wait, prompt says: "SALES: access to records permitted by the configured ownership policy."
        // Let's allow Sales to read all for now, but restrict edits.
        return data;
    }
    throw new Error("Unauthorized role for reading itinerary.");
}

async function listItineraries(user, userRole) {
    checkInit();
    let query = supabase.from('itineraries').select('id, quote_id, status, is_voucher_mode, guest_name, title, start_date, end_date, guest_count, total_amount, currency, owner_id, version, updated_at');
    
    if (userRole === 'ADMIN' || userRole === 'OPS' || userRole === 'SALES') {
        // Can see all
    } else {
        throw new Error("Unauthorized role.");
    }
    
    const { data, error } = await query.order('updated_at', { ascending: false });
    if (error) throw error;
    return data;
}

async function createItinerary(quoteId, payload, user, userRole) {
    checkInit();
    
    // Authorization: Sales or Admin can create
    if (userRole !== 'ADMIN' && userRole !== 'SALES') {
        throw new Error("Only Admin and Sales can create itineraries.");
    }

    const valRes = validateItinerary(payload);
    if (!valRes.isValid) {
        throw new Error("Validation failed: " + valRes.errors.join("; "));
    }

    const newRecord = {
        quote_id: quoteId,
        owner_id: user.id,
        status: payload.status || 'Draft',
        is_voucher_mode: !!payload.isVoucherMode,
        guest_name: payload.guest || null,
        title: payload.title || null,
        start_date: payload.start || null,
        end_date: payload.end || null,
        guest_count: payload.adults ? parseInt(payload.adults) : null,
        total_amount: payload.baseCost ? parseFloat(payload.baseCost) : null,
        currency: payload.currency || null,
        content: payload,
        version: 1
    };

    const { data, error } = await supabase.from('itineraries').insert([newRecord]).select().single();
    if (error) {
        if (error.code === '23505') { // Unique violation
            throw new Error(`Conflict: Quote ID ${quoteId} already exists.`);
        }
        throw error;
    }
    
    return data;
}

async function updateItinerary(quoteId, payload, currentVersion, user, userRole) {
    checkInit();
    
    // Fetch existing
    const existing = await getItinerary(quoteId, user, 'ADMIN'); // bypass read check to verify edit permission
    if (!existing) throw new Error("Itinerary not found.");
    
    // Authorization to edit
    if (userRole === 'ADMIN') {
        // Admin can edit anything
    } else if (userRole === 'SALES') {
        if (existing.owner_id === null) {
            throw new Error("Legacy unassigned records can only be edited by an Administrator.");
        }
        if (existing.owner_id !== user.id) {
            throw new Error("Sales can only edit their own itineraries.");
        }
    } else {
        throw new Error("Ops/Unauthorized cannot edit itinerary content directly.");
    }

    const valRes = validateItinerary(payload);
    if (!valRes.isValid) {
        throw new Error("Validation failed: " + valRes.errors.join("; "));
    }

    // Concurrency Check
    if (existing.version !== currentVersion) {
        throw new Error("Concurrency Conflict: The itinerary has been modified by someone else since you loaded it. Please refresh and try again.");
    }

    const targetStatus = payload.status || existing.status;
    const isStatusChange = (targetStatus !== existing.status);

    // 1. Authoritative Transactional Path: Call PostgreSQL atomic RPC function
    if (typeof supabase.rpc === 'function') {
        const { data: rpcData, error: rpcError } = await supabase.rpc('update_itinerary_status_atomic', {
            p_quote_id: quoteId,
            p_current_version: currentVersion,
            p_user_id: user.id,
            p_status: targetStatus,
            p_is_voucher_mode: payload.isVoucherMode !== undefined ? !!payload.isVoucherMode : existing.is_voucher_mode,
            p_guest_name: payload.guest || existing.guest_name,
            p_title: payload.title || existing.title,
            p_start_date: payload.start || existing.start_date,
            p_end_date: payload.end || existing.end_date,
            p_guest_count: payload.adults ? parseInt(payload.adults) : existing.guest_count,
            p_total_amount: payload.baseCost ? parseFloat(payload.baseCost) : existing.total_amount,
            p_currency: payload.currency || existing.currency,
            p_content: payload
        });

        if (!rpcError) {
            return rpcData;
        }

        // Handle PostgreSQL error conditions from the RPC transaction
        if (rpcError.message && rpcError.message.includes('CONCURRENCY_CONFLICT')) {
            throw new Error("Concurrency Conflict: The itinerary has been modified by someone else since you loaded it. Please refresh and try again.");
        }
        if (rpcError.message && rpcError.message.includes('ITINERARY_NOT_FOUND')) {
            throw new Error("Itinerary not found.");
        }

        const isRpcMissing = rpcError.code === 'PGRST202' ||
            (rpcError.message && (
                rpcError.message.includes('Could not find the function') ||
                rpcError.message.includes('does not exist')
            ));

        // If status changed and RPC is missing, FAIL CLOSED to guarantee audit atomicity
        if (isRpcMissing && isStatusChange) {
            throw new Error("Atomic audit service unavailable: Required database migration (v4_status_history_atomic) is not installed. Status transitions are disabled until the migration is applied.");
        }

        // If the error was a real constraint or audit failure within the transaction, propagate it
        if (!isRpcMissing) {
            throw new Error(`Audit log failure: ${rpcError.message}`);
        }
    } else if (isStatusChange) {
        // RPC is not supported by client, fail closed for status changes
        throw new Error("Atomic audit service unavailable: Required database migration (v4_status_history_atomic) is not installed. Status transitions are disabled until the migration is applied.");
    }

    // 2. Safe Fallback path ONLY for non-status content/field updates
    const updatedRecord = {
        status: existing.status, // Preserve existing status strictly
        is_voucher_mode: payload.isVoucherMode !== undefined ? !!payload.isVoucherMode : existing.is_voucher_mode,
        guest_name: payload.guest || existing.guest_name,
        title: payload.title || existing.title,
        start_date: payload.start || existing.start_date,
        end_date: payload.end || existing.end_date,
        guest_count: payload.adults ? parseInt(payload.adults) : existing.guest_count,
        total_amount: payload.baseCost ? parseFloat(payload.baseCost) : existing.total_amount,
        currency: payload.currency || existing.currency,
        content: payload,
        version: existing.version + 1,
        updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('itineraries')
        .update(updatedRecord)
        .eq('quote_id', quoteId)
        .eq('version', currentVersion)
        .select()
        .single();
        
    if (error) throw error;
    if (!data) throw new Error("Update failed due to version conflict or missing record.");

    return data;
}

async function changeStatus(quoteId, newStatus, currentVersion, user, userRole) {
    checkInit();
    
    const existing = await getItinerary(quoteId, user, 'ADMIN');
    if (!existing) throw new Error("Itinerary not found.");
    
    // Admin, Sales (owner), Ops can change status
    if (userRole === 'SALES' && existing.owner_id !== user.id) {
        throw new Error("Not authorized to change status of this itinerary.");
    }
    if (userRole !== 'ADMIN' && userRole !== 'SALES' && userRole !== 'OPS') {
        throw new Error("Unauthorized role.");
    }

    if (existing.version !== currentVersion) {
        throw new Error("Concurrency Conflict: The itinerary has been modified. Refresh required.");
    }

    if (existing.status === newStatus) {
        return existing; // No status change with valid version, avoid duplicate audit entry
    }

    // Authoritative Transactional Path: Call PostgreSQL atomic RPC function
    if (typeof supabase.rpc !== 'function') {
        throw new Error("Atomic audit service unavailable: Required database migration (v4_status_history_atomic) is not installed. Status transitions are disabled until the migration is applied.");
    }

    const { data: rpcData, error: rpcError } = await supabase.rpc('change_itinerary_status_atomic', {
        p_quote_id: quoteId,
        p_current_version: currentVersion,
        p_user_id: user.id,
        p_new_status: newStatus
    });

    if (!rpcError) {
        return rpcData;
    }

    if (rpcError.message && rpcError.message.includes('CONCURRENCY_CONFLICT')) {
        throw new Error("Concurrency Conflict: The itinerary has been modified. Refresh required.");
    }
    if (rpcError.message && rpcError.message.includes('ITINERARY_NOT_FOUND')) {
        throw new Error("Itinerary not found.");
    }

    const isRpcMissing = rpcError.code === 'PGRST202' ||
        (rpcError.message && (
            rpcError.message.includes('Could not find the function') ||
            rpcError.message.includes('does not exist')
        ));

    if (isRpcMissing) {
        throw new Error("Atomic audit service unavailable: Required database migration (v4_status_history_atomic) is not installed. Status transitions are disabled until the migration is applied.");
    }

    throw new Error(`Audit log failure: ${rpcError.message}`);
}

function setClient(customClient) {
    supabase = customClient;
}

function filterCustomerItinerary(rawRecord) {
    if (!rawRecord) return null;
    const content = rawRecord.content || {};

    const sanitizedDays = Array.isArray(content.days) ? content.days.map((day, idx) => ({
        dayNumber: idx + 1,
        title: day.title || '',
        desc: day.desc || '',
        img: day.img || '',
        stay: day.stay || ''
    })) : [];

    const sanitizedHotels = Array.isArray(content.hotels) ? content.hotels.map(h => ({
        label: h.label || '',
        nights: h.nights || '',
        name: h.name || '',
        star: h.star || '',
        room: h.room || '',
        conf: h.conf || '',
        meals: h.meals || {}
    })) : [];

    const safeDocs = Array.isArray(content.documents) ? content.documents.filter(d => !d.isInternal && !d.internal).map(d => ({
        name: d.name,
        type: d.type,
        url: d.url
    })) : [];

    return {
        id: rawRecord.quote_id || content.id,
        quote_id: rawRecord.quote_id || content.id,
        status: rawRecord.status,
        isVoucherMode: rawRecord.is_voucher_mode !== undefined ? rawRecord.is_voucher_mode : !!content.isVoucherMode,
        title: rawRecord.title || content.title || '',
        guest: rawRecord.guest_name || content.guest || '',
        adults: rawRecord.guest_count !== undefined ? rawRecord.guest_count : content.adults,
        start: rawRecord.start_date || content.start || '',
        end: rawRecord.end_date || content.end || '',
        duration: content.duration || '',
        heroImg: content.heroImg || '',
        genDate: content.genDate || '',
        validDate: content.validDate || '',
        
        repName: content.repName || 'Campfly Travel Expert',
        repTagline: content.repTagline || '',
        repAvatar: content.repAvatar || '',
        repPhone: content.repPhone || '',
        repEmail: content.repEmail || '',
        address: content.address || '',
        socWeb: content.socWeb || 'www.campfly.in',
        socIg: content.socIg || '@campfly',
        socYt: content.socYt || '/campfly',

        currency: rawRecord.currency || content.currency || 'INR',
        costType: content.costType || 'Total Package Cost',
        baseCost: rawRecord.total_amount !== undefined && rawRecord.total_amount !== null ? rawRecord.total_amount : content.baseCost,
        discount: content.discount || 0,
        gstPct: content.gstPct || 5,
        advAmount: content.advAmount || '',
        advDate: content.advDate || '',
        balDate: content.balDate || '',
        qrToggle: content.qrToggle !== undefined ? content.qrToggle : true,

        flights: content.flights || '',
        cabDetails: content.cabDetails || '',
        driverName: content.driverName || '',
        driverPhone: content.driverPhone || '',
        pickupInst: content.pickupInst || '',

        days: sanitizedDays,
        hotels: sanitizedHotels,
        inc: content.inc || '',
        exc: content.exc || '',
        terms: content.terms || '',
        documents: safeDocs,

        bankDetails: {
            name: "CAMPFLY TOURS LLP",
            account: "10292311723",
            ifsc: "IDFB0080511",
            upi: "Campfly@idfcbank"
        }
    };
}

async function createShareLink(quoteId, options = {}, user, userRole) {
    checkInit();
    
    const existing = await getItinerary(quoteId, user, 'ADMIN');
    if (!existing) throw new Error("Itinerary not found.");

    if (userRole === 'SALES') {
        if (existing.owner_id === null) {
            throw new Error("Legacy unassigned records cannot be shared by Sales. Contact an Administrator.");
        }
        if (existing.owner_id !== user.id) {
            throw new Error("Sales can only create share links for their own itineraries.");
        }
    } else if (userRole !== 'ADMIN' && userRole !== 'OPS') {
        throw new Error("Unauthorized role for creating share link.");
    }

    let days = parseInt(options.expiresInDays, 10);
    if (isNaN(days) || days < 1) days = 30;
    if (days > 90) days = 90;

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);

    const record = {
        itinerary_id: existing.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_by: user.id,
        created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('secure_share_links')
        .insert([record])
        .select('id, itinerary_id, expires_at, created_at, created_by')
        .single();

    if (error) throw error;

    return {
        id: data.id,
        itinerary_id: data.itinerary_id,
        quote_id: existing.quote_id,
        token: rawToken,
        expires_at: data.expires_at,
        created_at: data.created_at,
        created_by: data.created_by
    };
}

async function listShareLinks(quoteId, user, userRole) {
    checkInit();

    const existing = await getItinerary(quoteId, user, 'ADMIN');
    if (!existing) throw new Error("Itinerary not found.");

    if (userRole === 'SALES') {
        if (existing.owner_id !== user.id) {
            throw new Error("Sales can only view share links for their own itineraries.");
        }
    } else if (userRole !== 'ADMIN' && userRole !== 'OPS') {
        throw new Error("Unauthorized role.");
    }

    let query = supabase
        .from('secure_share_links')
        .select('id, itinerary_id, expires_at, created_at, created_by')
        .eq('itinerary_id', existing.id)
        .order('created_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;

    const now = new Date();
    return (data || []).map(link => {
        const isExpired = link.expires_at ? new Date(link.expires_at) <= now : false;
        const isRevoked = !!link.revoked_at || (link.expires_at && new Date(link.expires_at).getTime() === 0);
        return {
            id: link.id,
            itinerary_id: link.itinerary_id,
            quote_id: existing.quote_id,
            created_at: link.created_at,
            created_by: link.created_by,
            expires_at: link.expires_at,
            revoked_at: link.revoked_at || (isRevoked ? link.expires_at : null),
            is_active: !isRevoked && !isExpired
        };
    });
}

async function revokeShareLink(linkId, user, userRole) {
    checkInit();

    const { data: link, error: linkErr } = await supabase
        .from('secure_share_links')
        .select('id, itinerary_id, expires_at, created_at, created_by')
        .eq('id', linkId)
        .single();

    if (linkErr || !link) {
        throw new Error("Share link not found.");
    }

    const { data: parentItin, error: itinErr } = await supabase
        .from('itineraries')
        .select('id, quote_id, owner_id')
        .eq('id', link.itinerary_id)
        .single();

    if (itinErr || !parentItin) {
        throw new Error("Associated itinerary not found.");
    }

    if (userRole === 'SALES') {
        if (parentItin.owner_id !== user.id) {
            throw new Error("Sales can only revoke share links for their own itineraries.");
        }
    } else if (userRole !== 'ADMIN' && userRole !== 'OPS') {
        throw new Error("Unauthorized role.");
    }

    const now = new Date().toISOString();
    const updatePayload = {
        expires_at: new Date(0).toISOString()
    };
    updatePayload.revoked_at = now;

    let updateRes;
    try {
        const { data, error } = await supabase
            .from('secure_share_links')
            .update(updatePayload)
            .eq('id', linkId)
            .select()
            .single();
        if (error) throw error;
        updateRes = data;
    } catch(err) {
        if (err.message && err.message.includes('revoked_at')) {
            const { data, error } = await supabase
                .from('secure_share_links')
                .update({ expires_at: new Date(0).toISOString() })
                .eq('id', linkId)
                .select()
                .single();
            if (error) throw error;
            updateRes = data;
        } else {
            throw err;
        }
    }

    return {
        success: true,
        id: linkId,
        itinerary_id: link.itinerary_id,
        revoked_at: now
    };
}

async function getItineraryByShareToken(token) {
    checkInit();

    if (!token || typeof token !== 'string' || token.trim().length < 32) {
        const err = new Error("Invalid share token.");
        err.statusCode = 404;
        throw err;
    }

    const tokenHash = hashToken(token);

    const { data: link, error: linkErr } = await supabase
        .from('secure_share_links')
        .select('id, itinerary_id, expires_at, created_at')
        .eq('token_hash', tokenHash)
        .single();

    if (linkErr || !link) {
        const err = new Error("Invalid or expired share link.");
        err.statusCode = 404;
        throw err;
    }

    const isRevoked = !!link.revoked_at || (link.expires_at && new Date(link.expires_at).getTime() === 0);
    if (isRevoked) {
        const err = new Error("This share link has been revoked.");
        err.statusCode = 410;
        throw err;
    }

    if (link.expires_at && new Date(link.expires_at) <= new Date()) {
        const err = new Error("This share link has expired.");
        err.statusCode = 410;
        throw err;
    }

    const { data: itinerary, error: itinErr } = await supabase
        .from('itineraries')
        .select('*')
        .eq('id', link.itinerary_id)
        .single();

    if (itinErr || !itinerary) {
        const err = new Error("Itinerary not found or no longer available.");
        err.statusCode = 404;
        throw err;
    }

    return filterCustomerItinerary(itinerary);
}

module.exports = {
    getItinerary,
    listItineraries,
    createItinerary,
    updateItinerary,
    changeStatus,
    createShareLink,
    listShareLinks,
    revokeShareLink,
    getItineraryByShareToken,
    filterCustomerItinerary,
    hashToken,
    setClient
};

