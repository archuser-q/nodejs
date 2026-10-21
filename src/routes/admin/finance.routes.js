import { Router } from 'express';
import * as financeController from '../../controllers/admin/finance.controller.js';

const router = Router();

router.get('/transactions', financeController.transactions);
router.get('/payments', financeController.payments);

export default router;
