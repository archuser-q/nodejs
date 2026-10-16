import { Router } from 'express';
import * as matchingController from '../../controllers/admin/matching.controller.js';

const router = Router();

router.get('/', matchingController.list);
router.post('/', matchingController.create);
router.put('/:id', matchingController.update);
router.post('/:id/activate', matchingController.activate);
router.delete('/:id', matchingController.remove);
router.get('/', matchingController.list);
router.post('/simulate', matchingController.simulate);

export default router;