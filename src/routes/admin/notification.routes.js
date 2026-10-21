import { Router } from 'express';
import * as notificationController from '../../controllers/admin/notification.controller.js';

const router = Router();

router.get('/', notificationController.list);
router.patch('/read-all', notificationController.readAll);
router.patch('/:id/read', notificationController.read);

export default router;
