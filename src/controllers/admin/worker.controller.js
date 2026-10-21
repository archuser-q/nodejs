import * as workerService from '../../services/worker.service.js';
import { AppError } from '../../utils/AppError.js';
import { notify } from '../../services/customer/notify.service.js'; // [B] báo kết quả duyệt cho app thợ

const STATUSES = ['active', 'locked'];
const VERIFICATIONS = ['pending', 'approved', 'rejected'];
const isId = (v) => /^\d+$/.test(v);

export const list = async (req, res) => {
  const { search, status, verification, review } = req.query;
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Trạng thái tài khoản không hợp lệ');
  if (verification && !VERIFICATIONS.includes(verification)) throw new AppError(400, 'Trạng thái hồ sơ không hợp lệ');
  if (review && review !== 'needed') throw new AppError(400, 'Bộ lọc duyệt không hợp lệ');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await workerService.listWorkers({ search: search?.trim(), status, verification, review, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const detail = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã thợ không hợp lệ');
  res.json(await workerService.getWorkerDetail(req.params.id));
};

export const review = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã thợ không hợp lệ');

  const { status, note } = req.body ?? {};
  if (!['approved', 'rejected'].includes(status)) throw new AppError(400, 'Kết quả duyệt không hợp lệ');
  if (status === 'rejected' && !note?.trim()) throw new AppError(400, 'Vui lòng nhập lý do từ chối');

  const worker = await workerService.reviewWorker(req.params.id, req.user.id, status, note?.trim() || null);
  // [B] Thông báo cho thợ (app thợ mở màn giấy tờ / hồ sơ khi bấm vào)
  await notify(worker.id, status === 'approved'
    ? { title: 'Hồ sơ đã được duyệt', body: 'Bạn có thể bật nhận đơn ngay bây giờ.', type: 'verification', data: { status } }
    : { title: 'Hồ sơ chưa được duyệt', body: note.trim(), type: 'verification', data: { status } },
  ).catch((err) => console.error('notify verification failed', err));
  res.json({ message: status === 'approved' ? 'Đã duyệt hồ sơ thợ' : 'Đã từ chối hồ sơ thợ', worker });
};

/** PATCH /admin/workers/:id/documents/:docId  { status: approved|rejected, reject_reason? } */
export const reviewDocument = async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.docId)) throw new AppError(400, 'Mã không hợp lệ');

  const { status } = req.body ?? {};
  const reason = req.body?.reject_reason?.trim() || null;
  if (!['approved', 'rejected'].includes(status)) throw new AppError(400, 'Kết quả duyệt không hợp lệ');
  if (status === 'rejected' && !reason) throw new AppError(400, 'Vui lòng nhập lý do từ chối giấy tờ');
  if (reason && reason.length > 500) throw new AppError(400, 'Lý do tối đa 500 ký tự');

  const result = await workerService.reviewDocument(req.params.id, req.params.docId, req.user.id, status, reason);

  // Hồ sơ đang chờ duyệt: chưa báo, đợi admin chốt cả hồ sơ (tránh thợ nhận nhiều thông báo lẻ).
  // Thợ đã được duyệt và gửi giấy tờ mới: kết quả của giấy đó là kết quả cuối cùng -> báo ngay.
  if (result.verification_status === 'approved') {
    await notify(Number(req.params.id), status === 'approved'
      ? { title: `${result.label} đã được duyệt`, body: 'Giấy tờ mới của bạn đã được cập nhật.', type: 'verification', data: { status: 'approved', document_id: Number(result.document.id) } }
      : { title: `${result.label} chưa được duyệt`, body: reason, type: 'verification', data: { status: 'rejected', document_id: Number(result.document.id) } },
    ).catch((err) => console.error('notify document review failed', err));
  }

  res.json({ message: status === 'approved' ? `Đã duyệt ${result.label}` : `Đã từ chối ${result.label}`, document: result.document });
};

const paging = (q, def = 10) => ({
  page: Math.max(1, Number(q.page) || 1),
  pageSize: Math.min(100, Math.max(1, Number(q.pageSize) || def)),
});

/** GET /admin/workers/:id/orders?group=active|completed|cancelled */
export const orders = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã thợ không hợp lệ');
  const group = req.query.group ?? 'completed';
  if (!['active', 'completed', 'cancelled'].includes(group)) throw new AppError(400, 'Nhóm đơn không hợp lệ');
  const p = paging(req.query);
  res.json({ ...(await workerService.listWorkerOrders(req.params.id, { group, ...p })), ...p });
};

/** GET /admin/workers/:id/reviews?rating=1..5 */
export const reviews = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã thợ không hợp lệ');
  const rating = req.query.rating ? Number(req.query.rating) : null;
  if (rating !== null && ![1, 2, 3, 4, 5].includes(rating)) throw new AppError(400, 'Số sao phải từ 1 đến 5');
  const p = paging(req.query);
  res.json({ ...(await workerService.listWorkerReviews(req.params.id, { rating, ...p })), ...p });
};
