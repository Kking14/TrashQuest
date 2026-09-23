import {
    createReward,
    getAllRewards,
    updateReward,
    getRewardImage,
    setRewardImage,
    removeRewardImage,
    redeemReward,
    listMyRedemptions,
    lookupRedemptionByCode,
    claimRedemptionByCode,
} from '../services/rewardService.js';
import { validateRewardImage } from '../utils/rewardImage.js';

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
        const rewards = await getAllRewards({ includeRedemptions: req.user.role === 'admin' });
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

const serveRewardImage = async (req, res) => {
    try {
        const reward = await getRewardImage(req.params.id);
        if (!Buffer.isBuffer(reward?.imageData) || reward.imageContentType !== 'image/jpeg') {
            return res.status(404).json({ success: false, message: 'Reward photo not found' });
        }
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        return res.type('jpeg').send(reward.imageData);
    } catch {
        return res.status(404).json({ success: false, message: 'Reward photo not found' });
    }
};

const uploadRewardImage = async (req, res) => {
    try {
        validateRewardImage(req.body, req.get('Content-Type')?.split(';')[0]);
        const reward = await setRewardImage(req.params.id, req.body);
        if (!reward) return res.status(404).json({ success: false, message: 'Reward not found' });
        return res.status(200).json({ success: true, message: 'Reward photo saved', data: reward });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const deleteRewardImage = async (req, res) => {
    try {
        const reward = await removeRewardImage(req.params.id);
        if (!reward) return res.status(404).json({ success: false, message: 'Reward not found' });
        return res.status(200).json({ success: true, message: 'Reward photo removed', data: reward });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
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

const myRedemptions = async (req, res) => {
    try {
        const redemptions = await listMyRedemptions(req.user.id);
        res.status(200).json({ success: true, data: redemptions });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const findRedemption = async (req, res) => {
    try {
        const redemption = await lookupRedemptionByCode(req.body?.pickupCode);
        res.status(200).json({ success: true, data: redemption });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const claimRedemption = async (req, res) => {
    try {
        const redemption = await claimRedemptionByCode(req.body?.pickupCode);
        res.status(200).json({ success: true, message: 'Reward handover confirmed', data: redemption });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export { addReward, listRewards, editReward, serveRewardImage, uploadRewardImage, deleteRewardImage, redeem, myRedemptions, findRedemption, claimRedemption };
