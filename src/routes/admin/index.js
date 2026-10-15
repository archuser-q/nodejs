import {Router} from 'express';
import authRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import userRoutes from './user.routes.js'
import { requireAdmin } from '../../middlewares/requireAdmin.js';

const router = Router();

router.use('/admin/auth', authRoutes);
router.use('/admin/dashboard', requireAdmin, dashboardRoutes)
router.use('/admin/users', requireAdmin, userRoutes);

export default router;  