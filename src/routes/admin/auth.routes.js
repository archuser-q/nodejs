import {Router} from 'express';
import * as authController from '../../controllers/admin/auth.controller.js';
import { requireAdmin } from '../../middlewares/requireAdmin.js';

const router = Router();

router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/me', requireAdmin, authController.me);

export default router;