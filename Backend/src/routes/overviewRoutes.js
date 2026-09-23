import express from 'express';
import { showAdminOverview } from '../controller/overviewController.js';
import authenticate from '../middleware/authenticate.js';
import authorize from '../middleware/authorizeRoles.js';

const router = express.Router();

router.get('/', authenticate, authorize('admin'), showAdminOverview);

export default router;
