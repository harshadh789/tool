const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', msg => {
        const txt = msg.text();
        if (txt.toLowerCase().includes('error') || txt.toLowerCase().includes('failed')) {
            errors.push(txt);
        }
    });
    page.on('pageerror', error => errors.push('JS ERROR: ' + error.message));

    await page.goto('http://localhost:3000/');
    await new Promise(r => setTimeout(r, 1000));

    // Login
    await page.type('#login_user', 'emp1');
    await page.type('#login_pass', '123');
    await page.click('.auth-btn');
    await new Promise(r => setTimeout(r, 1000));

    // Set a unique quote ID
    await page.evaluate(() => { document.getElementById('i_quote').value = 'TEST-BTN-001'; });
    await page.evaluate(() => { document.getElementById('i_guest').value = 'Test Guest'; });

    // ---- TEST: Save to Cloud & Get Link ----
    console.log("\n🔵 TEST: Save to Cloud & Get Link");
    page.once('dialog', async dialog => {
        const msg = dialog.message();
        if (msg.includes('Success')) {
            console.log("  ✅ Save to Cloud: PASS -", msg.substring(0, 80));
        } else {
            console.log("  ❌ Save to Cloud: FAIL -", msg.substring(0, 80));
        }
        await dialog.dismiss();
    });
    await page.click('#btn_save_cloud');
    await new Promise(r => setTimeout(r, 5000));

    // ---- TEST: Save Draft (Local) / cloud silent save ----
    console.log("\n🔵 TEST: Save Draft (Local)");
    await page.click('#btn_save_draft');
    await new Promise(r => setTimeout(r, 3000));
    const toastText = await page.$eval('#toast', el => el.innerText).catch(() => '');
    if (toastText && toastText.includes('Saved')) {
        console.log("  ✅ Save Draft: PASS - Toast:", toastText);
    } else {
        console.log("  ⚠️  Save Draft: Toast not visible or different:", toastText);
    }

    // ---- TEST: Send Request to Ops ----
    console.log("\n🔵 TEST: Send Request to Ops");
    page.once('dialog', async dialog => {
        const msg = dialog.message();
        if (msg.includes('Success')) {
            console.log("  ✅ Request to Ops: PASS");
        } else {
            console.log("  ❌ Request to Ops: FAIL -", msg.substring(0, 80));
        }
        await dialog.dismiss();
    });
    await page.click('#btn_req_ops');
    await new Promise(r => setTimeout(r, 5000));

    // ---- TEST: Dashboard Button ----
    console.log("\n🔵 TEST: Dashboard Button");
    const newPagePromise = new Promise(x => browser.once('targetcreated', target => x(target.page())));
    await page.evaluate(() => { window.open('http://localhost:3000/dashboard.html', '_blank'); });
    const dashPage = await newPagePromise;
    await new Promise(r => setTimeout(r, 4000));
    const dashErrors = [];
    dashPage.on('console', msg => {
        if (msg.text().toLowerCase().includes('error')) dashErrors.push(msg.text());
    });
    const dashTitle = await dashPage.title().catch(() => '');
    const tableBody = await dashPage.$eval('#table_body', el => el.innerText).catch(() => '');
    if (!tableBody.includes('Error') && !tableBody.includes('Firebase')) {
        console.log("  ✅ Dashboard: PASS - Title:", dashTitle);
        console.log("  Records shown:", tableBody.substring(0, 120));
    } else {
        console.log("  ❌ Dashboard: FAIL -", tableBody.substring(0, 120));
    }

    // ---- TEST: Download PDF ----
    console.log("\n🔵 TEST: Download Infinite PDF");
    const pdfVisible = await page.$eval('#pdf-container', el => el.offsetWidth > 0).catch(() => false);
    if (pdfVisible) {
        console.log("  ✅ PDF Container: Visible - PDF download should work");
    } else {
        console.log("  ❌ PDF Container: Not visible or not found");
    }

    // ---- TEST: Load from Cloud (?id= param) ----
    console.log("\n🔵 TEST: Load from Cloud (?id=TEST-BTN-001)");
    const viewPage = await browser.newPage();
    viewPage.on('console', msg => {
        if (msg.text().toLowerCase().includes('error')) errors.push('LOAD: ' + msg.text());
    });
    await viewPage.goto('http://localhost:3000/?id=TEST-BTN-001');
    await new Promise(r => setTimeout(r, 5000));
    const loadedQuote = await viewPage.$eval('#i_quote', el => el.value).catch(() => '');
    if (loadedQuote === 'TEST-BTN-001') {
        console.log("  ✅ Load from Cloud: PASS - Loaded ID:", loadedQuote);
    } else {
        console.log("  ❌ Load from Cloud: FAIL - Got:", loadedQuote);
    }

    console.log("\n---- Summary ----");
    if (errors.length === 0) {
        console.log("✅ No JS errors detected.");
    } else {
        console.log("❌ JS Errors found:");
        errors.forEach(e => console.log("  -", e));
    }

    await browser.close();
})();
