import * as complaintService from '../../services/complaint.service.js';
import { AppError } from '../../utils/AppError.js';
import { notify } from '../../services/customer/notify.service.js';

const REPORT_PREFIX = '[Thợ báo cáo] ';
const RESULT = { processing: 'đang được xử lý', resolved: 'đã được giải quyết', rejected: 'đã bị từ chối' };

const STATUSES = ['open', 'processing', 'resolved', 'rejected'];
const TYPES = ['complaint', 'warranty'];
const SOURCES = ['customer', 'worker'];
const isId = (v) => /^\d+$/.test(v);

export const list = async (req, res) => {
  const { search, status, type, source, workerId } = req.query;
  if (workerId && !isId(workerId)) throw new AppError(400, 'Mã thợ không hợp lệ');
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Trạng thái không hợp lệ');
  if (type && !TYPES.includes(type)) throw new AppError(400, 'Loại khiếu nại không hợp lệ');
  if (source && !SOURCES.includes(source)) throw new AppError(400, 'Nguồn khiếu nại không hợp lệ');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await complaintService.listComplaints({ search: search?.trim(), status, type, source, workerId, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const detail = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã khiếu nại không hợp lệ');
  res.json(await complaintService.getComplaintDetail(req.params.id));
};

export const handle = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Mã khiếu nại không hợp lệ');

  const { status } = req.body ?? {};
  const resolution = req.body?.resolution?.trim() || null;
  if (!['processing', 'resolved', 'rejected'].includes(status)) throw new AppError(400, 'Trạng thái không hợp lệ');
  if (status !== 'processing' && !resolution) throw new AppError(400, 'Vui lòng nhập hướng giải quyết');

  const complaint = await complaintService.handleComplaint(req.params.id, req.user.id, status, resolution);

  // Báo kết quả cho người gửi: thợ (báo cáo sự cố từ app thợ) hoặc khách. type 'complaint', bấm vào mở đúng đơn.
  const byWorker = complaint.reporter_id !== null;
  const subject = byWorker
    ? `Báo cáo "${complaint.title.replace(REPORT_PREFIX, '')}"`
    : `Khiếu nại "${complaint.title}"`;
  await notify(Number(byWorker ? complaint.reporter_id : complaint.customer_id), {
    title: `${subject} ${RESULT[status]}`,
    body: complaint.resolution,
    type: 'complaint',
    data: { complaint_id: Number(complaint.id), order_id: Number(complaint.order_id), status },
  }).catch((err) => console.error('notify complaint failed', err));

  res.json({ message: 'Đã cập nhật khiếu nại', complaint: { id: complaint.id, status: complaint.status } });
};