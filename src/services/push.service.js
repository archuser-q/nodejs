/**
 * Thông báo đẩy qua Expo Push (app thợ / app khách bản build có đăng ký token).  [Thành viên B]
 * Tắt mặc định (PUSH_ENABLED=false): Expo Go không nhận được push, thông báo trong app vẫn đủ dùng.
 */
import { q } from '../config/db.js';
import { settings } from '../config/worker.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function registerDevice(userId, token, platform) {
  await q(
    `INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform`,
    [userId, token, platform],
  );
}

export async function removeDevice(userId, token) {
  await q('DELETE FROM device_tokens WHERE user_id = $1 AND token = $2', [userId, token]);
}

/** Gửi push cho mọi thiết bị của user. Không chặn luồng chính: lỗi chỉ ghi log. */
export async function sendPush(userId, { title, body, data }) {
  if (!settings.pushEnabled) return;
  try {
    const { rows } = await q("SELECT token FROM device_tokens WHERE user_id = $1 AND token LIKE 'ExponentPushToken%'", [userId]);
    if (!rows.length) return;
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(rows.map((r) => ({ to: r.token, title, body: body ?? undefined, data: data ?? {}, sound: 'default', priority: 'high' }))),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('[push]', err.message);
  }
}
