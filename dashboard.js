const firebaseConfig = {
  apiKey: "AIzaSyDYS-NHTF_6SkzKfCibLqKCv0o902mYkxA",
  authDomain: "tool-59ad5.firebaseapp.com",
  projectId: "tool-59ad5",
  storageBucket: "tool-59ad5.firebasestorage.app",
  messagingSenderId: "983173291653",
  appId: "1:983173291653:web:7c9dbd041fe7792eda93ec",
  measurementId: "G-3FE7DLEF3F"
};

let db;
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
}

let allItineraries = [];

document.addEventListener("DOMContentLoaded", () => {
    fetchData();

    document.getElementById('search_input').addEventListener('input', (e) => {
        renderTable(e.target.value.toLowerCase());
    });
});

async function fetchData() {
    if (!db) {
        alert("Firebase DB not initialized.");
        return;
    }
    
    document.getElementById('table_body').innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 30px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading data from Cloud...</td></tr>`;

    try {
        const snapshot = await db.collection("itineraries").orderBy("timestamp", "desc").get();
        allItineraries = [];
        
        let totalVouchers = 0;
        let totalQuotes = 0;
        let totalGuests = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            data.docId = doc.id;
            allItineraries.push(data);

            if (data.isVoucherMode) {
                totalVouchers++;
            } else {
                totalQuotes++;
            }
            if (data.guests) {
                totalGuests += parseInt(data.guests) || 0;
            }
        });

        document.getElementById('stat_vouchers').innerText = totalVouchers;
        document.getElementById('stat_itineraries').innerText = totalQuotes;
        document.getElementById('stat_guests').innerText = totalGuests;

        renderTable();
    } catch (error) {
        console.error("Error fetching data:", error);
        document.getElementById('table_body').innerHTML = `<tr><td colspan="6" style="text-align:center; color:red;">Error loading data.</td></tr>`;
    }
}

function renderTable(searchTerm = "") {
    const tbody = document.getElementById('table_body');
    tbody.innerHTML = "";

    const filtered = allItineraries.filter(it => {
        if (!searchTerm) return true;
        const idMatch = it.id && it.id.toLowerCase().includes(searchTerm);
        const nameMatch = it.guest && it.guest.toLowerCase().includes(searchTerm);
        const destMatch = it.title && it.title.toLowerCase().includes(searchTerm);
        return idMatch || nameMatch || destMatch;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 20px;">No records found.</td></tr>`;
        return;
    }

    filtered.forEach(it => {
        const isVoucher = it.isVoucherMode;
        const statusClass = isVoucher ? 'status-voucher' : 'status-quote';
        const statusText = isVoucher ? 'Voucher Generated' : 'Quote Proposed';
        
        const tripDates = `${it.start || '?'} to ${it.end || '?'}`;
        
        let actions = ``;
        if (isVoucher) {
            actions += `<button class="action-btn" title="Edit" onclick="window.open('index.html?edit=${it.docId}', '_blank')"><i class="fa-solid fa-pen"></i></button>`;
            actions += `<button class="action-btn" title="View Voucher" onclick="window.open('index.html?voucher=${it.docId}', '_blank')"><i class="fa-solid fa-eye"></i></button>`;
            actions += `<button class="action-btn" title="Copy Client Link" onclick="copyToClipboard('index.html?voucher=${it.docId}')"><i class="fa-solid fa-link"></i></button>`;
        } else {
            actions += `<button class="action-btn" title="Edit" onclick="window.open('index.html?edit=${it.docId}', '_blank')"><i class="fa-solid fa-pen"></i></button>`;
            actions += `<button class="action-btn" title="View Itinerary" onclick="window.open('index.html?id=${it.docId}', '_blank')"><i class="fa-solid fa-eye"></i></button>`;
            actions += `<button class="action-btn" title="Copy Client Link" onclick="copyToClipboard('index.html?id=${it.docId}')"><i class="fa-solid fa-link"></i></button>`;
        }

        const row = `
            <tr>
                <td><strong>${it.id || it.docId}</strong></td>
                <td>
                    <div style="font-weight:600;">${it.guest || 'N/A'}</div>
                    <div style="font-size:12px; color:var(--text-light);">${it.title || 'N/A'}</div>
                </td>
                <td>${tripDates}</td>
                <td>${it.duration || 'N/A'}</td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td>${actions}</td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', row);
    });
}

function copyToClipboard(path) {
    const fullUrl = window.location.origin + window.location.pathname.replace('dashboard.html', '') + path;
    navigator.clipboard.writeText(fullUrl).then(() => {
        alert("Client link copied to clipboard!");
    }).catch(err => {
        console.error("Could not copy text: ", err);
    });
}
