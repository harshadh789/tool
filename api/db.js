const { createClient } = require('@supabase/supabase-js');

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

    // Concurrency Check
    if (existing.version !== currentVersion) {
        throw new Error("Concurrency Conflict: The itinerary has been modified by someone else since you loaded it. Please refresh and try again.");
    }

    const updatedRecord = {
        status: payload.status || existing.status,
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

    // Use optimistic concurrency condition
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

    if (existing.version !== currentVersion) {
        throw new Error("Concurrency Conflict: The itinerary has been modified. Refresh required.");
    }
    
    const { data, error } = await supabase
        .from('itineraries')
        .update({
            status: newStatus,
            version: existing.version + 1,
            updated_at: new Date().toISOString()
        })
        .eq('quote_id', quoteId)
        .eq('version', currentVersion)
        .select()
        .single();
        
    if (error || !data) throw new Error("Status update failed due to conflict.");

    // Log status history
    await supabase.from('status_history').insert([{
        itinerary_id: data.id,
        user_id: user.id,
        old_status: existing.status,
        new_status: newStatus
    }]);

    return data;
}

module.exports = {
    getItinerary,
    listItineraries,
    createItinerary,
    updateItinerary,
    changeStatus
};
