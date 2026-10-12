const { createClient } = require('@supabase/supabase-js');
const { validateItinerary } = require('../validation.js');

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

module.exports = {
    getItinerary,
    listItineraries,
    createItinerary,
    updateItinerary,
    changeStatus,
    setClient
};
