import { Router } from 'express';
import * as monitorController from '../../controllers/admin/monitor.controller.js';

const router = Router();

router.get('/map', monitorController.map);

export default router;
