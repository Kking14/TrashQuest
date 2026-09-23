import { randomInt } from 'node:crypto';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generatePickupCode = () => {
    const characters = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
    return `TQ-${characters.slice(0, 5)}-${characters.slice(5)}`;
};

const normalizePickupCode = (value) => {
    const compact = typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]/g, '') : '';
    if (!/^TQ[A-HJ-NP-Z2-9]{10}$/.test(compact)) {
        throw new Error('Enter a valid 10-character TrashQuest pickup code.');
    }
    return `TQ-${compact.slice(2, 7)}-${compact.slice(7)}`;
};

export { generatePickupCode, normalizePickupCode };
