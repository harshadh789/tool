let allUsers = [];

document.addEventListener("DOMContentLoaded", async () => {
    const isAuth = await initAuth();
    if (!isAuth) {
        window.location.href = 'index.html';
        return;
    }
    
    // Check if user is ADMIN
    try {
        const meResRaw = await fetchWithAuth('/api/me');
        if (meResRaw.status === 401) {
            window.location.href = 'index.html';
            return;
        }
        
        let meData;
        try {
            meData = await meResRaw.json();
        } catch(e) {
            throw new Error("Invalid response from server");
        }
        
        if (meResRaw.status === 403 || (meData.success && meData.user && meData.user.role !== 'ADMIN')) {
            alert("Unauthorized: Only ADMIN users can access this page.");
            window.location.href = 'dashboard.html';
            return;
        }

        if (meData.success && meData.user) {
            document.getElementById('dash_user_role').innerText = meData.user.role;
            document.getElementById('dash_user_email').innerText = meData.user.email;
        }
    } catch (e) {
        console.error("Failed to load user profile", e);
    }

    fetchUsers();
});

async function fetchUsers() {
    const tbody = document.getElementById('users_table_body');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading users...</td></tr>';
    
    try {
        const resRaw = await fetchWithAuth('/api/users');
        if (resRaw.status === 401) {
            window.location.href = 'index.html';
            return;
        }
        
        let data;
        try {
            data = await resRaw.json();
        } catch(e) {
            throw new Error("Invalid response from server");
        }
        
        if (resRaw.status === 403) throw new Error(data.error || "Access Denied");
        if (!resRaw.ok) throw new Error(data.error || `Server error: HTTP ${resRaw.status}`);
        if (!data.success) throw new Error(data.error || "Failed to load users");
        
        allUsers = data.users || [];
        renderUsers();
    } catch (error) {
        console.error("Error fetching users:", error);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:red;">Error loading users: ${error.message}</td></tr>`;
    }
}

function renderUsers() {
    const tbody = document.getElementById('users_table_body');
    tbody.innerHTML = "";
    
    if (allUsers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#64748b; padding:30px;">No users found.</td></tr>';
        return;
    }
    
    allUsers.forEach(u => {
        const tr = document.createElement('tr');
        const d = new Date(u.created_at);
        const dateStr = isNaN(d) ? 'N/A' : d.toISOString().split('T')[0];
        
        const statusBadge = u.is_active 
            ? '<span class="badge-active">Active</span>' 
            : '<span class="badge-inactive">Inactive</span>';
            
        const roleLabel = `<span style="font-weight:600; color: #475569;">${u.role}</span>`;
        
        const isConfirmed = !!u.confirmed_at;
        const resetBtn = isConfirmed 
            ? `<button class="btn btn-secondary" style="padding: 6px 12px; font-size:12px; margin-left: 5px;" onclick="resendUserAction('${u.id}', '${u.email}')">
                   <i class="fa-solid fa-key"></i> Reset Pwd
               </button>`
            : `<span style="font-size: 11px; color: #94a3b8; margin-left: 5px; font-style: italic;">(Pending)</span>`;

        tr.innerHTML = `
            <td><strong>${u.email}</strong></td>
            <td>${roleLabel}</td>
            <td>${statusBadge}</td>
            <td>${dateStr}</td>
            <td>
                <button class="btn btn-secondary" style="padding: 6px 12px; font-size:12px;" onclick="openEditModal('${u.id}')">
                    <i class="fa-solid fa-pen"></i> Edit
                </button>
                ${resetBtn}
                <button class="btn" style="padding: 6px 12px; font-size:12px; background: #fee2e2; color: #ef4444; border: 1px solid #fecaca; margin-left: 5px;" onclick="confirmDeleteUser('${u.id}', '${u.email}')">
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// Invite Modal
function openInviteModal() {
    document.getElementById('invite_error').innerText = "";
    document.getElementById('invite_email').value = "";
    document.getElementById('invite_role').value = "SALES";
    document.getElementById('invite_modal').style.display = 'flex';
}
function closeInviteModal() {
    document.getElementById('invite_modal').style.display = 'none';
}
async function submitInvite() {
    const email = document.getElementById('invite_email').value.trim();
    const role = document.getElementById('invite_role').value;
    const btn = document.getElementById('btn_invite_submit');
    const errEl = document.getElementById('invite_error');
    
    if (!email) { errEl.innerText = "Email is required."; return; }
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    errEl.innerText = "";
    
    try {
        const resRaw = await fetchWithAuth('/api/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, role })
        });
        
        if (resRaw.status === 401) {
            window.location.href = 'index.html';
            return;
        }
        
        let data;
        try {
            data = await resRaw.json();
        } catch(e) {
            throw new Error("Invalid response from server");
        }
        
        if (resRaw.status === 403) throw new Error(data.error || "Access Denied");
        if (!resRaw.ok) throw new Error(data.error || `Server error: HTTP ${resRaw.status}`);
        if (!data.success) throw new Error(data.error || "Failed to invite user");
        
        alert("User invited successfully!");
        closeInviteModal();
        fetchUsers();
    } catch (e) {
        errEl.innerText = e.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Send Invite';
    }
}

// Edit Modal
function openEditModal(userId) {
    const user = allUsers.find(u => u.id === userId);
    if (!user) return;
    
    document.getElementById('edit_error').innerText = "";
    document.getElementById('edit_user_id').value = user.id;
    document.getElementById('edit_email').value = user.email;
    document.getElementById('edit_role').value = user.role === 'UNASSIGNED' ? 'SALES' : user.role;
    document.getElementById('edit_status').value = user.is_active ? "true" : "false";
    
    document.getElementById('edit_modal').style.display = 'flex';
}
function closeEditModal() {
    document.getElementById('edit_modal').style.display = 'none';
}
async function submitEdit() {
    const userId = document.getElementById('edit_user_id').value;
    const role = document.getElementById('edit_role').value;
    const is_active = document.getElementById('edit_status').value === "true";
    const btn = document.getElementById('btn_edit_submit');
    const errEl = document.getElementById('edit_error');
    
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    errEl.innerText = "";
    
    try {
        const resRaw = await fetchWithAuth(`/api/users/${userId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ role, is_active })
        });
        
        if (resRaw.status === 401) {
            window.location.href = 'index.html';
            return;
        }
        
        let data;
        try {
            data = await resRaw.json();
        } catch(e) {
            throw new Error("Invalid response from server");
        }
        
        if (resRaw.status === 403) throw new Error(data.error || "Access Denied");
        if (!resRaw.ok) throw new Error(data.error || `Server error: HTTP ${resRaw.status}`);
        if (!data.success) throw new Error(data.error || "Failed to update user");
        
        closeEditModal();
        fetchUsers();
    } catch (e) {
        errEl.innerText = e.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = 'Save Changes';
    }
}

// Password Reset Action
async function resendUserAction(userId, email) {
    if (!confirm(`Send a password reset email to ${email}?`)) return;
    
    try {
        const resRaw = await fetchWithAuth(`/api/users/${userId}/resend`, {
            method: 'POST'
        });
        
        if (resRaw.status === 401) {
            window.location.href = 'index.html';
            return;
        }
        
        let data;
        try {
            data = await resRaw.json();
        } catch(e) {
            throw new Error("Invalid response from server");
        }
        
        if (resRaw.status === 403) throw new Error(data.error || "Access Denied");
        if (!resRaw.ok) throw new Error(data.error || `Server error: HTTP ${resRaw.status}`);
        if (!data.success) throw new Error(data.error || "Failed to process request");
        
        alert(`Password reset email sent to ${email}`);
    } catch (error) {
        console.error("Error sending password reset:", error);
        alert(`Failed to send password reset: ${error.message}`);
    }
}

// Delete User Action
async function confirmDeleteUser(userId, email) {
    if (!confirm(`Are you sure you want to PERMANENTLY delete user ${email}?\n\nThis action cannot be undone. If the user has created any itineraries or records, this deletion will be blocked.`)) {
        return;
    }
    
    try {
        const resRaw = await fetchWithAuth(`/api/users/${userId}`, {
            method: 'DELETE'
        });
        
        if (resRaw.status === 401) {
            window.location.href = 'index.html';
            return;
        }
        
        let data;
        try {
            data = await resRaw.json();
        } catch(e) {
            throw new Error("Invalid response from server");
        }
        
        if (resRaw.status === 403) throw new Error(data.error || "Access Denied");
        if (!resRaw.ok) throw new Error(data.error || `Server error: HTTP ${resRaw.status}`);
        if (!data.success) throw new Error(data.error || "Failed to delete user");
        
        alert(`User ${email} deleted successfully.`);
        fetchUsers();
    } catch (error) {
        console.error("Error deleting user:", error);
        alert(`Deletion Failed:\n\n${error.message}\n\nRecommendation: If deletion is blocked due to business records, please DEACTIVATE the user instead.`);
    }
}
