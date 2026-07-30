import express from 'express';
import { listUsers, getUser, editUser, removeUser } from '../controller/userController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';

const router = express.Router();

router.get('/', authenticate, authorize('admin'), listUsers);
router.get('/:id', authenticate, authorize('admin'), getUser);
router.put('/:id', authenticate, authorize('admin'), editUser);
router.delete('/:id', authenticate, authorize('admin'), removeUser);

export default router;