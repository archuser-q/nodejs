import * as reportService from '../../services/report.service.js';
import { AppError } from '../../utils/AppError.js';

const GROUPS = { day: 92, week: 366, month: 1100 };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
const daysAgo = (n) => {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export const report = async (req, res) => {
  const { groupBy = 'day' } = req.query;
  const to = req.query.to ?? today();
  const from = req.query.from ?? daysAgo(29);

  if (!GROUPS[groupBy]) throw new AppError(400, 'groupBy must be day, week or month');
  if (!isDate(from) || !isDate(to)) throw new AppError(400, 'Invalid date');
  if (from > to) throw new AppError(400, 'from must be before to');

  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > GROUPS[groupBy]) {
    throw new AppError(400, `Range too long for groupBy=${groupBy} (max ${GROUPS[groupBy]} days)`);
  }

  res.json({ from, to, groupBy, ...(await reportService.getReport({ from, to, groupBy })) });
};