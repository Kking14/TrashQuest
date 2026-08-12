import express from 'express';
import {
    addQuest,
    listQuests,
    listAvailableQuests,
    joinAQuest,
    endQuest,
    editQuest,
    removeQuest,
} from '../controller/questController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';
 
const router = express.Router();
 
router.post('/', authenticate, authorize('admin'), addQuest);
router.get('/', authenticate, authorize('admin'), listQuests);
router.get('/available', authenticate, listAvailableQuests);
router.put('/:id/join', authenticate, joinAQuest);
router.put('/:id/close', authenticate, authorize('admin'), endQuest);
router.put('/:id', authenticate, authorize('admin'), editQuest);
router.delete('/:id', authenticate, authorize('admin'), removeQuest);
 
export default router;
