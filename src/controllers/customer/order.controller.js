import * as orderService from '../../services/customer/order.service.js';
import * as interaction from '../../services/customer/interaction.service.js';
import * as notifyService from '../../services/customer/notify.service.js';
import { AppError } from '../../utils/AppError.js';
import { assertId, pagination } from '../../services/customer/common.js';

const GROUPS = ['active', 'completed', 'cancelled'];
const MODES = ['instant', 'batch'];
// [B] Nền tảng không nhận tiền mặt: mọi đơn trả qua cổng thanh toán để thu hoa hồng và trả thợ minh bạch
const METHODS = ['momo', 'vnpay'];

const text = (v, { label, max, required = true }) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw new AppError(400, `Vui lòng nhập ${label}`);
  if (s.length > max) throw new AppError(400, `${label[0].toUpperCase()}${label.slice(1)} tối đa ${max} ký tự`);
  return s || null;
};

// ── Đơn hàng ────────────────────────────────────────────────────────────────

export const create = async (req, res) => {
  const b = req.body ?? {};
  const matchingMode = b.matching_mode ?? 'instant';
  if (!MODES.includes(matchingMode)) throw new AppError(400, 'Chế độ ghép thợ không hợp lệ');

  let scheduledAt = null;
  if (b.scheduled_at) {
    const t = new Date(b.scheduled_at);
    if (Number.isNaN(t.getTime())) throw new AppError(400, 'Giờ hẹn không hợp lệ');
    if (t.getTime() < Date.now() - 60_000) throw new AppError(400, 'Giờ hẹn phải sau thời điểm hiện tại');
    if (t.getTime() > Date.now() + 30 * 86400_000) throw new AppError(400, 'Chỉ đặt lịch trước tối đa 30 ngày');
    scheduledAt = t.toISOString();
  }

  const order = await orderService.createOrder(req.user.id, {
    serviceId: assertId(b.service_id, 'Dịch vụ'),
    addressId: assertId(b.address_id, 'Địa chỉ'),
    description: text(b.description, { label: 'mô tả', max: 1000, required: false }),
    scheduledAt,
    matchingMode,
  });
  res.status(201).json(order);
};

export const list = async (req, res) => {
  const { group } = req.query;
  if (group && !GROUPS.includes(group)) throw new AppError(400, 'Nhóm đơn không hợp lệ');
  const p = pagination(req.query);
  const result = await orderService.listOrders(req.user.id, { group, ...p });
  res.json({ ...result, page: p.page, pageSize: p.pageSize });
};

export const detail = async (req, res) => {
  res.json(await orderService.getOrderDetail(req.user.id, assertId(req.params.id)));
};

export const cancel = async (req, res) => {
  const reason = text(req.body?.reason, { label: 'lý do huỷ', max: 255 });
  res.json(await orderService.cancelOrder(req.user.id, assertId(req.params.id), reason));
};

export const tracking = async (req, res) => {
  res.json(await orderService.getTracking(req.user.id, assertId(req.params.id)));
};

export const respondQuote = (approve) => async (req, res) => {
  res.json(await orderService.respondQuote(
    req.user.id, assertId(req.params.id), assertId(req.params.quoteId, 'Báo giá'), approve,
  ));
};

// ── Chat ────────────────────────────────────────────────────────────────────

export const listMessages = async (req, res) => {
  const beforeId = req.query.before_id ? assertId(req.query.before_id) : null;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json(await interaction.listMessages(req.user.id, assertId(req.params.id), { beforeId, limit }));
};

export const sendMessage = async (req, res) => {
  const content = text(req.body?.content, { label: 'nội dung', max: 1000 });
  res.status(201).json(await interaction.sendMessage(req.user.id, assertId(req.params.id), content));
};

export const markMessagesRead = async (req, res) => {
  res.json(await interaction.markMessagesRead(req.user.id, assertId(req.params.id)));
};

// ── Thanh toán ──────────────────────────────────────────────────────────────

export const createPayment = async (req, res) => {
  const method = req.body?.method;
  if (method === 'cash') throw new AppError(400, 'Thợ Nhanh không nhận tiền mặt, vui lòng thanh toán qua MoMo hoặc VNPay'); // [B]
  if (!METHODS.includes(method)) throw new AppError(400, 'Phương thức thanh toán không hợp lệ');
  res.status(201).json(await interaction.createPayment(req.user.id, assertId(req.params.id), method));
};

export const sandboxConfirm = async (req, res) => {
  res.json(await interaction.sandboxConfirm(req.user.id, assertId(req.params.id)));
};

export const listPayments = async (req, res) => {
  const p = pagination(req.query, 20);
  const result = await interaction.listMyPayments(req.user.id, p);
  res.json({ ...result, page: p.page, pageSize: p.pageSize });
};

// ── Đánh giá / khiếu nại / bảo hành ─────────────────────────────────────────

export const createReview = async (req, res) => {
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError(400, 'Số sao phải từ 1 đến 5');
  const comment = text(req.body?.comment, { label: 'nhận xét', max: 1000, required: false });
  res.status(201).json(await interaction.createReview(req.user.id, assertId(req.params.id), rating, comment));
};

export const listReviews = async (req, res) => {
  const p = pagination(req.query, 20);
  const result = await interaction.listMyReviews(req.user.id, p);
  res.json({ ...result, page: p.page, pageSize: p.pageSize });
};

export const createComplaint = async (req, res) => {
  const title = text(req.body?.title, { label: 'tiêu đề', max: 200 });
  const content = text(req.body?.content, { label: 'nội dung', max: 2000 });
  res.status(201).json(await interaction.createComplaint(req.user.id, assertId(req.params.id), title, content));
};

export const claimWarranty = async (req, res) => {
  const content = text(req.body?.content, { label: 'mô tả lỗi', max: 2000 });
  res.status(201).json(await interaction.claimWarranty(req.user.id, assertId(req.params.id), content));
};

export const listComplaints = async (req, res) => {
  res.json(await interaction.listMyComplaints(req.user.id));
};

export const workerProfile = async (req, res) => {
  res.json(await interaction.getWorkerPublic(assertId(req.params.id)));
};

// ── Thông báo ───────────────────────────────────────────────────────────────

export const listNotifications = async (req, res) => {
  const p = pagination(req.query, 20);
  const result = await notifyService.listNotifications(req.user.id, {
    unreadOnly: req.query.unread_only === 'true', ...p,
  });
  res.json({ ...result, page: p.page, pageSize: p.pageSize });
};

export const unreadCount = async (req, res) => {
  res.json(await notifyService.unreadCount(req.user.id));
};

export const markNotificationRead = async (req, res) => {
  const n = await notifyService.markRead(req.user.id, assertId(req.params.id));
  if (!n) throw new AppError(404, 'Không tìm thấy thông báo');
  res.json(n);
};

export const markAllNotificationsRead = async (req, res) => {
  res.json(await notifyService.markAllRead(req.user.id));
};
