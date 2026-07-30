import {
    createReward,
    getAllRewards,
    updateReward,
    redeemReward,
    markRedemptionClaimed,
} from '../services/rewardService.js';

const addReward = async (req, res) => {
    try {
        const reward = await createReward(req.body);
        res.status(201).json({ success: true, message: 'Reward created successfully', data: reward });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const listRewards = async (req, res) => {
    try {
        const rewards = await getAllRewards();
        res.status(200).json({ success: true, data: rewards });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const editReward = async (req, res) => {
    try {
        const reward = await updateReward(req.params.id, req.body);
        res.status(200).json({ success: true, message: 'Reward updated successfully', data: reward });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const redeem = async (req, res) => {
    try {
        const redemption = await redeemReward(req.params.id, req.user.id);
        res.status(200).json({ success: true, message: 'Reward redeemed successfully', data: redemption });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const claimRedemption = async (req, res) => {
    try {
        const reward = await markRedemptionClaimed(req.params.id, req.params.redemptionId);
        res.status(200).json({ success: true, message: 'Redemption marked as claimed', data: reward });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export { addReward, listRewards, editReward, redeem, claimRedemption };