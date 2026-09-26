export const BIN_TYPES = ['plastic', 'metal'];

export function applyFullnessReading(current, reading, now = new Date()) {
    const { binType = 'plastic', isFull, readingValid = true, distanceCm = null } = reading;
    if (!BIN_TYPES.includes(binType)) throw new Error('binType must be plastic or metal');
    if (typeof isFull !== 'boolean' || typeof readingValid !== 'boolean') {
        throw new Error('isFull and readingValid must be true or false');
    }
    if (distanceCm !== null && (typeof distanceCm !== 'number' || !Number.isFinite(distanceCm)
        || distanceCm < 1 || distanceCm > 400)) throw new Error('Invalid distanceCm');
    const compartments = Object.fromEntries(BIN_TYPES.map((key) => [key, {
        isFull: Boolean(current?.[key]?.isFull),
        readingValid: Boolean(current?.[key]?.readingValid),
        distanceCm: current?.[key]?.distanceCm ?? null,
        updatedAt: current?.[key]?.updatedAt ?? null,
    }]));
    const previous = compartments[binType];
    const nextFull = readingValid ? isFull : previous.isFull || isFull;
    compartments[binType] = {
        isFull: nextFull,
        readingValid,
        distanceCm: readingValid ? distanceCm : null,
        updatedAt: now,
    };
    return {
        compartments,
        isFull: BIN_TYPES.some((key) => compartments[key].isFull),
        changed: nextFull !== previous.isFull,
    };
}
