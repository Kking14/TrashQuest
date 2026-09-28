import test from 'node:test';
import assert from 'node:assert/strict';
import Reward from '../src/models/rewardModel.js';
import { deleteReward } from '../src/services/rewardService.js';

test('deletes an unused reward', async () => {
    const originalFindById = Reward.findById;
    const originalFindByIdAndDelete = Reward.findByIdAndDelete;
    let deletedID = null;
    try {
        Reward.findById = () => ({
            select: async () => ({ _id: 'reward-1', name: 'Unused reward', redemptions: [] }),
        });
        Reward.findByIdAndDelete = async (rewardID) => {
            deletedID = rewardID;
        };

        const reward = await deleteReward('reward-1');
        assert.equal(reward.name, 'Unused reward');
        assert.equal(deletedID, 'reward-1');
    } finally {
        Reward.findById = originalFindById;
        Reward.findByIdAndDelete = originalFindByIdAndDelete;
    }
});

test('keeps a reward that contains resident redemption history', async () => {
    const originalFindById = Reward.findById;
    const originalFindByIdAndDelete = Reward.findByIdAndDelete;
    let deleteCalled = false;
    try {
        Reward.findById = () => ({
            select: async () => ({ _id: 'reward-2', name: 'Used reward', redemptions: [{ status: 'claimed' }] }),
        });
        Reward.findByIdAndDelete = async () => {
            deleteCalled = true;
        };

        await assert.rejects(
            deleteReward('reward-2'),
            /redemption history.*inactive/i
        );
        assert.equal(deleteCalled, false);
    } finally {
        Reward.findById = originalFindById;
        Reward.findByIdAndDelete = originalFindByIdAndDelete;
    }
});
