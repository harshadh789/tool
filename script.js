
  let dayCount = 0; 
  let hotelCount = 0;
  let updateTimeout = null;
  let autoSaveTimeout = null;
  let isBooting = false;
  let currentStatus = 'Draft';
  let currentRecordVersion = null;

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
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
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

    if (!isBooting) {
        clearTimeout(autoSaveTimeout);
        autoSaveTimeout = setTimeout(() => { saveToCloud('auto'); }, 2000);
    }
  }

  // --- CONFIG LOADER ---
  function loadGlobals() {
      // Hardcoded global configuration since backend is removed
      const config = {
          footerLogo: "https://www.campfly.in/assets/logo-cropped.png",
          bkName: "CAMPFLY TOURS LLP",
          bkAcc: "10292311723",
          bkIfsc: "IDFB0080511",
          bkUpi: "campfly@idfcbank"
      };
      
      const elFooterLogo = document.getElementById('i_footer_logo');
      if (elFooterLogo) elFooterLogo.value = config.footerLogo;
      const elBkName = document.getElementById('i_bk_name');
      if (elBkName) elBkName.value = config.bkName;
      const elBkAcc = document.getElementById('i_bk_acc');
      if (elBkAcc) elBkAcc.value = config.bkAcc;
      const elBkIfsc = document.getElementById('i_bk_ifsc');
      if (elBkIfsc) elBkIfsc.value = config.bkIfsc;
      const elBkUpi = document.getElementById('i_bk_upi');
      if (elBkUpi) elBkUpi.value = config.bkUpi;
      
      triggerUpdate();
  }

  window.onLoginSuccess = function() {
      loadGlobals();
      // If we were blocked waiting for auth in boot, resume boot
      if (!isBooting && document.getElementById('i_quote').value === "") {
          boot();
      }
  };


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
    const startStr = getVal('i_start');
    let endStr = getVal('i_end');
    
    if(startStr && !endStr) {
        const parts = startStr.split('-');
        const d1 = new Date(parts[0], parts[1] - 1, parts[2]);
        d1.setDate(d1.getDate() + 4); 
        const ey = d1.getFullYear();
        const em = String(d1.getMonth() + 1).padStart(2, '0');
        const ed = String(d1.getDate()).padStart(2, '0');
        endStr = `${ey}-${em}-${ed}`;
        document.getElementById('i_end').value = endStr;
    }

    if(startStr && endStr) {
      const p1 = startStr.split('-');
      const p2 = endStr.split('-');
      const utc1 = Date.UTC(p1[0], p1[1] - 1, p1[2]);
      const utc2 = Date.UTC(p2[0], p2[1] - 1, p2[2]);
      
      if(utc2 >= utc1) {
          const diffDays = Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24)); 
          document.getElementById('i_duration').value = `${diffDays} Nights / ${diffDays + 1} Days`;
          
          // Auto-sync all itinerary dates sequentially from Start Date
          const dayBlocks = document.querySelectorAll('.day-input-group');
          dayBlocks.forEach((block, index) => {
              const id = block.getAttribute('data-id');
              const dateInput = document.getElementById(`i_d${id}_date`);
              if (dateInput) {
                  const dayDate = new Date(p1[0], p1[1] - 1, p1[2]);
                  dayDate.setDate(dayDate.getDate() + index);
                  const dy = dayDate.getFullYear();
                  const dm = String(dayDate.getMonth() + 1).padStart(2, '0');
                  const dd = String(dayDate.getDate()).padStart(2, '0');
                  dateInput.value = `${dy}-${dm}-${dd}`;
              }
          });
      }
    }
  }

  function syncStartDay() {
      // Delegated to calcDuration to auto-sync all days
  }

  function getNextDayDate() {
    const startStr = getVal('i_start');
    if (!startStr) return '';
    const dayBlocks = document.querySelectorAll('.day-input-group');
    const index = dayBlocks.length; 
    const p = startStr.split('-');
    const dayDate = new Date(p[0], p[1] - 1, p[2]);
    dayDate.setDate(dayDate.getDate() + index);
    const dy = dayDate.getFullYear();
    const dm = String(dayDate.getMonth() + 1).padStart(2, '0');
    const dd = String(dayDate.getDate()).padStart(2, '0');
    return `${dy}-${dm}-${dd}`;
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
            <select id="i_h${id}_star" onchange="triggerUpdate()"><option value=""></option><option value="1 star">1 Star</option><option value="2 star">2 Star</option><option value="3 star">3 Star</option><option value="4 star">4 Star</option><option value="5 star">5 Star</option><option value="homestay">Homestay</option><option value="villa">Villa</option></select>
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
      document.getElementById(`i_h${id}_star`).value = data.star || '';
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
      document.getElementById(`i_h1_star`).value = '';
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
      hotels: [], days: [], documents: uploadedDocuments, timestamp: Date.now(), status: currentStatus
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

  async function saveToCloud(isSilent = false) {
    const btn = document.getElementById('btn_save_cloud');
    if (!btn && !isSilent) return;
    const ogText = btn ? btn.innerHTML : '';
    
    const quoteId = getVal('i_quote').trim();
    if (!quoteId) {
       if(!isSilent) alert("Please enter a Quotation Number.");
       return;
    }

    if(btn && !isSilent) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
    }
    saveGlobals(); 

    const itinerary = getItineraryData(quoteId);

    if (window.Validation) {
        const valRes = window.Validation.validateItinerary(itinerary);
        if (!valRes.isValid) {
            if (!isSilent) alert("Validation Errors:\n" + valRes.errors.join("\n"));
            if (btn && !isSilent) {
                btn.innerHTML = ogText;
                btn.disabled = false;
            }
            return;
        }
        if (valRes.warnings.length > 0 && !isSilent) {
            const proceed = confirm("There are missing fields, but you can save as Draft. Proceed?\n\nWarnings:\n" + valRes.warnings.join("\n"));
            if (!proceed) {
                if (btn && !isSilent) {
                    btn.innerHTML = ogText;
                    btn.disabled = false;
                }
                return;
            }
        }
    }

    try {
        const response = await fetchWithAuth('/api/saveItinerary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itinerary, version: currentRecordVersion })
        });

        const data = await response.json();
        if (data.version) {
            currentRecordVersion = data.version;
        }
        if (!data.success) throw new Error(data.error || "Failed to save to backend.");
        
        if (isSilent) {
            if (isSilent !== 'auto') showToast("Draft Saved to Cloud!");
            return; // Skip alerts and link generation for silent saves
        }

        if (currentStatus === 'Requested') {
            showToast("✅ Sent to Ops Team!");
        }

        let link = window.location.origin + window.location.pathname + "?id=" + quoteId;
        if(itinerary.isVoucherMode) {
            link = window.location.origin + window.location.pathname + "?voucher=" + quoteId;
        }
        
        navigator.clipboard.writeText(link).then(() => {
            alert("Success! Data saved to cloud.\n\nShareable Link copied to clipboard:\n" + link);
        }).catch(err => {
            alert("Success! Link: " + link);
        });
    } catch (e) {
      console.error("Error saving to cloud: ", e);
      if(!isSilent) alert("Error saving to cloud: " + (e.message || JSON.stringify(e)));
    } finally {
        if(btn && !isSilent) {
            btn.innerHTML = ogText;
            btn.disabled = false;
        }
    }
  }

  function saveItinerary() {
    // "Save Draft" now performs a silent cloud save
    saveToCloud(true);
  }

  async function requestOps() {
    currentStatus = 'Requested';
    await saveToCloud(false);
  }


  // Local history functions (getSavedItineraries, loadItinerary, deleteItinerary, renderHistory) have been removed in favor of pure Cloud Persistence via the V2 Dashboard.

  async function init() {
    isBooting = true;
    currentStatus = 'Draft';
    loadGlobals();

    const today = new Date(); // Dynamic live current date
    const uniqueNum = Math.floor(100000 + Math.random() * 900000);
    document.getElementById('i_quote').value = `CMP-${today.getFullYear()}-${uniqueNum}`;
    const valid = new Date(today); valid.setDate(valid.getDate() + 15); 
    
    document.getElementById('i_gen_date').value = today.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    document.getElementById('i_valid_date').value = valid.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    
    const dStart = new Date(today); dStart.setDate(dStart.getDate() + 1);
    const sy = dStart.getFullYear();
    const sm = String(dStart.getMonth() + 1).padStart(2, '0');
    const sd = String(dStart.getDate()).padStart(2, '0');
    document.getElementById('i_start').value = `${sy}-${sm}-${sd}`;
    
    const dEnd = new Date(dStart); dEnd.setDate(dEnd.getDate() + 4);
    const ey = dEnd.getFullYear();
    const em = String(dEnd.getMonth() + 1).padStart(2, '0');
    const ed = String(dEnd.getDate()).padStart(2, '0');
    document.getElementById('i_end').value = `${ey}-${em}-${ed}`;
    
    calcDuration(); calcFinancials();
    addHotel(); addDay(); 
    
    const historyContainer = document.getElementById('history-list');
    if (historyContainer) historyContainer.innerHTML = `<p style="font-size: 13px; color: #999;">Please use the Dashboard to view and manage your saved itineraries.</p>`;
    
    setTimeout(() => { isBooting = false; }, 500); // Allow initial DOM renders to clear before enabling auto-save
  }

  function loadItineraryFromData(data) {
    if(!data) return;
    isBooting = true;
    currentStatus = data.status || 'Draft';
    currentRecordVersion = data.version || null;
    
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
    setTimeout(() => { isBooting = false; }, 500);
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
            const isAuth = await initAuth();
            if (!isAuth) {
                document.getElementById('auth-overlay').style.display = 'flex';
                document.getElementById('auth-overlay').style.opacity = '1';
                
                // Add a notice about the temporary restriction
                const loginBox = document.querySelector('.auth-card');
                if (loginBox && !document.getElementById('client-notice')) {
                    const notice = document.createElement('div');
                    notice.id = 'client-notice';
                    notice.style.cssText = "background: #fff3cd; color: #856404; padding: 15px; margin-bottom: 20px; border-radius: 8px; font-size: 14px; text-align: left; border: 1px solid #ffeeba;";
                    notice.innerHTML = "<strong>Notice for Customers:</strong> Unauthenticated customer-sharing links are temporarily disabled until secure share links are implemented. Please wait for an updated secure link from your agent, or ask your agent to log in here to view this itinerary.";
                    loginBox.insertBefore(notice, loginBox.firstChild);
                }
                
                return; // Wait for login
            } else {
                loadGlobals();
            }
        } else {
            // Edit Mode (Load into editor)
            const isAuth = await initAuth();
            if (!isAuth) {
                document.getElementById('auth-overlay').style.display = 'flex';
                document.getElementById('auth-overlay').style.opacity = '1';
                // Execution stops here. window.onLoginSuccess will call boot() later.
                return;
            } else {
                loadGlobals();
            }
        }

        const loader = document.getElementById('loader-overlay');
        if(loader) loader.style.display = 'flex';

        try {
            const response = await fetchWithAuth(`/api/getItinerary/${activeId}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const result = await response.json();
            if (result.success && result.data) {
                const data = result.data;
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
        const isAuth = await initAuth();
        if (!isAuth) {
            document.getElementById('auth-overlay').style.display = 'flex';
            document.getElementById('auth-overlay').style.opacity = '1';
        } else {
            loadGlobals();
            init();
        }
    }
  }

  boot();

  // --- Document Management Logic (Generic mock for UI) ---
  let uploadedDocuments = [];

  function handleDocumentUpload(event) {
      const file = event.target.files[0];
      if (!file) return;

      // Simulate upload delay
      const toast = document.getElementById('toast');
      if (toast) {
          toast.textContent = "Uploading to Zoho WorkDrive...";
          toast.className = "show";
          setTimeout(() => toast.className = toast.className.replace("show", ""), 2500);
      }

      // Mock successful upload and Zoho API response
      setTimeout(() => {
          const fileObj = {
              id: 'doc_' + Date.now(),
              name: file.name,
              size: (file.size / 1024).toFixed(2) + ' KB',
              type: file.type,
              url: URL.createObjectURL(file), // Local blob URL for view/download
              zohoId: 'wkdrv_' + Math.random().toString(36).substring(7) // Mock Zoho ID
          };
          
          uploadedDocuments.push(fileObj);
          renderDocuments();
          event.target.value = ''; // Reset input
          
          if (toast) {
              toast.textContent = "Document uploaded successfully!";
              toast.className = "show";
              setTimeout(() => toast.className = toast.className.replace("show", ""), 2500);
          }
      }, 1000);
  }

  function renderDocuments() {
      const list = document.getElementById('docs-list');
      const emptyState = document.getElementById('docs-empty-state');
      
      list.innerHTML = '';
      
      if (uploadedDocuments.length === 0) {
          emptyState.style.display = 'block';
      } else {
          emptyState.style.display = 'none';
          
          uploadedDocuments.forEach(doc => {
              const div = document.createElement('div');
              div.style = "display:flex; justify-content:space-between; align-items:center; background:#f9fafb; padding:10px; border-radius:6px; border:1px solid #e5e7eb;";
              
              const icon = doc.type.includes('pdf') ? 'fa-file-pdf' : (doc.type.includes('image') ? 'fa-file-image' : 'fa-file');
              const color = doc.type.includes('pdf') ? '#e11d48' : '#0284c7';
              
              div.innerHTML = `
                  <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
                      <i class="fa-solid ${icon}" style="color:${color}; font-size:20px;"></i>
                      <div style="display:flex; flex-direction:column; overflow:hidden;">
                          <span style="font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;" title="${doc.name}">${doc.name}</span>
                          <span style="font-size:11px; color:#6b7280;">${doc.size}</span>
                      </div>
                  </div>
                  <div style="display:flex; gap:5px; flex-shrink:0;">
                      <button class="btn-outline" style="padding:4px 8px; font-size:12px; min-width:auto;" onclick="viewDocument('${doc.id}')" title="View/Download"><i class="fa-solid fa-eye"></i></button>
                      <button class="btn-outline" style="padding:4px 8px; font-size:12px; min-width:auto; color:#ef4444; border-color:#fca5a5;" onclick="deleteDocument('${doc.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
                  </div>
              `;
              list.appendChild(div);
          });
      }
  }

  function viewDocument(id) {
      const doc = uploadedDocuments.find(d => d.id === id);
      if (doc && doc.url) {
          // Open the document in a new tab to view or trigger download
          const link = document.createElement('a');
          link.href = doc.url;
          link.target = '_blank';
          link.download = doc.name; // Encourages download if browser can't view
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
      }
  }

  function deleteDocument(id) {
      if (confirm("Are you sure you want to delete this document?")) {
          uploadedDocuments = uploadedDocuments.filter(d => d.id !== id);
          renderDocuments();
          
          const toast = document.getElementById('toast');
          if (toast) {
              toast.textContent = "Document deleted.";
              toast.className = "show";
              setTimeout(() => toast.className = toast.className.replace("show", ""), 2500);
          }
      }
  }
