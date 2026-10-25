import * as orderService from '../../services/customer/order.service.js';
import * as interaction from '../../services/customer/interaction.service.js';
import * as notifyService from '../../services/customer/notify.service.js';
import { AppError } from '../../utils/AppError.js';
import { assertId, pagination } from '../../services/customer/common.js';
import * as v from '../../utils/validate.js';

const GROUPS = ['active', 'completed', 'cancelled'];
<<<<<<< HEAD
const MODES = ['instant', 'batch'];
=======
>>>>>>> origin/staging-customer-api
// [B] Nền tảng không nhận tiền mặt: mọi đơn trả qua cổng thanh toán để thu hoa hồng và trả thợ minh bạch
const METHODS = ['momo', 'vnpay'];

const text = (v, { label, max, required = true }) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw new AppError(400, `Vui lòng nhập ${label}`);
  if (s.length > max) throw new AppError(400, `${label[0].toUpperCase()}${label.slice(1)} tối đa ${max} ký tự`);
  return s || null;
};

// ── Đơn hàng ────────────────────────────────────────────────────────────────

/** Lịch hẹn phải cách hiện tại ít nhất ngần này phút (đặt gấp thì chọn "làm ngay") */
const MIN_LEAD_MINUTES = 60;
const MAX_IMAGES = 6;
/**
 * Khung giờ nhận lịch hẹn theo giờ VN, VD "7-21" = 07:00 đến 21:00. Đặt BOOKING_HOURS= (rỗng) để bỏ giới hạn.
 * Chỉ áp dụng cho đơn hẹn giờ; đơn "làm ngay" (sự cố điện khẩn) đặt được bất cứ lúc nào.
 */
const BOOKING_HOURS = (() => {
  const raw = process.env.BOOKING_HOURS ?? '7-21';
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null;
})();

const vnHourMinute = (d) => {
  const vn = new Date(d.getTime() + 7 * 3600_000);
  return vn.getUTCHours() * 60 + vn.getUTCMinutes();
};

export const create = async (req, res) => {
  const b = req.body ?? {};
  // Khách không chọn chế độ ghép: hệ thống tự chọn theo cấu hình admin (trường matching_mode gửi lên bị bỏ qua)
  if (!req.user.phone) {
    throw new AppError(400, 'Vui lòng cập nhật số điện thoại trong Tài khoản để thợ liên hệ được trước khi đặt đơn');
  }

  let scheduledAt = null;
  if (b.scheduled_at) {
    const t = new Date(b.scheduled_at);
    if (Number.isNaN(t.getTime())) throw new AppError(400, 'Giờ hẹn không hợp lệ');
    if (t.getTime() < Date.now() + MIN_LEAD_MINUTES * 60_000) {
      throw new AppError(400, `Giờ hẹn phải sau thời điểm hiện tại ít nhất ${MIN_LEAD_MINUTES} phút. Cần thợ gấp thì chọn "Làm ngay"`);
    }
    if (t.getTime() > Date.now() + 30 * 86400_000) throw new AppError(400, 'Chỉ đặt lịch trước tối đa 30 ngày');
    if (BOOKING_HOURS) {
      const m = vnHourMinute(t);
      if (m < BOOKING_HOURS.from * 60 || m > BOOKING_HOURS.to * 60) {
        throw new AppError(400, `Chỉ nhận lịch hẹn từ ${BOOKING_HOURS.from}:00 đến ${BOOKING_HOURS.to}:00`);
      }
    }
    scheduledAt = t.toISOString();
  }

  let imageUrls = [];
  if (b.image_urls !== undefined && b.image_urls !== null) {
    if (!Array.isArray(b.image_urls)) throw new AppError(400, 'Danh sách ảnh không hợp lệ');
    if (b.image_urls.length > MAX_IMAGES) throw new AppError(400, `Gửi tối đa ${MAX_IMAGES} ảnh tình trạng`);
    imageUrls = b.image_urls.map((u) => v.url(u, 'đường dẫn ảnh'));
  }

  const order = await orderService.createOrder(req.user.id, {
    serviceId: assertId(b.service_id, 'Dịch vụ'),
    addressId: assertId(b.address_id, 'Địa chỉ'),
    description: text(b.description, { label: 'mô tả', max: 1000, required: false }),
    scheduledAt,
    imageUrls,
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

/** POST /orders/:id/messages { content?, image_url? } — gửi chữ, ảnh hoặc cả hai */
export const sendMessage = async (req, res) => {
  const b = req.body ?? {};
  const content = text(b.content, { label: 'nội dung', max: 1000, required: false });
  const imageUrl = b.image_url ? v.url(b.image_url, 'ảnh') : null;
  if (!content && !imageUrl) throw new AppError(400, 'Vui lòng nhập nội dung hoặc chọn ảnh');
  res.status(201).json(await interaction.sendMessage(req.user.id, assertId(req.params.id), content, imageUrl));
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
