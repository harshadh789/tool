(function(exports) {
    function calculateNights(start, end) {
        if (!start || !end) return 0;
        const s = new Date(start);
        const e = new Date(end);
        if (isNaN(s) || isNaN(e)) return 0;
        return Math.max(0, Math.ceil((e - s) / (1000 * 60 * 60 * 24)));
    }

    function validateItinerary(data) {
        const errors = [];
        const warnings = [];

        // Core fields
        if (!data.id) errors.push("Missing Quote ID.");
        if (!data.title || !data.title.trim()) warnings.push("Missing Itinerary Title.");
        if (!data.guest || !data.guest.trim()) warnings.push("Missing Guest Name.");

        // Dates
        let nights = 0;
        let expectedDays = 0;
        if (!data.start || !data.end) {
            warnings.push("Missing Start or End Date.");
        } else {
            const s = new Date(data.start);
            const e = new Date(data.end);
            if (isNaN(s) || isNaN(e)) {
                errors.push("Invalid date format.");
            } else if (e < s) {
                errors.push("End date cannot be before start date.");
            } else {
                nights = calculateNights(data.start, data.end);
                expectedDays = nights + 1;
            }
        }

        // Numerics
        if (data.adults && isNaN(parseInt(data.adults, 10))) errors.push("Guest count must be numeric.");
        if (data.baseCost && isNaN(parseFloat(data.baseCost))) errors.push("Base cost must be numeric.");

        // Days
        if (data.days && Array.isArray(data.days)) {
            if (expectedDays > 0 && data.days.length !== expectedDays) {
                warnings.push(`Expected ${expectedDays} days based on dates, but found ${data.days.length} day(s).`);
            }
            if (data.days.length === 0) {
                warnings.push("No days added to the itinerary.");
            }
            data.days.forEach((day, index) => {
                if (!day.title || !day.title.trim()) {
                    warnings.push(`Day ${index + 1} is missing a title.`);
                }
            });
        } else {
            warnings.push("No days array found in the itinerary.");
        }

        // Hotels
        if (data.hotels && Array.isArray(data.hotels)) {
            let totalHotelNights = 0;
            let uncertainNights = false;
            data.hotels.forEach((hotel, index) => {
                if (!hotel.name || !hotel.name.trim()) warnings.push(`Hotel ${index + 1} is missing a name.`);
                if (!hotel.nights || !String(hotel.nights).trim()) {
                    warnings.push(`Hotel ${index + 1} is missing stay details.`);
                } else {
                    const n = parseInt(hotel.nights, 10);
                    if (isNaN(n)) {
                        uncertainNights = true;
                    } else {
                        totalHotelNights += n;
                    }
                }
            });
            if (nights > 0 && !uncertainNights && totalHotelNights > 0 && totalHotelNights !== nights) {
                warnings.push(`Total hotel nights (${totalHotelNights}) does not match trip nights (${nights}).`);
            } else if (uncertainNights) {
                warnings.push(`Hotel night durations cannot be mathematically verified from text labels (UNCERTAIN).`);
            }
        } else {
            warnings.push("No hotels array found in the itinerary.");
        }

        // Status Logic
        const isReadyForCustomer = data.status !== 'Draft';
        if (isReadyForCustomer && warnings.length > 0) {
            // Promote warnings to errors if trying to transition out of Draft
            const unpromotableWarnings = [];
            warnings.forEach(w => {
                if (w.includes('(UNCERTAIN)')) {
                    unpromotableWarnings.push(w);
                } else {
                    errors.push("Required for non-Draft: " + w);
                }
            });
            warnings.length = 0; // Clear warnings since they are now errors
            warnings.push(...unpromotableWarnings);
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    exports.validateItinerary = validateItinerary;
    exports.calculateNights = calculateNights;
})(typeof exports === 'undefined' ? this.Validation = {} : exports);
