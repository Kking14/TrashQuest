import express from 'express';
import {
    addReward,
    listRewards,
    editReward,
    serveRewardImage,
    uploadRewardImage,
    deleteRewardImage,
    redeem,
    claimRedemption,
} from '../controller/rewardController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';
 
const router = express.Router();
 
router.post('/', authenticate, authorize('admin'), addReward);
router.get('/', authenticate, listRewards);
router.get('/:id/image', serveRewardImage);
router.put('/:id/image', authenticate, authorize('admin'), express.raw({ type: 'image/jpeg', limit: '400kb' }), uploadRewardImage);
router.delete('/:id/image', authenticate, authorize('admin'), deleteRewardImage);
router.put('/:id', authenticate, authorize('admin'), editReward);
router.post('/:id/redeem', authenticate, redeem);
router.put('/:id/redemptions/:redemptionId/claim', authenticate, authorize('admin'), claimRedemption);
 
export default router;
