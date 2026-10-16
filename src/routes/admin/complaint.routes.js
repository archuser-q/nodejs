import { Router } from 'express';
import * as complaintController from '../../controllers/admin/complaint.controller.js';

const router = Router();

router.get('/', complaintController.list);
router.get('/:id', complaintController.detail);
router.patch('/:id', complaintController.handle);

export default router;