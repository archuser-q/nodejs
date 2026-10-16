import * as orderService from '../../services/order.service.js';
import { AppError } from '../../utils/AppError.js';

const STATUSES = ['pending', 'matching', 'accepted', 'on_the_way', 'arrived', 'in_progress', 'completed', 'cancelled'];
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isId = (v) => /^\d+$/.test(v);

export const list = async (req, res) => {
  const { search, status, from, to } = req.query;
  if (status && !STATUSES.includes(status)) throw new AppError(400, 'Invalid status');
  if (from && !isDate(from)) throw new AppError(400, 'Invalid from date');
  if (to && !isDate(to)) throw new AppError(400, 'Invalid to date');

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const result = await orderService.listOrders({ search: search?.trim(), status, from, to, page, pageSize });
  res.json({ ...result, page, pageSize });
};

export const detail = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Invalid id');
  res.json(await orderService.getOrderDetail(req.params.id));
};

export const cancel = async (req, res) => {
  if (!isId(req.params.id)) throw new AppError(400, 'Invalid id');
  const reason = req.body?.reason?.trim();
  if (!reason) throw new AppError(400, 'Cancel reason is required');

  await orderService.cancelOrder(req.params.id, req.user.id, reason);
  res.json({ message: 'Order cancelled' });
};