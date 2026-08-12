import mongoose from 'mongoose';
import Reward from '../models/rewardModel.js';
import User from '../models/userModel.js';
 
const createReward = async (rewardData) => {
    const reward = await Reward.create(rewardData);
    return reward;
};
 
const getAllRewards = async ({ includeRedemptions = false } = {}) => {
    const rewards = await Reward.find()
        .select(includeRedemptions ? undefined : '-redemptions')
        .sort({ pointsCost: 1 })
        .limit(500)
        .lean();
    return rewards;
};
 
const updateReward = async (rewardID, updateData) => {
    const reward = await Reward.findByIdAndUpdate(rewardID, updateData, { new: true });
    if (!reward) {
        throw new Error('Reward not found');
    }
    return reward;
};
 
// Wrapped in a transaction so a resident's points and the reward's stock can
// never desync (e.g. two residents redeeming the last item at the same
// moment). Requires MongoDB running as a replica set - true by default on
// MongoDB Atlas, but this will throw against a bare local standalone mongod.
const redeemReward = async (rewardID, userID) => {
    const session = await mongoose.startSession();
    try {
        let redemption;
        await session.withTransaction(async () => {
            const reward = await Reward.findById(rewardID).session(session);
            if (!reward || reward.status !== 'active') {
                throw new Error('Reward not available');
            }
            if (reward.stock <= 0) {
                throw new Error('Reward is out of stock');
            }
 
            const user = await User.findById(userID).session(session);
            if (!user) {
                throw new Error('User not found');
            }
            if (user.points < reward.pointsCost) {
                throw new Error(`Not enough points. You currently have ${user.points} points, but this reward costs ${reward.pointsCost}.`);
            }
 
            user.points -= reward.pointsCost;
            await user.save({ session });
 
            reward.stock -= 1;
            reward.redemptions.push({ user: userID, pointsSpent: reward.pointsCost });
            await reward.save({ session });
 
            redemption = reward.redemptions[reward.redemptions.length - 1];
        });
        return redemption;
    } finally {
        session.endSession();
    }
};
 
const markRedemptionClaimed = async (rewardID, redemptionID) => {
    const reward = await Reward.findById(rewardID);
    if (!reward) {
        throw new Error('Reward not found');
    }
    const redemption = reward.redemptions.id(redemptionID);
    if (!redemption) {
        throw new Error('Redemption not found');
    }
    redemption.status = 'claimed';
    redemption.claimedAt = new Date();
    await reward.save();
    return reward;
};
 
export { createReward, getAllRewards, updateReward, redeemReward, markRedemptionClaimed };
