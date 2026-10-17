import { AppError } from '../utils/AppError.js';
import { verifyToken } from '../utils/jwt.js';
import { q as query } from '../config/db.js';

export const USER_FIELDS = 'id, email, phone, full_name, avatar_url, role, status, created_at';

/** Lấy token từ header "Authorization: Bearer <token>" (app di động không dùng cookie) */
export const bearerToken = (req) => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/** Kiểm tra token và trả về user (dùng chung cho REST và WebSocket) */
export const authenticate = async (token, roles = ['customer']) => {
  if (!token) throw new AppError(401, 'Bạn chưa đăng nhập');

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new AppError(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
  }

  const { rows } = await query(`SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [payload.sub]);
  const user = rows[0];
  if (!user || user.status !== 'active') throw new AppError(401, 'Tài khoản không còn hoạt động');
  if (!roles.includes(user.role)) throw new AppError(403, 'Tài khoản này không phải tài khoản khách hàng');
  return user;
};

export const requireCustomer = async (req, res, next) => {
  req.user = await authenticate(bearerToken(req));
  next();
};
