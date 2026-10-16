import { Router } from 'express';
import * as reportController from '../../controllers/admin/report.controller.js';

const router = Router();

router.get('/', reportController.report);

export default router;