import * as financeService from '../../services/admin/finance.service.js';
import { AppError } from '../../utils/AppError.js';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const paging = (q) => ({
  page: Math.max(1, Number(q.page) || 1),
  pageSize: Math.min(100, Math.max(1, Number(q.pageSize) || 10)),
});
const dates = ({ from, to }) => {
  if (from && !isDate(from)) throw new AppError(400, 'Ngày bắt đầu không hợp lệ');
  if (to && !isDate(to)) throw new AppError(400, 'Ngày kết thúc không hợp lệ');
  if (from && to && from > to) throw new AppError(400, 'Ngày bắt đầu phải trước ngày kết thúc');
  return { from, to };
};

/** GET /admin/finance/transactions?workerId&type&from&to&search */
export const transactions = async (req, res) => {
  const { workerId, type, search } = req.query;
  if (workerId && !/^\d+$/.test(workerId)) throw new AppError(400, 'Mã thợ không hợp lệ');
  if (type && !financeService.TXN_TYPES.includes(type)) throw new AppError(400, 'Loại giao dịch không hợp lệ');
  const p = paging(req.query);
  const result = await financeService.listTransactions({ workerId, type, search: search?.trim(), ...dates(req.query), ...p });
  res.json({ ...result, ...p });
};

/** GET /admin/finance/payments?method&status&from&to&search */
export const payments = async (req, res) => {
  const { method, status, search } = req.query;
  if (method && !financeService.PAYMENT_METHODS.includes(method)) throw new AppError(400, 'Phương thức thanh toán không hợp lệ');
  if (status && !financeService.PAYMENT_STATUSES.includes(status)) throw new AppError(400, 'Trạng thái thanh toán không hợp lệ');
  const p = paging(req.query);
  const result = await financeService.listPayments({ method, status, search: search?.trim(), ...dates(req.query), ...p });
  res.json({ ...result, ...p });
};
