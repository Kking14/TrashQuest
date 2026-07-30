// PLACEHOLDER RATES - confirm actual point values with the barangay program
// before going live. Only Paper, Plastic, and Tin Can are accepted waste
// types for this bin.
const POINTS_PER_KG = {
    Paper: 5,
    Plastic: 8,
    'Tin Can': 8,
};

const calculatePoints = (wasteType, quantity) => {
    const rate = POINTS_PER_KG[wasteType];
    if (rate === undefined) {
        throw new Error(`No point rate configured for waste type: ${wasteType}`);
    }
    if (typeof quantity !== 'number' || quantity <= 0) {
        throw new Error('Quantity must be a positive number');
    }
    return Math.round(rate * quantity);
};

export { calculatePoints, POINTS_PER_KG };