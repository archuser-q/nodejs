import {Router} from 'express';

import { requireAdmin } from '../../middlewares/requireAdmin.js';

import authRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import userRoutes from './user.routes.js';
import workerRoutes from './worker.routes.js';
import categoryRoutes from './category.routes.js';
import serviceRoutes from './service.routes.js';
import orderRoutes from './order.routes.js';
import complaintRoutes from './complaint.routes.js';
import reportRoutes from './report.routes.js';
import matchingRoutes from './matching.routes.js';
import { dispatchRoutes, withdrawalRoutes } from './dispatch.routes.js'; // [B] bộ điều phối + rút tiền của thợ

const router = Router();

router.use('/admin/auth', authRoutes);
router.use('/admin/dashboard', requireAdmin, dashboardRoutes)
router.use('/admin/users', requireAdmin, userRoutes);
router.use('/admin/workers', requireAdmin, workerRoutes);
router.use('/admin/categories', requireAdmin, categoryRoutes);
router.use('/admin/services', requireAdmin, serviceRoutes);
router.use('/admin/orders', requireAdmin, orderRoutes);
router.use('/admin/complaints', requireAdmin, complaintRoutes);
router.use('/admin/reports', requireAdmin, reportRoutes);
router.use('/admin/matching-configs', requireAdmin, matchingRoutes);
router.use('/admin/dispatch', requireAdmin, dispatchRoutes);
router.use('/admin/withdrawals', requireAdmin, withdrawalRoutes);

export default router;  