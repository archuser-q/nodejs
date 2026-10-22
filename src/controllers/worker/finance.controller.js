/** App thợ: thu nhập, ví, rút/nạp tiền, đánh giá, hiệu suất.  [B] */
import * as finance from '../../services/worker/finance.service.js';
import * as v from '../../utils/validate.js';

export const earningsSummary = async (req, res) => {
  const period = v.oneOf(req.query.period ?? 'week', ['today', 'week', 'month'], 'kỳ thống kê');
  res.json(await finance.earningsSummary(req.user.id, period));
};

export const earnings = async (req, res) => {
  const p = v.paging(req.query);
  res.json({ ...(await finance.earningsHistory(req.user.id, p)), page: p.page, pageSize: p.pageSize });
};

export const wallet = async (req, res) => res.json(await finance.wallet(req.user.id));

export const transactions = async (req, res) => {
  const p = v.paging(req.query, 30);
  res.json({ ...(await finance.transactions(req.user.id, p)), page: p.page, pageSize: p.pageSize });
};

export const withdraw = async (req, res) => {
  const amount = v.int(req.body?.amount, 'số tiền', { min: 1, max: 100_000_000 });
  res.status(201).json(await finance.createWithdrawal(req.user.id, amount));
};

export const withdrawals = async (req, res) => {
  const p = v.paging(req.query);
  res.json({ ...(await finance.listWithdrawals(req.user.id, p)), page: p.page, pageSize: p.pageSize });
};

export const reviews = async (req, res) => {
  const rating = req.query.rating ? v.int(req.query.rating, 'số sao', { min: 1, max: 5 }) : null;
  const p = v.paging(req.query);
  res.json({ ...(await finance.reviews(req.user.id, rating, p)), page: p.page, pageSize: p.pageSize });
};

export const performance = async (req, res) => res.json(await finance.performance(req.user.id));
