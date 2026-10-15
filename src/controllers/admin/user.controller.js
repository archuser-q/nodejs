import * as userService from '../../services/user.service.js';
import { AppError } from '../../utils/AppError.js';

const ROLES = ['customer', 'worker'];
const STATUSES = ['active', 'locked'];

export const list = async (req, res) => {
  const { role = 'customer', search, status } = req.query;
  if (!ROLES.includes(role)) throw new AppError(400, 'Invalid role');
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Invalid status');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await userService.listUsers({ role, search: search?.trim(), status, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const updateStatus = async (req, res) => {
  const { status } = req.body ?? {};
  if (!STATUSES.includes(status)) throw new AppError(400, 'Invalid status');

  const user = await userService.updateUserStatus(req.params.id, status);
  res.json({ message: status === 'locked' ? 'Account locked' : 'Account unlocked', user });
};