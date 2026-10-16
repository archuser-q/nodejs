import { Router } from 'express';
import * as orderController from '../../controllers/admin/order.controller.js';

const router = Router();

router.get('/', orderController.list);
router.get('/:id', orderController.detail);
router.post('/:id/cancel', orderController.cancel);

export default router;