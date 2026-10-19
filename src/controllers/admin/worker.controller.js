import * as workerService from '../../services/worker.service.js';
import { AppError } from '../../utils/AppError.js';
import { notify } from '../../services/customer/notify.service.js'; // [B] báo kết quả duyệt cho app thợ

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
  // [B] Thông báo cho thợ (app thợ mở màn giấy tờ / hồ sơ khi bấm vào)
  await notify(worker.id, status === 'approved'
    ? { title: 'Hồ sơ đã được duyệt', body: 'Bạn có thể bật nhận đơn ngay bây giờ.', type: 'verification', data: { status } }
    : { title: 'Hồ sơ chưa được duyệt', body: note.trim(), type: 'verification', data: { status } },
  ).catch((err) => console.error('notify verification failed', err));
  res.json({ message: status === 'approved' ? 'Worker approved' : 'Worker rejected', worker });
};