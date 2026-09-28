import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';

test('trusted redemption filter survives global query sanitization', () => {
    const pickupCode = 'TQ-ABCDE-23456';
    const filter = {
        redemptions: mongoose.trusted({
            $elemMatch: { pickupCode, status: 'pending' },
        }),
    };

    mongoose.sanitizeFilter(filter);

    assert.deepEqual(filter.redemptions.$elemMatch, {
        pickupCode,
        status: 'pending',
    });
});
