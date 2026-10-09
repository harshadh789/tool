const { validateItinerary } = require('../validation.js');

function runTest(name, itinerary, expectedValid, expectedErrorCount = 0, expectedWarningCount = 0) {
    const res = validateItinerary(itinerary);
    const passValid = res.isValid === expectedValid;
    const passErr = res.errors.length === expectedErrorCount;
    const passWarn = res.warnings.length === expectedWarningCount;
    
    if (passValid && passErr && passWarn) {
        console.log(`[PASS] ${name}`);
    } else {
        console.error(`[FAIL] ${name}`);
        console.error(`  Expected Valid: ${expectedValid}, Got: ${res.isValid}`);
        console.error(`  Expected Errors: ${expectedErrorCount}, Got: ${res.errors.length}`);
        if (!passErr) console.error("  Errors:", res.errors);
        console.error(`  Expected Warnings: ${expectedWarningCount}, Got: ${res.warnings.length}`);
        if (!passWarn) console.error("  Warnings:", res.warnings);
    }
}

console.log("=== RUNNING VALIDATION TESTS ===\n");

// 1. A complete 5-day itinerary passes
runTest("1. Complete 5-day itinerary passes", {
    id: "TEST-01",
    title: "Bali Trip",
    guest: "John Doe",
    start: "2026-10-10",
    end: "2026-10-14",
    adults: 2,
    baseCost: 1000,
    status: "Requested",
    days: [
        { title: "Day 1" },
        { title: "Day 2" },
        { title: "Day 3" },
        { title: "Day 4" },
        { title: "Day 5" }
    ],
    hotels: [
        { name: "Hotel A", nights: 4 }
    ]
}, true, 0, 0);

// 2. A 5-day itinerary with only one day entry is flagged as incomplete
runTest("2. 5-day itinerary with only one day entry (Requested state) is flagged", {
    id: "TEST-02",
    title: "Bali Trip",
    guest: "John Doe",
    start: "2026-10-10",
    end: "2026-10-14",
    adults: 2,
    baseCost: 1000,
    status: "Requested", // non-draft, so warnings become errors
    days: [
        { title: "Day 1" }
    ],
    hotels: [
        { name: "Hotel A", nights: 4 }
    ]
}, false, 1, 0); // 1 error for the day length mismatch

// 3. An incomplete Draft can be saved only according to the intended draft rules and shows a warning.
runTest("3. Incomplete Draft saves but has warnings", {
    id: "TEST-03",
    title: "Bali Trip",
    guest: "John Doe",
    start: "2026-10-10",
    end: "2026-10-14",
    adults: 2,
    baseCost: 1000,
    status: "Draft",
    days: [
        { title: "Day 1" }
    ],
    hotels: [
        { name: "Hotel A", nights: 4 }
    ]
}, true, 0, 1);

// 4. An incomplete itinerary cannot transition to Requested.
runTest("4. Incomplete itinerary cannot transition to Requested", {
    id: "TEST-04",
    title: "Bali Trip",
    guest: "John Doe",
    start: "2026-10-10",
    end: "2026-10-14",
    status: "Requested",
    days: [] // no days
}, false, 3, 0); // 3 errors (Expected 5 days, no days, no hotels)

// 5. Invalid dates are rejected.
runTest("5. Invalid dates are rejected", {
    id: "TEST-05",
    title: "Bali Trip",
    guest: "John Doe",
    start: "2026-10-15",
    end: "2026-10-14", // end before start
    status: "Draft"
}, false, 1, 2); // 1 error (end < start), 2 warnings (no days, no hotels)

// 6. Missing required fields are reported.
runTest("6. Missing required fields are reported", {
    id: "TEST-06",
    // missing title, guest
    start: "2026-10-10",
    end: "2026-10-14",
    status: "Requested",
    days: [{title: "Day 1"}, {title: "Day 2"}, {title: "Day 3"}, {title: "Day 4"}, {title: "Day 5"}],
    hotels: [{name: "Hotel A", nights: 4}]
}, false, 2, 0); // 2 errors for missing title and guest

// 7. Invalid numeric values cannot produce NaN in persistence payloads.
runTest("7. Invalid numeric values are rejected", {
    id: "TEST-07",
    title: "Bali Trip",
    guest: "John Doe",
    adults: "abc", // invalid number
    baseCost: "xyz",
    start: "2026-10-10",
    end: "2026-10-14",
    status: "Draft",
    days: [{title: "Day 1"}, {title: "Day 2"}, {title: "Day 3"}, {title: "Day 4"}, {title: "Day 5"}],
    hotels: [{name: "Hotel A", nights: 4}]
}, false, 2, 0);

// 8. Frontend validation cannot be bypassed to evade backend checks.
// (Since both use the exact same validation module, testing the module covers this requirement conceptually,
// but we'll run a test with an empty ID to prove the backend would reject a malformed payload.)
runTest("8. Backend catches bypassed frontend payload (missing ID)", {
    // id missing entirely
    title: "Bali Trip",
    guest: "John Doe",
    status: "Requested"
}, false, 4, 0); // errors: Missing ID, Missing Start/End, No days, No hotels

console.log("\n=== TESTS COMPLETE ===");
