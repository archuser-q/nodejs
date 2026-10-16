import { Router } from 'express';
import * as catalogController from '../../controllers/admin/catalog.controller.js';

const router = Router();

router.get('/', catalogController.listServices);
router.post('/', catalogController.createService);
router.patch('/:id', catalogController.updateService);

export default router;