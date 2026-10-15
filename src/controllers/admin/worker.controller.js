import * as workerService from '../../services/worker.service.js';
import { AppError } from '../../utils/AppError.js';

const STATUSES = ['active', 'locked'];
const VERIFICATIONS = ['pending', 'approved', 'rejected'];

export const list = async (req, res) => {
  const { search, status, verification } = req.query;
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Invalid status');
  if (verification && !VERIFICATIONS.includes(verification)) throw new AppError(400, 'Invalid verification');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await workerService.listWorkers({ search: search?.trim(), status, verification, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const detail = async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Invalid id');
  res.json(await workerService.getWorkerDetail(req.params.id));
};

export const review = async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Invalid id');

  const { status, note } = req.body ?? {};
  if (!['approved', 'rejected'].includes(status)) throw new AppError(400, 'Invalid status');
  if (status === 'rejected' && !note?.trim()) throw new AppError(400, 'Rejection reason is required');

  const worker = await workerService.reviewWorker(req.params.id, req.user.id, status, note?.trim() || null);
  res.json({ message: status === 'approved' ? 'Worker approved' : 'Worker rejected', worker });
};