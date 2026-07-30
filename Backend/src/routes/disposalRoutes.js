import express from 'express';
import {
    registerDisposalClaim,
    claimDisposalPoints,
    getMyDisposals,
    getDisposalLogs,
} from '../controller/disposalController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';
import authenticateDevice from '../middleware/authenticateDevice.js';
 
const router = express.Router();
 
// Bin device -> backend (sensor just detected a disposal)
router.post('/claims', authenticateDevice, registerDisposalClaim);
 
// Resident app -> backend (resident scanned the QR the bin displayed)
router.post('/claim', authenticate, claimDisposalPoints);
 
router.get('/me', authenticate, getMyDisposals);
router.get('/', authenticate, authorize('admin'), getDisposalLogs);
 
export default router;
 