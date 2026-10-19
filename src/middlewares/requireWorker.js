import { AppError } from '../utils/AppError.js';
import { authenticate, bearerToken } from './requireCustomer.js';

/** API app thợ: header "Authorization: Bearer <token>" của tài khoản role = worker.  [Thành viên B] */
export const requireWorker = async (req, res, next) => {
  try {
    req.user = await authenticate(bearerToken(req), ['worker']);
  } catch (err) {
    if (err.status === 403) throw new AppError(403, 'Tài khoản này không phải tài khoản thợ');
    throw err;
  }
  next();
};

/** Dùng chung cho app khách và app thợ (VD tải ảnh lên) */
export const requireMobileUser = async (req, res, next) => {
  req.user = await authenticate(bearerToken(req), ['customer', 'worker']);
  next();
};
