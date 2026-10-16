import { Router } from 'express';
import * as catalogController from '../../controllers/admin/catalog.controller.js';

const router = Router();

router.get('/', catalogController.listCategories);
router.post('/', catalogController.createCategory);
router.patch('/:id', catalogController.updateCategory);

export default router;