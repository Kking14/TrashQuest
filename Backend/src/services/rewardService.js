import mongoose from 'mongoose';
import Reward from '../models/rewardModel.js';
import User from '../models/userModel.js';
import { generatePickupCode, normalizePickupCode } from '../utils/pickupCode.js';
 
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

const getRewardImage = async (rewardID) => Reward.findById(rewardID)
    .select('+imageData imageContentType');

const setRewardImage = async (rewardID, imageData) => Reward.findByIdAndUpdate(
    rewardID,
    {
        $set: {
            imageData,
            imageContentType: 'image/jpeg',
            imageUpdatedAt: new Date(),
        },
    },
    { new: true, runValidators: true }
).select('-imageData');

const removeRewardImage = async (rewardID) => Reward.findByIdAndUpdate(
    rewardID,
    {
        $unset: { imageData: 1 },
        $set: { imageContentType: null, imageUpdatedAt: null },
    },
    { new: true }
).select('-imageData');
 
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
            reward.redemptions.push({ user: userID, pointsSpent: reward.pointsCost, pickupCode: generatePickupCode() });
            await reward.save({ session });
 
            redemption = reward.redemptions[reward.redemptions.length - 1];
        });
        return redemption;
    } finally {
        session.endSession();
    }
};
 
const toRedemptionSummary = (reward, redemption, resident = null) => ({
    _id: redemption._id,
    rewardId: reward._id,
    rewardName: reward.name,
    pickupCode: redemption.pickupCode,
    pointsSpent: redemption.pointsSpent,
    status: redemption.status,
    redeemedAt: redemption.redeemedAt,
    claimedAt: redemption.claimedAt,
    ...(resident ? { resident: { name: resident.name, email: resident.email } } : {}),
});

// Older pending redemptions were created before pickup codes existed. Assign
// each code with a conditional update, so concurrent reads cannot replace it.
const ensurePickupCode = async (rewardID, redemptionID, userID) => {
    const reward = await Reward.findOneAndUpdate(
        {
            _id: rewardID,
            redemptions: { $elemMatch: { _id: redemptionID, user: userID, status: 'pending', pickupCode: null } },
        },
        { $set: { 'redemptions.$.pickupCode': generatePickupCode() } },
        { new: true }
    );
    return reward?.redemptions.id(redemptionID)?.pickupCode
        || (await Reward.findById(rewardID))?.redemptions.id(redemptionID)?.pickupCode;
};

const listMyRedemptions = async (userID) => {
    const rewards = await Reward.find({ 'redemptions.user': userID });
    const entries = [];
    for (const reward of rewards) {
        for (const redemption of reward.redemptions) {
            if (String(redemption.user) !== String(userID)) continue;
            if (redemption.status === 'pending' && !redemption.pickupCode) {
                redemption.pickupCode = await ensurePickupCode(reward._id, redemption._id, userID);
            }
            entries.push(toRedemptionSummary(reward, redemption));
        }
    }
    return entries.sort((a, b) => new Date(b.redeemedAt) - new Date(a.redeemedAt));
};

const lookupRedemptionByCode = async (value) => {
    const pickupCode = normalizePickupCode(value);
    const reward = await Reward.findOne({ 'redemptions.pickupCode': pickupCode });
    const redemption = reward?.redemptions.find((entry) => entry.pickupCode === pickupCode);
    if (!redemption) throw new Error('Pickup code not found. Check the code with the resident.');
    const resident = await User.findById(redemption.user).select('name email');
    return toRedemptionSummary(reward, redemption, resident);
};

const claimRedemptionByCode = async (value) => {
    const pickupCode = normalizePickupCode(value);
    const reward = await Reward.findOneAndUpdate(
        { redemptions: { $elemMatch: { pickupCode, status: 'pending' } } },
        { $set: { 'redemptions.$.status': 'claimed', 'redemptions.$.claimedAt': new Date() } },
        { new: true }
    );
    if (!reward) {
        const existing = await Reward.findOne({ 'redemptions.pickupCode': pickupCode });
        throw new Error(existing ? 'This reward has already been claimed.' : 'Pickup code not found. Check the code with the resident.');
    }
    const redemption = reward.redemptions.find((entry) => entry.pickupCode === pickupCode);
    const resident = await User.findById(redemption.user).select('name email');
    return toRedemptionSummary(reward, redemption, resident);
};
 
export { createReward, getAllRewards, updateReward, getRewardImage, setRewardImage, removeRewardImage, redeemReward, listMyRedemptions, lookupRedemptionByCode, claimRedemptionByCode };
