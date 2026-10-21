import * as accountService from '../../services/customer/account.service.js';
import * as auth from '../../services/customer/auth.service.js';
import * as push from '../../services/push.service.js';
import { AppError } from '../../utils/AppError.js';
import * as v from '../../utils/validate.js';
import { assertId } from '../../services/customer/common.js';

const body = (req) => req.body ?? {};

const cleanCoord = (val, min, max, label) => {
  const n = Number(val);
  if (val === null || val === undefined || val === '' || !Number.isFinite(n) || n < min || n > max) {
    throw new AppError(400, `${label} không hợp lệ`);
  }
  return n;
};

// ── Đăng nhập / tài khoản ───────────────────────────────────────────────────

/** POST /auth/register { full_name, email?, phone?, password } — cần ít nhất email hoặc SĐT */
export const register = async (req, res) => {
  const b = body(req);
  const email = v.email(b.email, { required: false });
  const phone = v.phone(b.phone, { required: false });
  if (!email && !phone) throw new AppError(400, 'Vui lòng nhập email');
  const result = await auth.register({
    fullName: v.text(b.full_name, 'họ tên', { min: 2, max: 100 }),
    email,
    phone,
    password: v.password(b.password),
  });
  res.status(201).json(result);
};

/** POST /auth/login { identifier, password } — identifier là email hoặc SĐT */
export const login = async (req, res) => {
  const b = body(req);
  const identifier = String(b.identifier ?? b.email ?? b.phone ?? '').trim();
  if (!identifier || !b.password) throw new AppError(400, 'Vui lòng nhập email/số điện thoại và mật khẩu');
  res.json(await auth.login(identifier, String(b.password)));
};

export const providers = (req, res) => res.json(auth.providers());

export const google = async (req, res) => {
  const b = body(req);
  res.json(await auth.socialLogin('google', { idToken: b.id_token || null, accessToken: b.access_token || null }));
};

export const facebook = async (req, res) => {
  res.json(await auth.socialLogin('facebook', { accessToken: body(req).access_token || null }));
};

export const forgotPassword = async (req, res) => {
  res.json(await auth.forgotPassword(v.email(body(req).email)));
};

export const resetPassword = async (req, res) => {
  const b = body(req);
  if (!/^\d{6}$/.test(String(b.code ?? ''))) throw new AppError(400, 'Mã xác nhận gồm 6 chữ số');
  await auth.resetPassword(v.email(b.email), String(b.code), v.password(b.new_password, 'mật khẩu mới'));
  res.json({ message: 'Đặt lại mật khẩu thành công, hãy đăng nhập bằng mật khẩu mới' });
};

export const changePassword = async (req, res) => {
  const b = body(req);
  await auth.changePassword(req.user.id, b.old_password ?? null, v.password(b.new_password, 'mật khẩu mới'));
  res.json({ message: 'Đổi mật khẩu thành công' });
};

/** GET /auth/me — kèm has_password để app biết có cần hỏi mật khẩu cũ khi đổi mật khẩu */
export const me = async (req, res) => {
  res.json({ user: req.user, has_password: await auth.hasPassword(req.user.id) });
};

/** PATCH /profile { full_name?, email?, phone?, avatar_url? } */
export const updateProfile = async (req, res) => {
  const b = body(req);
  const data = {};
  if (b.full_name !== undefined) data.fullName = v.text(b.full_name, 'họ tên', { min: 2, max: 100 });
  if (b.email !== undefined) data.email = v.email(b.email, { required: false });
  if (b.phone !== undefined) data.phone = v.phone(b.phone, { required: false });
  if (b.avatar_url !== undefined) data.avatarUrl = b.avatar_url ? v.url(b.avatar_url, 'ảnh đại diện') : null;
  const user = await accountService.updateProfile(req.user.id, data);
  res.json({ user });
};

// ── Thiết bị nhận thông báo đẩy (Expo Push) ─────────────────────────────────

export const registerDevice = async (req, res) => {
  const b = body(req);
  await push.registerDevice(req.user.id, v.text(b.token, 'token', { max: 255 }), v.oneOf(b.platform, ['android', 'ios', 'web'], 'nền tảng'));
  res.status(201).json({ message: 'Đã đăng ký thiết bị' });
};

export const removeDevice = async (req, res) => {
  await push.removeDevice(req.user.id, String(req.params.token ?? ''));
  res.json({ message: 'Đã gỡ thiết bị' });
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
