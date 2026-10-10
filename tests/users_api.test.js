const request = require('supertest');
const app = require('../api/server.js');

let passed = 0; let total = 0;
const assert = (cond, name) => {
    total++;
    if (cond) { passed++; console.log('✅ ' + name); }
    else { console.error('❌ ' + name); }
};

// Mock Data
let users = [
    { id: 'u1', email: 'admin@test.com', created_at: '2026' },
    { id: 'sales1', email: 'sales@test.com', created_at: '2026' },
    { id: 'ops1', email: 'ops@test.com', created_at: '2026' },
    { id: 'u_inactive', email: 'inactive@test.com', created_at: '2026' },
    { id: 'u_recovery', email: 'recovery@test.com', created_at: '2026' } // In Auth, but no role
];
let userRoles = [
    { user_id: 'u1', role: 'ADMIN', is_active: true },
    { user_id: 'sales1', role: 'SALES', is_active: true },
    { user_id: 'ops1', role: 'OPS', is_active: true },
    { user_id: 'u_inactive', role: 'SALES', is_active: false }
];

// Mock Supabase Admin
const mockSupabaseAdmin = {
    auth: {
        admin: {
            listUsers: async () => ({ data: { users }, error: null }),
            inviteUserByEmail: async (email, options) => {
                if (!options || !options.redirectTo) return { error: new Error('Missing redirectTo') };
                if (email === 'fail_invite@test.com') return { error: new Error('Invite failed') };
                if (email === 'fail_role@test.com') return { data: { user: { id: 'u_fail_role_insert' } }, error: null };
                return { data: { user: { id: 'u2' } }, error: null };
            },
            getUserById: async (id) => {
                if (users.find(u => u.id === id) || id === 'u_recovery' || id === 'u2') {
                    const found = users.find(u => u.id === id);
                    if (id === 'u_recovery') return { data: { user: { id: 'u_recovery', email: 'recovery@test.com' } }, error: null };
                    return { data: { user: { id, email: found ? found.email : 'test@test.com', confirmed_at: id === 'ops1' ? '2026' : null } }, error: null };
                }
                return { data: null, error: new Error('User not found') };
            },
            deleteUser: async (id) => {
                if (id === 'fail_delete') return { error: new Error('Delete failed') };
                if (global.testLastAdminDelete) return { error: new Error('Concurrency block: Cannot delete last admin') };
                return { error: null };
            }
        },
        resetPasswordForEmail: async (email, options) => {
            if (email === 'fail_reset@test.com') return { error: new Error('Reset failed') };
            return { error: null };
        }
    },
    from: (table) => ({
        select: (fields, options) => {
            const builder = {
                eq: (col, val) => {
                    builder.filters = builder.filters || {};
                    builder.filters[col] = val;
                    return builder;
                },
                single: async () => {
                    const row = userRoles.find(r => r[Object.keys(builder.filters)[0]] === Object.values(builder.filters)[0]);
                    if (row) return { data: row, error: null };
                    return { data: null, error: null }; // Supposed to behave like .single() when no row? No, single returns error if no rows.
                    // Actually supabase .single() throws if 0 rows. Let's return error to simulate no rows.
                },
                then: (resolve) => {
                    if (options && options.head) {
                        // Artificially return 1 if we are testing last admin demotion
                        if (global.testLastAdmin) return resolve({ count: 1, error: null });
                        
                        if (table === 'itineraries' && global.testLinkedRecords) return resolve({ count: 1, error: null });
                        if (table === 'itineraries' || table === 'status_history' || table === 'secure_share_links') return resolve({ count: 0, error: null });
                        
                        const count = userRoles.filter(r => r.role === 'ADMIN' && r.is_active).length;
                        return resolve({ count, error: null });
                    }
                    if (table !== 'user_roles') return resolve({ data: [], error: null });
                    resolve({ data: userRoles, error: null });
                }
            };
            builder.single = async () => {
                const row = userRoles.find(r => r[Object.keys(builder.filters)[0]] === Object.values(builder.filters)[0]);
                if (row) return { data: row, error: null };
                return { data: null, error: new Error('PGRST116: no rows returned') };
            };
            builder.maybeSingle = async () => {
                const row = userRoles.find(r => r[Object.keys(builder.filters)[0]] === Object.values(builder.filters)[0]);
                if (row) return { data: row, error: null };
                return { data: null, error: null };
            };
            return builder;
        },
        insert: async (arr) => {
            if (arr[0].user_id === 'u_fail_role_insert') {
                return { error: new Error('Role assignment failed') };
            }
            userRoles.push(arr[0]);
            return { error: null };
        },
        update: (updates) => {
            return {
                eq: async (col, val) => {
                    if (val === 'u_fail') return { error: new Error('Update failed') };
                    const idx = userRoles.findIndex(r => r[col] === val);
                    if (idx > -1) {
                        userRoles[idx] = { ...userRoles[idx], ...updates };
                    }
                    return { error: null };
                }
            };
        }
    })
};

// Mock standard Supabase Client
const mockSupabase = {
    auth: {
        getUser: async (token) => {
            if (token === 'valid_admin') return { data: { user: { id: 'u1', email: 'admin@test.com' } }, error: null };
            if (token === 'valid_admin2') return { data: { user: { id: 'u3', email: 'admin2@test.com' } }, error: null };
            if (token === 'valid_sales') return { data: { user: { id: 'sales1', email: 'sales@test.com' } }, error: null };
            if (token === 'valid_ops') return { data: { user: { id: 'ops1', email: 'ops@test.com' } }, error: null };
            if (token === 'inactive') return { data: { user: { id: 'u_inactive', email: 'inactive@test.com' } }, error: null };
            return { data: null, error: new Error('Invalid token') };
        }
    }
};

// Inject dependencies
app.setDependencies(mockSupabase, mockSupabaseAdmin);

// Initialize test state
users.push({ id: 'u3', email: 'admin2@test.com', created_at: '2026' });
userRoles.push({ user_id: 'u3', role: 'ADMIN', is_active: true });

async function runTests() {
    console.log("Running integration tests on actual server.js...\n");

    // 1. ADMIN can list users
    let r = await request(app).get('/api/users').set('Authorization', 'Bearer valid_admin');
    assert(r.status === 200 && r.body.users.length > 0, '1. ADMIN can list users');

    // 2. SALES and OPS cannot access user-management endpoints
    r = await request(app).get('/api/users').set('Authorization', 'Bearer valid_sales');
    assert(r.status === 403, '2a. SALES cannot access user endpoints');
    r = await request(app).get('/api/users').set('Authorization', 'Bearer valid_ops');
    assert(r.status === 403, '2b. OPS cannot access user endpoints');

    // 3. Unauthenticated requests are rejected
    r = await request(app).get('/api/users');
    assert(r.status === 401, '3. Unauthenticated requests are rejected');

    // 4. User invitations validate email and role
    r = await request(app).post('/api/users').set('Authorization', 'Bearer valid_admin').send({ email: 'bad', role: 'INVALID' });
    assert(r.status === 400, '4. User invitations validate email and role');

    // 5. A new user is created and assigned role correctly (also verifies redirectTo was passed)
    r = await request(app).post('/api/users').set('Authorization', 'Bearer valid_admin').send({ email: 'test@test.com', role: 'SALES' });
    assert(r.status === 200 && r.body.user_id === 'u2', '5. A new user is correctly processed with redirectTo');

    // 6. Invitation/role-assignment partial failure is handled safely
    r = await request(app).post('/api/users').set('Authorization', 'Bearer valid_admin').send({ email: 'fail_role@test.com', role: 'SALES' });
    assert(r.status === 500 && r.body.error.includes('role assignment failed'), '6. Partial failure handled safely');

    // 7. Admin can recover an existing Auth user with no role row (Upsert flow)
    r = await request(app).patch('/api/users/u_recovery').set('Authorization', 'Bearer valid_admin').send({ role: 'OPS' });
    assert(r.status === 200, '7. Admin can recover an existing Auth user with no role row (Insert)');
    assert(userRoles.find(ur => ur.user_id === 'u_recovery' && ur.role === 'OPS'), '7b. Role was inserted successfully');

    // 8. Existing role row is updated rather than duplicated
    r = await request(app).patch('/api/users/u_recovery').set('Authorization', 'Bearer valid_admin').send({ role: 'SALES' });
    assert(r.status === 200, '8. Existing role row is updated');
    const recoveryRoles = userRoles.filter(ur => ur.user_id === 'u_recovery');
    assert(recoveryRoles.length === 1 && recoveryRoles[0].role === 'SALES', '8b. Role was updated, no duplicates');

    // 9. Users cannot change their own role
    r = await request(app).patch('/api/users/u1').set('Authorization', 'Bearer valid_admin').send({ role: 'SALES' });
    assert(r.status === 400 && r.body.error.includes('own account'), '9. Users cannot change their own role');

    // 10. The last active ADMIN cannot be deactivated
    global.testLastAdmin = true;
    r = await request(app).patch('/api/users/u1').set('Authorization', 'Bearer valid_admin2').send({ is_active: false });
    assert(r.status === 400 && r.body.error.includes('last active ADMIN'), '10a. Cannot deactivate last active ADMIN');

    // 10b. The last active ADMIN cannot be demoted to SALES
    r = await request(app).patch('/api/users/u1').set('Authorization', 'Bearer valid_admin2').send({ role: 'SALES' });
    assert(r.status === 400 && r.body.error.includes('last active ADMIN'), '10b. Cannot demote last active ADMIN');
    global.testLastAdmin = false;

    // 10c. Can demote one of multiple active ADMINs (since testLastAdmin is false, count is 2)
    r = await request(app).patch('/api/users/u1').set('Authorization', 'Bearer valid_admin2').send({ role: 'SALES' });
    assert(r.status === 200, '10c. Can demote one of multiple active ADMINs');

    // 11. Inactive users cannot access protected routes
    r = await request(app).get('/api/users').set('Authorization', 'Bearer inactive');
    assert(r.status === 403, '11. Inactive users cannot access protected routes');

    // 12. /api/me returns actual role
    r = await request(app).get('/api/me').set('Authorization', 'Bearer valid_sales');
    assert(r.status === 200 && r.body.user.role === 'SALES', '12. /api/me returns correct role');

    // 13. No credentials exposed
    r = await request(app).get('/api/me').set('Authorization', 'Bearer valid_admin');
    assert(!r.body.token && !r.body.password, '13. No tokens/passwords exposed in /api/me');

    // 14. Setting is_active to null is ignored safely
    r = await request(app).patch('/api/users/ops1').set('Authorization', 'Bearer valid_admin2').send({ is_active: null });
    assert(r.status === 400 && r.body.error && r.body.error.includes('No valid updates'), '14. NULL is_active is safely ignored by Express');
    
    // 15. Password reset endpoint success for confirmed user
    r = await request(app).post('/api/users/ops1/resend').set('Authorization', 'Bearer valid_admin2');
    console.log("15: ", r.status, r.body);
    assert(r.status === 200, '15. Password reset sent for confirmed user');
    
    // 16. Password reset blocked for unconfirmed user
    r = await request(app).post('/api/users/sales1/resend').set('Authorization', 'Bearer valid_admin2');
    console.log("16: ", r.status, r.body);
    assert(r.status === 400 && r.body.error.includes('unconfirmed'), '16. Password reset blocked for unconfirmed user');
    
    // 17. Delete fails if user is active
    r = await request(app).delete('/api/users/sales1').set('Authorization', 'Bearer valid_admin2');
    console.log("17: ", r.status, r.body);
    assert(r.status === 400 && r.body.error.includes('deactivated before deletion'), '17. Delete blocked for active user');
    
    // 18. Delete fails if linked records exist
    global.testLinkedRecords = true;
    r = await request(app).delete('/api/users/u_inactive').set('Authorization', 'Bearer valid_admin2');
    console.log("18: ", r.status, r.body);
    assert(r.status === 400 && r.body.error.includes('linked business or audit records'), '18. Delete blocked if linked records exist');
    global.testLinkedRecords = false;
    
    // 19. Delete fails for last admin
    global.testLastAdminDelete = true;
    r = await request(app).delete('/api/users/u_inactive').set('Authorization', 'Bearer valid_admin2');
    console.log("19: ", r.status, r.body);
    assert(r.status === 400 && r.body.error.includes('last active ADMIN'), '19. Delete blocked for last admin (DB cascade check)');
    global.testLastAdminDelete = false;
    
    // 20. Delete succeeds for deactivated user with no records
    r = await request(app).delete('/api/users/u_inactive').set('Authorization', 'Bearer valid_admin2');
    console.log("20: ", r.status, r.body);
    assert(r.status === 200, '20. Delete succeeds for eligible user');
    
    console.log(`\nTests completed: ${passed}/${total} passed.`);
}

runTests();
