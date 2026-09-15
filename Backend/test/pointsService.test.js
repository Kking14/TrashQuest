import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePoints, POINTS_PER_ITEM } from '../src/services/pointsService.js';

test('calculates rewards from AI item count', () => {
    assert.equal(calculatePoints('Plastic', 3), 3 * POINTS_PER_ITEM.Plastic);
});

test('rejects invalid item counts', () => {
    assert.throws(() => calculatePoints('Plastic', 0), /positive integer/);
    assert.throws(() => calculatePoints('Plastic', 1.5), /positive integer/);
});

test('placeholder rates exist for every supported waste type', () => {
    assert.deepEqual(Object.keys(POINTS_PER_ITEM).sort(), ['Paper', 'Plastic', 'Tin Can'].sort());
});
