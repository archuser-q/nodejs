/** Gọi API THỢ NHANH từ script (demo-customer, worker-bots). Mặc định http://localhost:<PORT>, đổi bằng API_URL. */
import 'dotenv/config';

export const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function call(method, path, { token, body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, `Không kết nối được API ${API} (server đã chạy chưa?)`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.message ?? `Lỗi ${res.status}`);
  return json;
}

export const login = async (scope, identifier, password = '12345678') =>
  (await call('POST', `/api/${scope}/auth/login`, { body: { identifier, password } })).token;

export const money = (n) => `${Math.round(Number(n) || 0).toLocaleString('vi-VN')}đ`;

/** Điểm cách (lat, lng) khoảng distM mét theo hướng ngẫu nhiên */
export function offset(lat, lng, distM) {
  const b = Math.random() * 2 * Math.PI;
  return [lat + (distM * Math.cos(b)) / 111_320, lng + (distM * Math.sin(b)) / (111_320 * Math.cos((lat * Math.PI) / 180))];
}

export function km(lat1, lng1, lat2, lng2) {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Đọc tham số dòng lệnh dạng --ten gia_tri / --co */
export function parseArgs(argv, defaults = {}) {
  const out = { _: [], ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
