import { Router } from 'express';
import * as userController from '../../controllers/admin/user.controller.js';

const router = Router();

router.get('/', userController.list);
router.patch('/:id/status', userController.updateStatus);

export default router;