import * as userService from '../../services/admin/user.service.js';
import { AppError } from '../../utils/AppError.js';

const ROLES = ['customer', 'worker'];
const STATUSES = ['active', 'locked'];

export const list = async (req, res) => {
  const { role = 'customer', search, status } = req.query;
  if (!ROLES.includes(role)) throw new AppError(400, 'Vai trò không hợp lệ');
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Trạng thái không hợp lệ');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await userService.listUsers({ role, search: search?.trim(), status, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const updateStatus = async (req, res) => {
  const { status } = req.body ?? {};
  if (!STATUSES.includes(status)) throw new AppError(400, 'Trạng thái không hợp lệ');

  const user = await userService.updateUserStatus(req.params.id, status);
  res.json({ message: status === 'locked' ? 'Đã khoá tài khoản' : 'Đã mở khoá tài khoản', user });
};

export const detail = async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Mã không hợp lệ');
  res.json(await userService.getUserDetail(req.params.id));
};