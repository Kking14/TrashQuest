import dotenv from 'dotenv';

dotenv.config({ quiet: true });

// Per-item rewards. Environment variables override these defaults.
const readRate = (name, fallback) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return value;
};

const POINTS_PER_ITEM = Object.freeze({
    Paper: readRate('TQ_POINTS_PER_ITEM_PAPER', 5),
    Plastic: readRate('TQ_POINTS_PER_ITEM_PLASTIC', 10),
    'Tin Can': readRate('TQ_POINTS_PER_ITEM_TIN_CAN', 15),
});

const calculatePoints = (wasteType, itemCount) => {
    const rate = POINTS_PER_ITEM[wasteType];
    if (rate === undefined) {
        throw new Error(`No point rate configured for waste type: ${wasteType}`);
    }
    if (!Number.isInteger(itemCount) || itemCount <= 0) {
        throw new Error('Item count must be a positive integer');
    }
    return Math.round(rate * itemCount);
};

export { calculatePoints, POINTS_PER_ITEM };
