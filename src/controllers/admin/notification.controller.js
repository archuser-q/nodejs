import * as notifyService from '../../services/shared/notify.service.js';
import { AppError } from '../../utils/AppError.js';

// Thông báo gửi cho tài khoản admin (VD: "Hồ sơ thợ chờ duyệt", "Thợ cập nhật giấy tờ" từ app thợ)
export const list = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10));
  const unreadOnly = req.query.unread === 'true';
  const [result, count] = await Promise.all([
    notifyService.listNotifications(req.user.id, { unreadOnly, pageSize, offset: (page - 1) * pageSize }),
    notifyService.unreadCount(req.user.id),
  ]);
  res.json({ ...result, page, pageSize, unread: count.unread });
};

export const read = async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Mã thông báo không hợp lệ');
  const n = await notifyService.markRead(req.user.id, req.params.id);
  if (!n) throw new AppError(404, 'Không tìm thấy thông báo');
  res.json(n);
};

export const readAll = async (req, res) => {
  res.json(await notifyService.markAllRead(req.user.id));
};
