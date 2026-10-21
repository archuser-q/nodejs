import { Router } from 'express';
import * as workerController from '../../controllers/admin/worker.controller.js';

const router = Router();

router.get('/', workerController.list);
router.get('/:id', workerController.detail);
router.patch('/:id/verification', workerController.review);
router.patch('/:id/documents/:docId', workerController.reviewDocument);

export default router;
