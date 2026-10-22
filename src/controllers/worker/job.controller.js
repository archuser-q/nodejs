/** App thợ: lời mời nhận đơn, đơn của tôi, ảnh, báo giá, thu tiền, báo cáo sự cố, chat.  [B] */
import * as jobs from '../../services/worker/job.service.js';
import * as chat from '../../services/customer/interaction.service.js';
import { AppError } from '../../utils/AppError.js';
import * as v from '../../utils/validate.js';

const body = (req) => req.body ?? {};
const orderId = (req) => v.id(req.params.id, 'Mã đơn');

// ── Offer ───────────────────────────────────────────────────────────────────

export const currentOffer = async (req, res) => res.json(await jobs.currentOffer(req.user.id));

export const acceptOffer = async (req, res) => res.json(await jobs.acceptOffer(req.user.id, v.id(req.params.offerId, 'Lời mời')));

export const rejectOffer = async (req, res) => {
  const reason = v.text(body(req).reason, 'lý do', { max: 255, required: false });
  await jobs.rejectOffer(req.user.id, v.id(req.params.offerId, 'Lời mời'), reason);
  res.json({ message: 'Đã bỏ qua đơn' });
};

// ── Đơn của tôi ─────────────────────────────────────────────────────────────

export const list = async (req, res) => {
  const group = req.query.group ?? 'active';
  if (!jobs.JOB_GROUPS[group]) throw new AppError(400, 'Nhóm đơn không hợp lệ');
  const p = v.paging(req.query);
  res.json({ ...(await jobs.listJobs(req.user.id, group, p)), page: p.page, pageSize: p.pageSize });
};

export const detail = async (req, res) => res.json(await jobs.jobDetail(req.user.id, orderId(req)));

export const advance = async (req, res) => {
  const b = body(req);
  const status = v.oneOf(b.status, ['on_the_way', 'arrived', 'in_progress', 'completed'], 'trạng thái');
  res.json(await jobs.advanceStatus(req.user.id, orderId(req), status, b.safety_confirmed === true));
};

export const cancel = async (req, res) => {
  res.json(await jobs.cancelJob(req.user.id, orderId(req), v.text(body(req).reason, 'lý do huỷ', { min: 3, max: 500 })));
};

export const addPhotos = async (req, res) => {
  const b = body(req);
  const kind = v.oneOf(b.kind, ['before', 'after'], 'loại ảnh');
  if (!Array.isArray(b.urls) || !b.urls.length || b.urls.length > 6) throw new AppError(400, 'Gửi từ 1 đến 6 ảnh mỗi lần');
  res.status(201).json(await jobs.addPhotos(req.user.id, orderId(req), kind, b.urls.map((u) => v.url(u))));
};

export const deletePhoto = async (req, res) => {
  res.json(await jobs.deletePhoto(req.user.id, orderId(req), v.id(req.params.photoId, 'Ảnh')));
};

export const createQuote = async (req, res) => {
  const b = body(req);
  const description = v.text(b.description, 'nội dung báo giá', { min: 3, max: 1000 });
  const amount = v.int(b.amount, 'số tiền', { min: 1000, max: 50_000_000 });
  res.status(201).json(await jobs.createQuote(req.user.id, orderId(req), description, amount));
};

export const cancelQuote = async (req, res) => {
  res.json(await jobs.cancelQuote(req.user.id, orderId(req), v.id(req.params.quoteId, 'Báo giá')));
};

export const report = async (req, res) => {
  const b = body(req);
  const reason = v.text(b.reason, 'lý do', { min: 3, max: 150 });
  const description = v.text(b.description, 'mô tả', { max: 2000, required: false });
  res.status(201).json(await jobs.createReport(req.user.id, orderId(req), reason, description));
};

export const reports = async (req, res) => {
  const p = v.paging(req.query);
  res.json({ ...(await jobs.listReports(req.user.id, p)), page: p.page, pageSize: p.pageSize });
};

// ── Chat (dùng chung dịch vụ chat của app khách) ────────────────────────────

const mine = (userId) => (m) => ({ ...m, is_mine: Number(m.sender_id) === Number(userId) });

export const listMessages = async (req, res) => {
  const beforeId = req.query.before_id ? v.id(req.query.before_id) : null;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = await chat.listMessages(req.user.id, orderId(req), { beforeId, limit });
  res.json(rows.map(mine(req.user.id)));
};

export const sendMessage = async (req, res) => {
  const b = body(req);
  const content = v.text(b.content, 'nội dung', { max: 1000, required: false });
  const imageUrl = b.image_url ? v.url(b.image_url, 'ảnh') : null;
  if (!content && !imageUrl) throw new AppError(400, 'Vui lòng nhập nội dung hoặc chọn ảnh');
  const m = await chat.sendMessage(req.user.id, orderId(req), content, imageUrl);
  res.status(201).json(mine(req.user.id)(m));
};

export const markMessagesRead = async (req, res) => res.json(await chat.markMessagesRead(req.user.id, orderId(req)));
