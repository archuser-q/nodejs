/** Kiểm tra dữ liệu đầu vào cho API app thợ — báo lỗi 400 bằng câu tiếng Việt hiển thị được ngay.  [B] */
import { AppError } from './AppError.js';

const bad = (msg) => new AppError(400, msg);

export const PHONE_RE = /^0\d{9}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Chuỗi: trim, bắt buộc / tuỳ chọn, độ dài. Trả về null nếu rỗng và không bắt buộc. */
export function text(v, label, { min = 1, max = 255, required = true } = {}) {
  const s = typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
  if (!s) {
    if (required) throw bad(`Vui lòng nhập ${label}`);
    return null;
  }
  if (s.length < min) throw bad(`${cap(label)} tối thiểu ${min} ký tự`);
  if (s.length > max) throw bad(`${cap(label)} tối đa ${max} ký tự`);
  return s;
}

export function int(v, label, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Thiếu ${label}`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${cap(label)} phải là số nguyên`);
  if (n < min || n > max) throw bad(`${cap(label)} phải từ ${fmt(min)} đến ${fmt(max)}`);
  return n;
}

export function number(v, label, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Thiếu ${label}`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${cap(label)} không hợp lệ`);
  return n;
}

export function oneOf(v, values, label) {
  if (!values.includes(v)) throw bad(`${cap(label)} không hợp lệ`);
  return v;
}

export function email(v, { required = true } = {}) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) {
    if (required) throw bad('Vui lòng nhập email');
    return null;
  }
  if (!EMAIL_RE.test(s) || s.length > 255) throw bad('Email không hợp lệ');
  return s;
}

export function phone(v, { required = true } = {}) {
  const s = String(v ?? '').replace(/[\s.]/g, '');
  if (!s) {
    if (required) throw bad('Vui lòng nhập số điện thoại');
    return null;
  }
  if (!PHONE_RE.test(s)) throw bad('Số điện thoại phải gồm 10 chữ số, bắt đầu bằng 0');
  return s;
}

/**
 * Mật khẩu: 8–72 ký tự, có cả chữ và số, không nằm trong danh sách mật khẩu quá phổ biến.
 * Không bắt chữ hoa / ký tự đặc biệt (theo NIST SP 800-63B: luật "phức tạp" làm người dùng đặt mật khẩu
 * dễ đoán theo mẫu và hay quên; độ dài + chặn mật khẩu phổ biến hiệu quả hơn).
 */
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '11111111', '00000000', '88888888', '12341234', '87654321',
  'password', 'password1', 'password123', 'matkhau', 'matkhau1', 'matkhau123', 'abc12345', 'abcd1234',
  'qwerty123', 'qwertyui', 'iloveyou', 'admin123', 'thonhanh', 'thonhanh1', 'thonhanh123', '123456aa',
  'a1234567', '1234567a', 'aa123456', '1qaz2wsx',
]);

export function password(v, label = 'mật khẩu') {
  const s = typeof v === 'string' ? v : '';
  if (s.length < 8) throw bad(`${cap(label)} tối thiểu 8 ký tự`);
  if (s.length > 72) throw bad(`${cap(label)} tối đa 72 ký tự`);
  if (!/\p{L}/u.test(s) || !/\d/.test(s)) throw bad(`${cap(label)} phải có cả chữ và số`);
  if (COMMON_PASSWORDS.has(s.toLowerCase())) throw bad(`${cap(label)} quá phổ biến, dễ bị đoán. Hãy chọn mật khẩu khác`);
  return s;
}

export function url(v, label = 'đường dẫn ảnh') {
  const s = text(v, label, { min: 5, max: 500 });
  if (!/^https?:\/\//i.test(s)) throw bad(`${cap(label)} không hợp lệ`);
  return s;
}

export function id(v, label = 'id') {
  if (!/^\d+$/.test(String(v ?? ''))) throw bad(`${label} không hợp lệ`);
  return Number(v);
}

/** page/pageSize theo quy ước chung của nhóm ({ items, total, page, pageSize }) */
export function paging(q, defaultSize = 20) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('vi-VN') : n);
