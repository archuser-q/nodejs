import * as accountService from '../../services/customer/account.service.js';
import { AppError } from '../../utils/AppError.js';
import { assertId } from '../../services/customer/common.js';

const PHONE_RE = /^0\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cleanEmail = (v) => {
  if (v === undefined) return undefined;
  const email = String(v ?? '').trim().toLowerCase();
  if (!email) return null;
  if (!EMAIL_RE.test(email)) throw new AppError(400, 'Email không hợp lệ');
  return email;
};

const cleanCoord = (v, min, max, label) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < min || n > max) {
    throw new AppError(400, `${label} không hợp lệ`);
  }
  return n;
};

// ── Auth ────────────────────────────────────────────────────────────────────

export const register = async (req, res) => {
  const fullName = req.body?.full_name?.trim();
  const phone = req.body?.phone?.trim();
  const password = req.body?.password ?? '';
  if (!fullName || fullName.length < 2) throw new AppError(400, 'Vui lòng nhập họ tên');
  if (fullName.length > 100) throw new AppError(400, 'Họ tên quá dài');
  if (!PHONE_RE.test(phone ?? '')) throw new AppError(400, 'Số điện thoại phải gồm 10 chữ số, bắt đầu bằng 0');
  if (password.length < 6) throw new AppError(400, 'Mật khẩu phải có ít nhất 6 ký tự');

  const result = await accountService.register({ fullName, phone, email: cleanEmail(req.body?.email) ?? null, password });
  res.status(201).json(result);
};

export const login = async (req, res) => {
  const identifier = (req.body?.identifier ?? req.body?.phone)?.trim();
  const password = req.body?.password;
  if (!identifier || !password) throw new AppError(400, 'Vui lòng nhập số điện thoại và mật khẩu');
  res.json(await accountService.login(identifier, password));
};

export const me = async (req, res) => {
  res.json({ user: req.user });
};

export const updateProfile = async (req, res) => {
  const fullName = req.body?.full_name?.trim();
  if (fullName !== undefined && (fullName.length < 2 || fullName.length > 100)) {
    throw new AppError(400, 'Họ tên phải từ 2 đến 100 ký tự');
  }
  const user = await accountService.updateProfile(req.user.id, { fullName, email: cleanEmail(req.body?.email) });
  res.json({ user });
};

// ── Địa chỉ ─────────────────────────────────────────────────────────────────

export const listAddresses = async (req, res) => {
  res.json(await accountService.listAddresses(req.user.id));
};

export const createAddress = async (req, res) => {
  const addressText = req.body?.address_text?.trim();
  if (!addressText) throw new AppError(400, 'Vui lòng nhập địa chỉ');
  const address = await accountService.createAddress(req.user.id, {
    label: req.body?.label?.trim() || null,
    addressText,
    lat: cleanCoord(req.body?.lat, -90, 90, 'Vĩ độ'),
    lng: cleanCoord(req.body?.lng, -180, 180, 'Kinh độ'),
    isDefault: req.body?.is_default === true,
  });
  res.status(201).json(address);
};

export const updateAddress = async (req, res) => {
  const id = assertId(req.params.id);
  const b = req.body ?? {};
  const data = {};
  if (b.label !== undefined) data.label = b.label?.trim() || null;
  if (b.address_text !== undefined) {
    data.addressText = b.address_text?.trim();
    if (!data.addressText) throw new AppError(400, 'Vui lòng nhập địa chỉ');
  }
  if (b.lat !== undefined || b.lng !== undefined) {
    data.lat = cleanCoord(b.lat, -90, 90, 'Vĩ độ');
    data.lng = cleanCoord(b.lng, -180, 180, 'Kinh độ');
  }
  if (b.is_default !== undefined) data.isDefault = b.is_default === true;
  res.json(await accountService.updateAddress(req.user.id, id, data));
};

export const deleteAddress = async (req, res) => {
  await accountService.deleteAddress(req.user.id, assertId(req.params.id));
  res.json({ message: 'Đã xoá địa chỉ' });
};

// ── Danh mục ────────────────────────────────────────────────────────────────

export const listCategories = async (req, res) => {
  res.json(await accountService.listCategories());
};

export const listServices = async (req, res) => {
  const categoryId = req.query.category_id ? assertId(req.query.category_id, 'Danh mục') : null;
  res.json(await accountService.listServices({ categoryId, search: req.query.search?.trim() }));
};
