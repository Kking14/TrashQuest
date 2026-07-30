import express from 'express';
import {
    addBin,
    listBins,
    lookupBinByCode,
    editBin,
    setFillLevel,
    removeBin,
    rotateDeviceKey,
} from '../controller/binController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';
 
const router = express.Router();
 
router.post('/', authenticate, authorize('admin'), addBin);
router.get('/', authenticate, listBins);
router.get('/code/:code', authenticate, lookupBinByCode);
router.put('/:id', authenticate, authorize('admin'), editBin);
router.put('/:id/fill-level', authenticate, authorize('admin'), setFillLevel);
router.put('/:id/regenerate-key', authenticate, authorize('admin'), rotateDeviceKey);
router.delete('/:id', authenticate, authorize('admin'), removeBin);
 
export default router;