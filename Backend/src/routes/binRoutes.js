import express from 'express';
import {
    addBin,
    listBins,
    revealDeviceKey,
    lookupBinByCode,
    editBin,
    reportFullStatus,
    removeBin,
    restoreBin,
    rotateDeviceKey,
} from '../controller/binController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';
import authenticateDevice from '../middleware/authenticateDevice.js';
 
const router = express.Router();
 
router.post('/', authenticate, authorize('admin'), addBin);
router.get('/', authenticate, listBins);
router.get('/:id/device-key', authenticate, authorize('admin'), revealDeviceKey);
router.get('/code/:code', authenticate, lookupBinByCode);
router.put('/sensor/full-status', authenticateDevice, reportFullStatus);
router.put('/:id', authenticate, authorize('admin'), editBin);
router.put('/:id/regenerate-key', authenticate, authorize('admin'), rotateDeviceKey);
router.put('/:id/reactivate', authenticate, authorize('admin'), restoreBin);
router.delete('/:id', authenticate, authorize('admin'), removeBin);
 
export default router;
