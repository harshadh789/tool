const firebaseConfig = {
  apiKey: "AIzaSyDYS-NHTF_6SkzKfCibLqKCv0o902mYkxA",
  authDomain: "tool-59ad5.firebaseapp.com",
  projectId: "tool-59ad5",
  storageBucket: "tool-59ad5.firebasestorage.app",
  messagingSenderId: "983173291653",
  appId: "1:983173291653:web:7c9dbd041fe7792eda93ec",
  measurementId: "G-3FE7DLEF3F"
};
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
}
const db = typeof firebase !== 'undefined' ? firebase.firestore() : null;


  let dayCount = 0; 
  let hotelCount = 0;
  let updateTimeout = null;

  function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }
  function getNum(id) { const el = document.getElementById(id); return el ? parseFloat(el.value) || 0 : 0; }
  function setText(id, text) { const el = document.getElementById(id); if(el) el.innerText = text; }
  function setHTML(id, html) { const el = document.getElementById(id); if(el) el.innerHTML = html; }
  function setSrc(id, src) { const el = document.getElementById(id); if(el) el.src = src; }

  function toggleAccordion(el) {
    el.nextElementSibling.classList.toggle('active');
    const icon = el.querySelector('i');
    if (icon) {
        icon.className = el.nextElementSibling.classList.contains('active') ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    }
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    toast.innerText = message;
    toast.className = "show";
    setTimeout(() => { toast.className = toast.className.replace("show", ""); }, 3000);
  }

  function copyText(elementId) {
    const textToCopy = document.getElementById(elementId).innerText;
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy).then(() => {
        showToast("Copied to clipboard!");
    }).catch(err => console.error('Failed to copy: ', err));
  }

  function formatDisplayDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  
  function formatCurr(amount) {
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(amount);
  }

  function triggerUpdate() {
    clearTimeout(updateTimeout);
    updateTimeout = setTimeout(() => { updatePreview(); }, 150);
  }

  // --- STRICT ACCESS CONTROL LOCK-WALL & CONFIG LOADER ---
  async function loadSecureConfig() {
    const user = document.getElementById('login_user').value.trim();
    const pass = document.getElementById('login_pass').value.trim();
    const errorEl = document.getElementById('login_error');

    if (!user || !pass) {
      errorEl.innerText = "Please enter both ID and Password.";
      errorEl.style.display = "block";
      return;
    }

    // Set your manual password here!
    const MANUAL_PASSWORD = "123";

    if (pass === MANUAL_PASSWORD) {
        // Hardcoded global configuration since backend is removed
        const config = {
            footerLogo: "https://www.campfly.in/assets/logo-cropped.png",
            bkName: "Campfly Private Limited",
            bkAcc: "0010 0501 5266",
            bkIfsc: "ICIC0000010",
            bkUpi: "campflyprivatelimited.ibz@icici"
        };
        
        document.getElementById('i_footer_logo').value = config.footerLogo;
        document.getElementById('i_bk_name').value = config.bkName;
        document.getElementById('i_bk_acc').value = config.bkAcc;
        document.getElementById('i_bk_ifsc').value = config.bkIfsc;
        document.getElementById('i_bk_upi').value = config.bkUpi;
        
        document.getElementById('auth-overlay').style.opacity = '0';
        setTimeout(() => {
            document.getElementById('auth-overlay').style.display = 'none';
        }, 300);
        triggerUpdate();
        showToast("Access Granted. Welcome, " + user + "!");
    } else {
        errorEl.innerText = "Access Denied: Invalid credentials.";
        errorEl.style.display = "block";
    }
  }

  function handleLogin() {
    loadSecureConfig();
  }

  // --- VOUCHER MODE LOGIC ---
  function toggleVoucherMode() {
    const isVoucher = document.getElementById('i_voucher_mode').checked;
    
    // Editor UI updates
    document.querySelectorAll('.voucher-field').forEach(el => {
        el.style.display = isVoucher ? 'block' : 'none';
    });
    const pricingAccordion = document.getElementById('pricing-accordion');
    if (pricingAccordion) pricingAccordion.style.display = isVoucher ? 'none' : 'block';

    // Preview UI updates
    const titleEl = document.getElementById('o_title');
    if (titleEl) {
        if (isVoucher) {
            titleEl.innerText = "Confirmed Booking Voucher";
        } else {
            const inputTitle = document.getElementById('i_title').value;
            titleEl.innerText = inputTitle ? inputTitle : "Proposed Itinerary";
        }
    }
    
    document.getElementById('o_voucher_transport').style.display = isVoucher ? 'block' : 'none';
    const paymentBox = document.querySelector('.payment-box');
    if (paymentBox) paymentBox.style.display = isVoucher ? 'none' : 'block';
    
    const qrContainer = document.querySelector('.qr-container');
    if (qrContainer) qrContainer.style.display = isVoucher ? 'none' : 'block';
    
    // Hide advance QR too
    const advanceQrContainer = document.getElementById('advance-qr-container');
    if(advanceQrContainer) advanceQrContainer.style.display = isVoucher ? 'none' : (document.getElementById('i_qr_amount_toggle').checked ? 'block' : 'none');
    
    // Aesthetic changes
    const pdfContainer = document.getElementById('pdf-container');
    if (pdfContainer) {
        if (isVoucher) pdfContainer.classList.add('voucher-theme');
        else pdfContainer.classList.remove('voucher-theme');
    }
  }

  // --- SMART FINANCIALS & DATES LOGIC ---
  function calcFinancials() {
    const base = getNum('i_base_cost');
    const discount = getNum('i_discount');
    const gstPct = getNum('i_gst_pct');
    const advance = getNum('i_adv_amount');
    const adults = getNum('i_adults') || 1;
    const isPerPerson = getVal('i_cost_type') === 'Per Person Cost';

    const netCost = base - discount;
    const gstAmount = netCost * (gstPct / 100);
    const subtotal = netCost + gstAmount; 
    
    const grandTotal = isPerPerson ? (subtotal * adults) : subtotal;
    const balance = grandTotal - advance;

    document.getElementById('i_total_cost').value = grandTotal;
    document.getElementById('i_bal_amount').value = balance;
  }

  function calcDuration() {
    const start = getVal('i_start');
    let end = getVal('i_end');
    
    if(start && !end) {
        const d = new Date(start); d.setDate(d.getDate() + 4); 
        end = d.toISOString().split('T')[0]; document.getElementById('i_end').value = end;
    }

    if(start && end) {
      const d1 = new Date(start); const d2 = new Date(end);
      if(d2 > d1) {
          const diffDays = Math.ceil(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24)); 
          document.getElementById('i_duration').value = `${diffDays} Nights / ${diffDays + 1} Days`;
      }
    }
  }

  function syncStartDay() {
      const start = getVal('i_start');
      if(start && document.getElementById('i_d1_date')) {
          document.getElementById('i_d1_date').value = start;
          triggerUpdate();
      }
  }

  function getNextDayDate() {
    if (dayCount === 0) return getVal('i_start');
    const dayBlocks = document.querySelectorAll('.day-input-group');
    if(dayBlocks.length === 0) return getVal('i_start');
    const lastId = dayBlocks[dayBlocks.length - 1].getAttribute('data-id');
    const lastDateVal = getVal(`i_d${lastId}_date`);
    if (!lastDateVal) return '';
    let d = new Date(lastDateVal);
    d.setDate(d.getDate() + 1); 
    return d.toISOString().split('T')[0];
  }

  function generateSubSerial(oldId) {
    const match = oldId.match(/-([A-Z])$/);
    return match ? oldId.replace(/-[A-Z]$/, '-' + String.fromCharCode(match[1].charCodeAt(0) + 1)) : oldId + '-A';
  }

  // --- GLOBAL SETTINGS ---
  function saveGlobals() {
    const globals = {
        repName: getVal('i_rep_name'), repTagline: getVal('i_rep_tagline'), repAvatar: getVal('i_rep_avatar'),
        repPhone: getVal('i_rep_phone'), repEmail: getVal('i_rep_email'), address: getVal('i_address'),
        socWeb: getVal('i_social_web'), socIg: getVal('i_social_ig'), socYt: getVal('i_social_yt')
    };
    localStorage.setItem('campfly_globals', JSON.stringify(globals));
  }

  function loadGlobals() {
    const g = JSON.parse(localStorage.getItem('campfly_globals'));
    if(!g) return;
    const setIfExist = (id, val) => { if(val !== undefined && document.getElementById(id)) document.getElementById(id).value = val; };
    setIfExist('i_rep_name', g.repName); setIfExist('i_rep_tagline', g.repTagline); setIfExist('i_rep_avatar', g.repAvatar);
    setIfExist('i_rep_phone', g.repPhone); setIfExist('i_rep_email', g.repEmail); setIfExist('i_address', g.address);
    setIfExist('i_social_web', g.socWeb); setIfExist('i_social_ig', g.socIg); setIfExist('i_social_yt', g.socYt);
  }

  // --- DYNAMIC HOTEL INJECTION (Updated with B, L, D, BVR, EP) ---
  function addHotel(data = null) {
    hotelCount++; const id = hotelCount;
    const formHtml = `
      <div class="dynamic-box hotel-input-group" id="form-hotel-${id}" data-id="${id}">
        ${id > 1 ? `<button class="remove-btn" onclick="removeHotel(${id})"><i class="fa-solid fa-xmark"></i> Remove</button>` : ''}
        <div class="form-group"><label>Hotel Label</label><input type="text" id="i_h${id}_label" placeholder="Hotel ${id} (City - N Nights)" oninput="triggerUpdate()"></div>
        <div class="form-group"><label>Nights / City</label><input type="text" id="i_h${id}_nights" placeholder="Day X - Day Y : City" oninput="triggerUpdate()"></div>
        <div class="form-group"><label>Hotel Name</label><input type="text" id="i_h${id}_name" placeholder="Resort Name" oninput="triggerUpdate()"></div>
        <div style="display:flex; gap:10px;">
          <div class="form-group" style="flex:1;"><label>Star Rating</label>
            <select id="i_h${id}_star" onchange="triggerUpdate()"><option value="3 star">3 Star</option><option value="4 star" selected>4 Star</option><option value="5 star">5 Star</option></select>
          </div>
          <div class="form-group" style="flex:1;"><label>Room Type</label><input type="text" id="i_h${id}_room" placeholder="Deluxe Room" oninput="triggerUpdate()"></div>
        </div>
        <div class="form-group voucher-field" style="display:none; background:#f0fdf4; padding:8px; border-radius:5px;"><label style="color:#166534;"><i class="fa-solid fa-bed"></i> Booking Conf No (Voucher Only)</label><input type="text" id="i_h${id}_conf" placeholder="e.g. HDFC-12345" oninput="triggerUpdate()"></div>
        <div class="form-group"><label>Meal Plan</label>
          <div style="display:flex; gap:12px; font-size:13px; margin-top:8px; font-weight:500; flex-wrap:wrap;">
            <label><input type="checkbox" id="cb_b_${id}" checked onchange="triggerUpdate()"> B</label>
            <label><input type="checkbox" id="cb_l_${id}" onchange="triggerUpdate()"> L</label>
            <label><input type="checkbox" id="cb_d_${id}" checked onchange="triggerUpdate()"> D</label>
            <label><input type="checkbox" id="cb_bvr_${id}" onchange="triggerUpdate()"> BVR</label>
            <label><input type="checkbox" id="cb_ep_${id}" onchange="triggerUpdate()"> EP</label>
          </div>
        </div>
      </div>
    `;
    document.getElementById('hotels-form-container').insertAdjacentHTML('beforeend', formHtml);

    const previewHtml = `
      <div class="hotel-card" id="preview-hotel-${id}">
        <div class="hotel-label-badge" id="o_h${id}_label"></div>
        <div class="hotel-header">
          <div class="date-box" id="o_h${id}_nights"></div>
          <div class="meal-plan-text">Meal Plan: <span id="o_h${id}_meal"></span></div>
        </div>
        <div>
          <strong class="hotel-name" id="o_h${id}_name"></strong>
          <span class="room-type">Room Type: <span id="o_h${id}_room"></span></span>
          <div id="o_h${id}_conf_container" style="display:none; margin-top:5px; font-size:12px; font-weight:600; color:#166534;">
            <i class="fa-solid fa-check-circle"></i> Conf No: <span id="o_h${id}_conf"></span>
          </div>
        </div>
      </div>
    `;
    document.getElementById('hotels-preview-container').insertAdjacentHTML('beforeend', previewHtml);

    if(data) {
      document.getElementById(`i_h${id}_label`).value = data.label || `Hotel ${id}`;
      document.getElementById(`i_h${id}_nights`).value = data.nights || '';
      document.getElementById(`i_h${id}_name`).value = data.name || '';
      document.getElementById(`i_h${id}_star`).value = data.star || '4 star';
      document.getElementById(`i_h${id}_room`).value = data.room || '';
      if(document.getElementById(`i_h${id}_conf`)) document.getElementById(`i_h${id}_conf`).value = data.conf || '';
      if(data.meals) {
          document.getElementById(`cb_b_${id}`).checked = data.meals.b;
          document.getElementById(`cb_l_${id}`).checked = data.meals.l;
          document.getElementById(`cb_d_${id}`).checked = data.meals.d;
          document.getElementById(`cb_bvr_${id}`).checked = data.meals.bvr;
          document.getElementById(`cb_ep_${id}`).checked = data.meals.ep;
      }
    } else if (id === 1) {
      document.getElementById(`i_h1_label`).value = 'Hotel 1 (Ubud - 3 Nights)';
      document.getElementById(`i_h1_nights`).value = 'Day 1 - Day 4 : Ubud';
      document.getElementById(`i_h1_name`).value = 'Kuwarasan A Pramana Experience';
      document.getElementById(`i_h1_star`).value = '5 star';
      document.getElementById(`i_h1_room`).value = 'Suite Pool View';
    }
    triggerUpdate();
  }

  function removeHotel(id) {
    document.getElementById(`form-hotel-${id}`).remove();
    document.getElementById(`preview-hotel-${id}`).remove();
    triggerUpdate();
  }

  function addDay(dayData = null) {
    const defaultDate = dayData ? dayData.date : getNextDayDate();
    dayCount++; const id = dayCount;
    const formHtml = `
      <div class="dynamic-box day-input-group" id="form-day-${id}" data-id="${id}">
        ${id > 1 ? `<button class="remove-btn" onclick="removeDay(${id})"><i class="fa-solid fa-xmark"></i> Remove</button>` : ''}
        <h4 style="margin:0 0 10px 0; color:var(--theme-color);">Day ${id}</h4>
        <div class="form-group"><label>Image URL</label><input type="text" id="i_d${id}_img" oninput="triggerUpdate()"></div>
        <div class="form-group"><label>Day Title</label><input type="text" id="i_d${id}_title" oninput="triggerUpdate()"></div>
        <div class="form-group"><label>Date for this Day</label><input type="date" id="i_d${id}_date" value="${defaultDate}" oninput="triggerUpdate()"></div>
        <div class="form-group"><label>Description</label><textarea id="i_d${id}_desc" rows="3" oninput="triggerUpdate()"></textarea></div>
      </div>
    `;
    document.getElementById('days-form-container').insertAdjacentHTML('beforeend', formHtml);

    const previewHtml = `
      <div class="itinerary-day" id="preview-day-${id}">
        <img class="itinerary-img" id="o_d${id}_img" src="" alt="Day Image" onerror="this.style.display='none'">
        <div class="itinerary-content">
          <h4>Day ${id} | <span id="o_d${id}_title"></span></h4>
          <div class="date" id="o_d${id}_date"></div>
          <p id="o_d${id}_desc"></p>
        </div>
      </div>
    `;
    document.getElementById('itinerary-preview-container').insertAdjacentHTML('beforeend', previewHtml);

    if(dayData) {
      document.getElementById(`i_d${id}_img`).value = dayData.img || '';
      document.getElementById(`i_d${id}_title`).value = dayData.title || '';
      document.getElementById(`i_d${id}_desc`).value = dayData.desc || '';
    } else if (id === 1) {
      document.getElementById(`i_d1_img`).value = 'https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&q=80&w=300';
      document.getElementById(`i_d1_title`).value = 'Arrival at Bali & Transfer to Ubud';
      document.getElementById(`i_d1_desc`).value = 'Welcome to the Island of the Gods! Upon arrival at Ngurah Rai International Airport, your private chauffeur will greet you and transfer you to your luxury resort.';
    }
    triggerUpdate();
  }

  function removeDay(id) {
    document.getElementById(`form-day-${id}`).remove();
    document.getElementById(`preview-day-${id}`).remove();
    triggerUpdate();
  }

  // --- LIVE PREVIEW ---
  function updatePreview() {
    try {
        document.getElementById('o_hero_banner').style.backgroundImage = `url('${getVal('i_hero_img')}')`;

        const quoteId = getVal('i_quote') || 'DRAFT';
        setText('o_quote', quoteId);
        const oQrElement = document.getElementById('o_qr');
        if (oQrElement) {
            oQrElement.innerHTML = '';
            new QRCode(oQrElement, {
                text: quoteId,
                width: 90,
                height: 90,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.H
            });
        }

        const isVoucher = document.getElementById('i_voucher_mode').checked;
        setText('o_title', isVoucher ? "Confirmed Booking Voucher" : getVal('i_title'));
        
        if (isVoucher) {
            setText('o_voucher_flights', getVal('i_flights'));
            setText('o_cab_details', getVal('i_cab_details'));
            setText('o_driver_name', getVal('i_driver_name'));
            setText('o_driver_phone', getVal('i_driver_phone'));
            setText('o_pickup_inst', getVal('i_pickup_inst'));
        }

        setText('o_duration', getVal('i_duration'));
        setText('o_duration_2', getVal('i_duration').split(' / ')[0]);
        
        setText('o_guest', getVal('i_guest'));
        setText('o_guest_2', getVal('i_guest'));
        
        const adults = getNum('i_adults') || 1;
        setText('o_adults', adults);
        
        setText('o_top_right_date', "Generated: " + getVal('i_gen_date'));
        setText('o_valid_date', getVal('i_valid_date'));
        setText('o_start', formatDisplayDate(getVal('i_start')));
        setText('o_end', formatDisplayDate(getVal('i_end')));
        
        const curr = getVal('i_currency');
        const costType = getVal('i_cost_type');
        const isPerPerson = costType === 'Per Person Cost';
        
        setText('o_cost_label', costType);
        
        const base = getNum('i_base_cost');
        const disc = getNum('i_discount');
        const gstPct = getNum('i_gst_pct');
        const netCost = base - disc;
        const gstVal = netCost * (gstPct / 100);
        const subtotal = netCost + gstVal;
        const grandTotal = getNum('i_total_cost'); 
        
        const displayUnitCost = isPerPerson ? subtotal : grandTotal;
        setText('o_cost_big', formatCurr(displayUnitCost) + "/-");
        setText('o_currency', curr);

        setText('o_f_base', curr + " " + formatCurr(base) + "/-");
        
        document.getElementById('tr_f_disc').style.display = disc > 0 ? 'table-row' : 'none';
        setText('o_f_disc', "- " + curr + " " + formatCurr(disc) + "/-");
        
        document.getElementById('tr_f_gst').style.display = gstPct > 0 ? 'table-row' : 'none';
        setText('o_f_gst', "+ " + curr + " " + formatCurr(gstVal) + "/-");
        
        if (isPerPerson && adults > 1) {
            document.getElementById('tr_f_subtotal').style.display = 'table-row';
            setText('o_f_subtotal', curr + " " + formatCurr(subtotal) + "/-");
            setText('o_f_adults_lbl', `(for ${adults} Adults)`);
        } else {
            document.getElementById('tr_f_subtotal').style.display = 'none';
            setText('o_f_adults_lbl', '');
        }
        
        setText('o_f_total', curr + " " + formatCurr(grandTotal) + "/-");

        setText('o_f_adv', curr + " " + formatCurr(getNum('i_adv_amount')) + "/-");
        setText('o_f_adv_date', getVal('i_adv_date') ? `(Due: ${formatDisplayDate(getVal('i_adv_date'))})` : '');
        setText('o_f_bal', curr + " " + formatCurr(getNum('i_bal_amount')) + "/-");
        setText('o_f_bal_date', getVal('i_bal_date') ? `(Due: ${formatDisplayDate(getVal('i_bal_date'))})` : '');

        setText('o_rep_name', getVal('i_rep_name'));
        setText('o_rep_tagline', getVal('i_rep_tagline'));
        setText('o_rep_phone', getVal('i_rep_phone'));
        setText('o_rep_email', getVal('i_rep_email'));
        
        const avatarUrl = getVal('i_rep_avatar');
        const imgEl = document.getElementById('o_rep_avatar');
        const svgEl = document.getElementById('o_rep_icon');
        if(avatarUrl && avatarUrl.trim() !== '') {
            imgEl.src = avatarUrl; imgEl.style.display = 'block'; svgEl.style.display = 'none';
        } else {
            imgEl.style.display = 'none'; svgEl.style.display = 'block';
        }
        
        const addr = getVal('i_address');
        document.querySelectorAll('.o_address_foot').forEach(el => el.innerText = addr);
        setText('ot_social_web', getVal('i_social_web'));
        setText('ot_social_ig', getVal('i_social_ig'));
        setText('ot_social_yt', getVal('i_social_yt'));
        
        const footLogoUrl = getVal('i_footer_logo');
        const footLogoEl = document.getElementById('o_footer_logo');
        if (footLogoUrl && footLogoUrl.trim() !== '') {
            footLogoEl.src = footLogoUrl;
            footLogoEl.style.display = 'block';
        } else {
            footLogoEl.style.display = 'none';
        }
        
        // Sync Hotels & 5 Meal Plans
        document.querySelectorAll('.hotel-input-group').forEach(block => {
            const id = block.getAttribute('data-id');
            const labelEl = document.getElementById(`o_h${id}_label`);
            if(labelEl) {
                const lblText = getVal(`i_h${id}_label`);
                labelEl.innerText = lblText;
                labelEl.style.display = lblText ? 'inline-block' : 'none';
            }
            
            setText(`o_h${id}_nights`, getVal(`i_h${id}_nights`));
            const star = getVal(`i_h${id}_star`);
            const starCap = star ? star.charAt(0).toUpperCase() + star.slice(1) : '';
            setText(`o_h${id}_name`, getVal(`i_h${id}_name`) + (starCap ? ` (${starCap})` : ''));
            setText(`o_h${id}_room`, getVal(`i_h${id}_room`));
            
            const isVoucher = document.getElementById('i_voucher_mode').checked;
            const confContainer = document.getElementById(`o_h${id}_conf_container`);
            const confVal = getVal(`i_h${id}_conf`);
            if(confContainer) {
                if(isVoucher && confVal) {
                    confContainer.style.display = 'block';
                    setText(`o_h${id}_conf`, confVal);
                } else {
                    confContainer.style.display = 'none';
                }
            }
            
            let meals = [];
            if(document.getElementById(`cb_b_${id}`) && document.getElementById(`cb_b_${id}`).checked) meals.push("B");
            if(document.getElementById(`cb_l_${id}`) && document.getElementById(`cb_l_${id}`).checked) meals.push("L");
            if(document.getElementById(`cb_d_${id}`) && document.getElementById(`cb_d_${id}`).checked) meals.push("D");
            if(document.getElementById(`cb_bvr_${id}`) && document.getElementById(`cb_bvr_${id}`).checked) meals.push("BVR");
            if(document.getElementById(`cb_ep_${id}`) && document.getElementById(`cb_ep_${id}`).checked) meals.push("EP");
            setText(`o_h${id}_meal`, meals.length > 0 ? meals.join(" + ") : "None");
        });

        document.querySelectorAll('.day-input-group').forEach(block => {
            const id = block.getAttribute('data-id');
            setText(`o_d${id}_title`, getVal(`i_d${id}_title`));
            setText(`o_d${id}_date`, formatDisplayDate(getVal(`i_d${id}_date`)));
            setText(`o_d${id}_desc`, getVal(`i_d${id}_desc`));
            const imgUrl = getVal(`i_d${id}_img`);
            const imgDisplay = document.getElementById(`o_d${id}_img`);
            if (imgDisplay) {
                if (imgUrl) { imgDisplay.src = imgUrl; imgDisplay.style.display = 'block'; }
                else { imgDisplay.style.display = 'none'; }
            }
        });

        const bkName = getVal('i_bk_name');
        const upi = getVal('i_bk_upi');
        setText('o_bk_name', bkName);
        setText('o_bk_acc', getVal('i_bk_acc'));
        setText('o_bk_ifsc', getVal('i_bk_ifsc'));
        setText('o_bk_upi', upi);
        
        let upiString = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(bkName)}&tn=${encodeURIComponent("Quote " + quoteId + " - " + getVal('i_guest'))}`;
        if (document.getElementById('i_qr_amount_toggle').checked) {
            upiString += `&am=${encodeURIComponent(getNum('i_adv_amount'))}`;
        }
        const oBkQrElement = document.getElementById('o_bk_qr');
        if (oBkQrElement) {
            oBkQrElement.innerHTML = '';
            new QRCode(oBkQrElement, {
                text: upiString,
                width: 130,
                height: 130,
                colorDark : "#000000",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.H
            });
        }

        const processLines = (inId, outId) => {
          const content = getVal(inId).split('\n').filter(l => l.trim()).map(l => `<li>${l}</li>`).join('');
          setHTML(outId, content);
        };
        processLines('i_inc', 'o_inc_list');
        processLines('i_exc', 'o_exc_list');
        processLines('i_terms', 'o_terms_list');
    } catch(e) {
        console.error("Preview update error:", e);
    }
  }

  function generatePDF() {
    const element = document.getElementById('pdf-container');
    const quoteId = (getVal('i_quote') || 'Draft').trim();
    
    const pxToMm = 210 / element.offsetWidth;
    const exactHeight = Math.ceil((element.offsetHeight * pxToMm) + 2); 
    const finalFilename = `Campfly_Itinerary_${quoteId}.pdf`;
    
    html2pdf().set({
      margin: 0,
      image: { type: 'jpeg', quality: 0.8 }, 
      html2canvas: { scale: 1.5, useCORS: true, logging: false }, 
      jsPDF: { unit: 'mm', format: [210, exactHeight], orientation: 'portrait' }
    }).from(element).outputPdf('blob').then(function(pdfBlob) {
        const blobUrl = URL.createObjectURL(pdfBlob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = finalFilename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        }, 500);
    }).catch(function(err) {
        console.error("PDF generation error:", err);
        alert("Failed to generate PDF. Please try again.");
    });
  }

  function getSavedItineraries() {
    return JSON.parse(localStorage.getItem('campfly_pro_v8')) || [];
  }

  function getItineraryData(quoteId) {
    const itinerary = {
      id: quoteId,
      genDate: getVal('i_gen_date'), validDate: getVal('i_valid_date'),
      repName: getVal('i_rep_name'), repTagline: getVal('i_rep_tagline'), repAvatar: getVal('i_rep_avatar'),
      repPhone: getVal('i_rep_phone'), repEmail: getVal('i_rep_email'), address: getVal('i_address'),
      socWeb: getVal('i_social_web'), socIg: getVal('i_social_ig'), socYt: getVal('i_social_yt'),
      guest: getVal('i_guest'), adults: getVal('i_adults'), heroImg: getVal('i_hero_img'),
      title: getVal('i_title'), duration: getVal('i_duration'), start: getVal('i_start'), end: getVal('i_end'),
      
      currency: getVal('i_currency'), costType: getVal('i_cost_type'), 
      baseCost: getVal('i_base_cost'), discount: getVal('i_discount'), gstPct: getVal('i_gst_pct'),
      advAmount: getVal('i_adv_amount'), advDate: getVal('i_adv_date'), balDate: getVal('i_bal_date'),
      qrToggle: document.getElementById('i_qr_amount_toggle').checked,
      
      // Voucher specific
      isVoucherMode: document.getElementById('i_voucher_mode').checked,
      flights: getVal('i_flights'), cabDetails: getVal('i_cab_details'),
      driverName: getVal('i_driver_name'), driverPhone: getVal('i_driver_phone'), pickupInst: getVal('i_pickup_inst'),

      inc: getVal('i_inc'), exc: getVal('i_exc'), terms: getVal('i_terms'),
      hotels: [], days: [], timestamp: Date.now()
    };

    document.querySelectorAll('.hotel-input-group').forEach(block => {
        const id = block.getAttribute('data-id');
        itinerary.hotels.push({
            label: getVal(`i_h${id}_label`), nights: getVal(`i_h${id}_nights`), name: getVal(`i_h${id}_name`),
            star: getVal(`i_h${id}_star`), room: getVal(`i_h${id}_room`), conf: getVal(`i_h${id}_conf`),
            meals: {
                b: document.getElementById(`cb_b_${id}`) ? document.getElementById(`cb_b_${id}`).checked : false,
                l: document.getElementById(`cb_l_${id}`) ? document.getElementById(`cb_l_${id}`).checked : false,
                d: document.getElementById(`cb_d_${id}`) ? document.getElementById(`cb_d_${id}`).checked : false,
                bvr: document.getElementById(`cb_bvr_${id}`) ? document.getElementById(`cb_bvr_${id}`).checked : false,
                ep: document.getElementById(`cb_ep_${id}`) ? document.getElementById(`cb_ep_${id}`).checked : false
            }
        });
    });

    document.querySelectorAll('.day-input-group').forEach(block => {
        const id = block.getAttribute('data-id');
        itinerary.days.push({
            img: getVal(`i_d${id}_img`), title: getVal(`i_d${id}_title`),
            date: getVal(`i_d${id}_date`), desc: getVal(`i_d${id}_desc`)
        });
    });

    return itinerary;
  }

  async function saveToCloud() {
    const btn = document.getElementById('btn_save_cloud');
    if (!btn) return;
    const ogText = btn.innerHTML;
    
    const quoteId = getVal('i_quote').trim();
    if (!quoteId) {
       alert("Please enter a Quotation Number.");
       return;
    }

    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    btn.disabled = true;
    saveGlobals(); 

    const itinerary = getItineraryData(quoteId);

    try {
        if (!db) throw new Error("Firebase DB not initialized.");
        await db.collection("itineraries").doc(quoteId).set(itinerary);
        let link = window.location.origin + window.location.pathname + "?id=" + quoteId;
        if(itinerary.isVoucherMode) {
            link = window.location.origin + window.location.pathname + "?voucher=" + quoteId;
        }
        
        navigator.clipboard.writeText(link).then(() => {
            alert("Success! Data saved to cloud.\\n\\nShareable Link copied to clipboard:\\n" + link);
        }).catch(err => {
            alert("Success! Link: " + link);
        });
    } catch (e) {
        console.error("Error saving to cloud: ", e);
        alert("Error saving to cloud. See console.");
    } finally {
        btn.innerHTML = ogText;
        btn.disabled = false;
    }
  }

  function saveItinerary() {
    const quoteId = getVal('i_quote').trim();
    if (!quoteId) return alert("Please enter a Quotation Number.");

    saveGlobals(); 

    const itinerary = getItineraryData(quoteId);

    let savedList = getSavedItineraries();
    const existingIndex = savedList.findIndex(item => item.id === quoteId);
    if(existingIndex >= 0) savedList[existingIndex] = itinerary;
    else savedList.push(itinerary);

    localStorage.setItem('campfly_pro_v8', JSON.stringify(savedList));
    showToast("Itinerary Saved Successfully!");
    renderHistory();
  }

  function loadItinerary(quoteId, isDuplicate = false) {
    const data = getSavedItineraries().find(item => item.id === quoteId);
    if(!data) return;

    let targetId = data.id;
    if(isDuplicate) {
        targetId = generateSubSerial(data.id);
        document.getElementById('i_quote').value = targetId;
        
        const today = new Date(); const valid = new Date(today); valid.setDate(valid.getDate() + 15);
        document.getElementById('i_gen_date').value = today.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        document.getElementById('i_valid_date').value = valid.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } else {
        document.getElementById('i_quote').value = targetId;
        document.getElementById('i_gen_date').value = data.genDate || '';
        document.getElementById('i_valid_date').value = data.validDate || '';
    }

    const setIfExist = (id, val) => { if(val !== undefined && document.getElementById(id)) document.getElementById(id).value = val; };
    
    setIfExist('i_rep_name', data.repName); setIfExist('i_rep_tagline', data.repTagline); setIfExist('i_rep_avatar', data.repAvatar);
    setIfExist('i_rep_phone', data.repPhone); setIfExist('i_rep_email', data.repEmail); setIfExist('i_address', data.address);
    setIfExist('i_social_web', data.socWeb); setIfExist('i_social_ig', data.socIg); setIfExist('i_social_yt', data.socYt);

    setIfExist('i_guest', data.guest); setIfExist('i_adults', data.adults); setIfExist('i_hero_img', data.heroImg);
    setIfExist('i_title', data.title); setIfExist('i_duration', data.duration); setIfExist('i_start', data.start); setIfExist('i_end', data.end);
    
    setIfExist('i_currency', data.currency); setIfExist('i_cost_type', data.costType);
    setIfExist('i_base_cost', data.baseCost); setIfExist('i_discount', data.discount); setIfExist('i_gst_pct', data.gstPct);
    setIfExist('i_adv_amount', data.advAmount); setIfExist('i_adv_date', data.advDate); setIfExist('i_bal_date', data.balDate);
    if(data.qrToggle !== undefined && document.getElementById('i_qr_amount_toggle')) document.getElementById('i_qr_amount_toggle').checked = data.qrToggle;
    
    setIfExist('i_inc', data.inc); setIfExist('i_exc', data.exc); setIfExist('i_terms', data.terms);

    // Voucher specifics
    if(data.isVoucherMode !== undefined && document.getElementById('i_voucher_mode')) document.getElementById('i_voucher_mode').checked = data.isVoucherMode;
    setIfExist('i_flights', data.flights); setIfExist('i_cab_details', data.cabDetails);
    setIfExist('i_driver_name', data.driverName); setIfExist('i_driver_phone', data.driverPhone); setIfExist('i_pickup_inst', data.pickupInst);
    
    toggleVoucherMode();

    document.getElementById('hotels-form-container').innerHTML = '';
    document.getElementById('hotels-preview-container').innerHTML = '';
    hotelCount = 0;
    if(data.hotels && data.hotels.length > 0) data.hotels.forEach(h => addHotel(h)); else addHotel();

    document.getElementById('days-form-container').innerHTML = '';
    document.getElementById('itinerary-preview-container').innerHTML = '';
    dayCount = 0;
    if(data.days && data.days.length > 0) data.days.forEach(d => addDay(d)); else addDay();

    calcFinancials();
    triggerUpdate();
    
    if(isDuplicate) showToast(`Copied! Sub-serial ID: ${targetId} generated.`);
    else showToast("Loaded Itinerary: " + quoteId);
  }

  function deleteItinerary(quoteId) {
    if(confirm(`Delete quotation ${quoteId}?`)) {
        let savedList = getSavedItineraries().filter(item => item.id !== quoteId);
        localStorage.setItem('campfly_pro_v8', JSON.stringify(savedList));
        renderHistory();
        showToast("Deleted Successfully!");
    }
  }

  function renderHistory() {
    const savedList = getSavedItineraries();
    const container = document.getElementById('history-list');
    container.innerHTML = '';
    if(savedList.length === 0) {
        container.innerHTML = `<p style="font-size: 13px; color: #999;">No saved itineraries.</p>`;
        return;
    }
    [...savedList].reverse().forEach(item => {
        const div = document.createElement('div'); div.className = 'history-item';
        div.innerHTML = `
            <div class="history-item-details">
                <strong>${item.id} - ${item.guest}</strong>
                <span>${item.title}</span>
            </div>
            <div class="history-actions">
                <button class="btn-load" onclick="loadItinerary('${item.id}')" title="Load"><i class="fa-solid fa-folder-open"></i></button>
                <button class="btn-dup" onclick="loadItinerary('${item.id}', true)" title="Duplicate"><i class="fa-solid fa-copy"></i></button>
                <button class="btn-delete" onclick="deleteItinerary('${item.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        `;
        container.appendChild(div);
    });
  }

  async function init() {
    loadGlobals();

    let itins = getSavedItineraries();
    if(itins.length === 0) {
        document.getElementById('i_quote').value = `CMP-2026-001`;
    } else {
        document.getElementById('i_quote').value = `CMP-2026-${String(itins.length + 1).padStart(3, '0')}`;
    }

    const today = new Date(); // Dynamic live current date
    const valid = new Date(today); valid.setDate(valid.getDate() + 15); 
    
    document.getElementById('i_gen_date').value = today.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    document.getElementById('i_valid_date').value = valid.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    
    const dStart = new Date(today); dStart.setDate(dStart.getDate() + 1);
    document.getElementById('i_start').value = dStart.toISOString().split('T')[0];
    const dEnd = new Date(dStart); dEnd.setDate(dEnd.getDate() + 4);
    document.getElementById('i_end').value = dEnd.toISOString().split('T')[0];
    
    calcDuration(); calcFinancials();
    addHotel(); addDay(); renderHistory();
  }

  function loadItineraryFromData(data) {
    if(!data) return;
    
    document.getElementById('i_quote').value = data.id || '';
    document.getElementById('i_gen_date').value = data.genDate || '';
    document.getElementById('i_valid_date').value = data.validDate || '';

    const setIfExist = (id, val) => { if(val !== undefined && document.getElementById(id)) document.getElementById(id).value = val; };
    
    setIfExist('i_rep_name', data.repName); setIfExist('i_rep_tagline', data.repTagline); setIfExist('i_rep_avatar', data.repAvatar);
    setIfExist('i_rep_phone', data.repPhone); setIfExist('i_rep_email', data.repEmail); setIfExist('i_address', data.address);
    setIfExist('i_social_web', data.socWeb); setIfExist('i_social_ig', data.socIg); setIfExist('i_social_yt', data.socYt);

    setIfExist('i_guest', data.guest); setIfExist('i_adults', data.adults); setIfExist('i_hero_img', data.heroImg);
    setIfExist('i_title', data.title); setIfExist('i_duration', data.duration); setIfExist('i_start', data.start); setIfExist('i_end', data.end);
    
    setIfExist('i_currency', data.currency); setIfExist('i_cost_type', data.costType);
    setIfExist('i_base_cost', data.baseCost); setIfExist('i_discount', data.discount); setIfExist('i_gst_pct', data.gstPct);
    setIfExist('i_adv_amount', data.advAmount); setIfExist('i_adv_date', data.advDate); setIfExist('i_bal_date', data.balDate);
    if(data.qrToggle !== undefined && document.getElementById('i_qr_amount_toggle')) document.getElementById('i_qr_amount_toggle').checked = data.qrToggle;
    
    setIfExist('i_inc', data.inc); setIfExist('i_exc', data.exc); setIfExist('i_terms', data.terms);

    // Voucher specifics
    if(data.isVoucherMode !== undefined && document.getElementById('i_voucher_mode')) document.getElementById('i_voucher_mode').checked = data.isVoucherMode;
    setIfExist('i_flights', data.flights); setIfExist('i_cab_details', data.cabDetails);
    setIfExist('i_driver_name', data.driverName); setIfExist('i_driver_phone', data.driverPhone); setIfExist('i_pickup_inst', data.pickupInst);
    
    toggleVoucherMode();

    document.getElementById('hotels-form-container').innerHTML = '';
    document.getElementById('hotels-preview-container').innerHTML = '';
    hotelCount = 0;
    if(data.hotels && data.hotels.length > 0) data.hotels.forEach(h => addHotel(h)); else addHotel();

    document.getElementById('days-form-container').innerHTML = '';
    document.getElementById('itinerary-preview-container').innerHTML = '';
    dayCount = 0;
    if(data.days && data.days.length > 0) data.days.forEach(d => addDay(d)); else addDay();

    calcFinancials();
    triggerUpdate();
  }

  async function boot() {
    const urlParams = new URLSearchParams(window.location.search);
    const cloudId = urlParams.get('id');
    const voucherId = urlParams.get('voucher');
    const editId = urlParams.get('edit');
    const activeId = cloudId || voucherId || editId;

    if (activeId) {
        if (!editId) {
            // Client Mode (Read Only)
            document.body.classList.add('client-view');
            document.getElementById('auth-overlay').style.display = 'none';
        } else {
            // Edit Mode (Load into editor)
            init(); // still initialize local draft so we can overwrite it
        }

        const loader = document.getElementById('loader-overlay');
        if(loader) loader.style.display = 'flex';

        try {
            if(!db) throw new Error("Firebase DB not initialized.");
            const docRef = await db.collection("itineraries").doc(activeId).get();
            if (docRef.exists) {
                const data = docRef.data();
                if (voucherId) {
                    data.isVoucherMode = true; // force voucher mode for ?voucher param
                }
                loadItineraryFromData(data);
            } else {
                alert("Itinerary not found or link has expired.");
            }
        } catch (e) {
            console.error("Error fetching from cloud:", e);
            alert("Error loading itinerary from cloud.");
        } finally {
            if(loader) loader.style.display = 'none';
        }
    } else {
        // Normal Agent Mode (Load draft)
        init();
    }
  }

  boot();
