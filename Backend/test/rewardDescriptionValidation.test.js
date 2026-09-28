import test from 'node:test';
import assert from 'node:assert/strict';
import Reward from '../src/models/rewardModel.js';

test('reward requires a non-empty description', async () => {
    const reward = new Reward({
        name: 'Eco voucher',
        description: '   ',
        pointsCost: 50,
        stock: 10,
    });

    await assert.rejects(reward.validate(), /description is required/i);
});

test('reward accepts a meaningful description', async () => {
    const reward = new Reward({
        name: 'Eco voucher',
        description: 'Redeem at the barangay hall',
        pointsCost: 50,
        stock: 10,
    });

    await assert.doesNotReject(reward.validate());
});
