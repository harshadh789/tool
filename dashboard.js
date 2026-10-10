let allItineraries = [];
let currentTabFilter = 'all';

document.addEventListener("DOMContentLoaded", async () => {
    const isAuth = await initAuth();
    if (!isAuth) {
        window.location.href = 'index.html';
        return;
    }
    
    // Update profile
    try {
        const meRes = await fetchWithAuth('/api/me');
        if (meRes.success && meRes.user) {
            const roleEl = document.getElementById('dash_user_role');
            const emailEl = document.getElementById('dash_user_email');
            const teamNav = document.getElementById('nav_team');
            
            if (roleEl) roleEl.innerText = meRes.user.role;
            if (emailEl) emailEl.innerText = meRes.user.email;
            if (teamNav && meRes.user.role === 'ADMIN') {
                teamNav.style.display = 'block';
            }
        }
    } catch (e) {
        console.error("Failed to load user profile", e);
    }

    fetchData();

    document.getElementById('search_input').addEventListener('input', (e) => {
        renderTable(e.target.value.toLowerCase());
    });
    
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            currentTabFilter = e.target.getAttribute('data-filter');
            renderTable(document.getElementById('search_input').value.toLowerCase());
        });
    });
});

async function fetchData() {
    document.getElementById('table_body').innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading data from Cloud...</td></tr>';

    try {
        const response = await fetchWithAuth('/api/listItineraries');
        if (!response.ok) throw new Error('HTTP error! status: ' + response.status);
        const result = await response.json();

        if (!result.success) throw new Error(result.error || "Failed to load data");

        allItineraries = result.data || [];

        let totalVouchers = 0;
        let totalQuotes = 0;
        let totalGuests = 0;

        allItineraries.forEach(it => {
            if (it.isVoucherMode) { totalVouchers++; } 
            else { totalQuotes++; }
            if (it.adults) { totalGuests += parseInt(it.adults) || 0; }
        });

        document.getElementById('stat_vouchers').innerText = totalVouchers;
        document.getElementById('stat_itineraries').innerText = totalQuotes;
        document.getElementById('stat_guests').innerText = totalGuests;

        renderTable();
    } catch (error) {
        console.error("Error fetching data:", error);
        document.getElementById('table_body').innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">Error loading data: ' + error.message + '</td></tr>';
    }
}

function renderTable(searchTerm = "") {
    const tbody = document.getElementById('table_body');
    tbody.innerHTML = "";

    const filtered = allItineraries.filter(it => {
        const derivedStatus = it.isVoucherMode ? 'Voucher' : (it.status || 'Draft');
        if (currentTabFilter !== 'all' && derivedStatus !== currentTabFilter) return false;
        if (!searchTerm) return true;
        const idMatch = it.id && it.id.toLowerCase().includes(searchTerm);
        const nameMatch = it.guest && it.guest.toLowerCase().includes(searchTerm);
        const destMatch = it.title && it.title.toLowerCase().includes(searchTerm);
        return idMatch || nameMatch || destMatch;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">No records found.</td></tr>';
        return;
    }

    filtered.forEach(it => {
        const isVoucher = it.isVoucherMode;
        let statusClass = 'status-draft';
        let statusText = 'Draft';

        if (isVoucher) {
            statusClass = 'status-voucher';
            statusText = 'Voucher Generated';
        } else if (it.status === 'Requested') {
            statusClass = 'status-requested';
            statusText = 'Pending Ops Request';
        } else if (it.status === 'Draft') {
            statusClass = 'status-draft';
            statusText = 'Draft Quote';
        } else {
            statusClass = 'status-quote';
            statusText = it.status || 'Quote';
        }
        
        const tripDates = (it.start || '?') + ' to ' + (it.end || '?');
        const docId = it.id;
        
        let actions = '';
        if (isVoucher) {
            actions += '<button class="action-btn" title="Edit" onclick="window.open(\'/?edit=' + docId + '\', \'_blank\')"><i class="fa-solid fa-pen"></i></button>';
            actions += '<button class="action-btn" title="View Voucher" onclick="window.open(\'/?voucher=' + docId + '\', \'_blank\')"><i class="fa-solid fa-eye"></i></button>';
            actions += '<button class="action-btn" title="Copy Client Link" onclick="copyToClipboard(\'/?voucher=' + docId + '\')"><i class="fa-solid fa-link"></i></button>';
        } else {
            actions += '<button class="action-btn" title="Edit" onclick="window.open(\'/?edit=' + docId + '\', \'_blank\')"><i class="fa-solid fa-pen"></i></button>';
            actions += '<button class="action-btn" title="View Itinerary" onclick="window.open(\'/?id=' + docId + '\', \'_blank\')"><i class="fa-solid fa-eye"></i></button>';
            actions += '<button class="action-btn" title="Copy Client Link" onclick="copyToClipboard(\'/?id=' + docId + '\')"><i class="fa-solid fa-link"></i></button>';
        }

        const row = '<tr>' +
            '<td><strong>' + (it.id || 'N/A') + '</strong></td>' +
            '<td><div style="font-weight:600;">' + (it.guest || 'N/A') + '</div><div style="font-size:12px; color:var(--text-light);">' + (it.title || 'N/A') + '</div></td>' +
            '<td>' + tripDates + '</td>' +
            '<td>' + (it.duration || 'N/A') + '</td>' +
            '<td><span class="status-badge ' + statusClass + '">' + statusText + '</span></td>' +
            '<td>' + actions + '</td>' +
            '</tr>';
        tbody.insertAdjacentHTML('beforeend', row);
    });
}

function copyToClipboard(path) {
    const fullUrl = window.location.origin + path;
    navigator.clipboard.writeText(fullUrl).then(() => {
        alert("Client link copied to clipboard!");
    }).catch(err => {
        console.error("Could not copy text: ", err);
    });
}
