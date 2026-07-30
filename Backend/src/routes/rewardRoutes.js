import express from 'express';
import {
    addReward,
    listRewards,
    editReward,
    redeem,
    claimRedemption,
} from '../controller/rewardController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';
 
const router = express.Router();
 
router.post('/', authenticate, authorize('admin'), addReward);
router.get('/', authenticate, listRewards);
router.put('/:id', authenticate, authorize('admin'), editReward);
router.post('/:id/redeem', authenticate, redeem);
router.put('/:id/redemptions/:redemptionId/claim', authenticate, authorize('admin'), claimRedemption);
 
export default router;