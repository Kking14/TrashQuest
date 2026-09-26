import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFullnessReading } from '../src/utils/binFullness.js';
import { compartmentStatus, fullBinDescription } from '../../Frontend/src/binFullness.js';

test('each compartment independently keeps the whole station full', () => {
    for (const [first, second] of [['plastic', 'metal'], ['metal', 'plastic']]) {
        let state = applyFullnessReading({}, { binType: first, isFull: true });
        state = applyFullnessReading(state.compartments, { binType: second, isFull: false });
        assert.equal(state.isFull, true);
        state = applyFullnessReading(state.compartments, { binType: second, isFull: true });
        assert.equal(state.changed, true); // notify when the second bin fills, too
        state = applyFullnessReading(state.compartments, { binType: first, isFull: false });
        assert.equal(state.isFull, true);
        state = applyFullnessReading(state.compartments, { binType: second, isFull: false });
        assert.equal(state.isFull, false);
    }
});

test('unavailable sensor cannot erase a confirmed full reading', () => {
    let state = applyFullnessReading({}, { binType: 'metal', isFull: true });
    state = applyFullnessReading(state.compartments, { binType: 'metal', isFull: false, readingValid: false });
    assert.equal(state.isFull, true);
    assert.equal(state.compartments.metal.readingValid, false);
    assert.equal(state.compartments.metal.distanceCm, null);
});

test('legacy reports map to plastic and invalid values are rejected', () => {
    assert.equal(applyFullnessReading({}, { isFull: true }).compartments.plastic.isFull, true);
    for (const reading of [{ binType: 'unknown', isFull: true }, { isFull: 'false' },
        { isFull: true, readingValid: 'false' }, { isFull: false, distanceCm: -10 }]) {
        assert.throws(() => applyFullnessReading({}, reading));
    }
});

test('admin names the actual full bin and shows missing/stale readings', () => {
    const now = Date.now();
    const reading = { isFull: false, readingValid: true, distanceCm: 30, updatedAt: new Date(now).toISOString() };
    assert.equal(compartmentStatus(reading, now).label, 'Available');
    assert.equal(compartmentStatus(undefined, now).label, 'Reading unavailable');
    assert.equal(compartmentStatus(reading, now + 31000).label, 'Reading unavailable');
    assert.equal(compartmentStatus({ ...reading, updatedAt: now / 1000 }, now).fresh, true);
    assert.equal(compartmentStatus({ ...reading, isFull: true }, now + 31000).full, true);
    assert.equal(fullBinDescription({ compartments: { metal: { isFull: true } } }), 'Metal bin is full');
    assert.equal(fullBinDescription({ compartments: { plastic: { isFull: true }, metal: { isFull: true } } }),
        'Plastic bin and Metal bin are full');
});
