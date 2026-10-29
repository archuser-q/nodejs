/**
 * Xác minh token đăng nhập Google / Facebook ở phía server.  [Thành viên B]
 *
 * App lấy token từ Google/Facebook (expo-auth-session) rồi gửi lên; backend KHÔNG tin thông tin app
 * gửi kèm mà tự hỏi lại Google/Facebook xem token có thật và có đúng ứng dụng của mình không.
 */
import { settings } from '../../config/settings.js';
import { AppError } from '../../utils/AppError.js';

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export const googleClientIds = () =>
  [settings.googleWebClientId, settings.googleAndroidClientId, settings.googleIosClientId].filter(Boolean);

export const facebookEnabled = () => !!(settings.facebookAppId && settings.facebookAppSecret);

async function getJson(url, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError(503, 'Không kết nối được máy chủ đăng nhập, thử lại sau');
  }
  if (res.status >= 400) throw new AppError(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
  return res.json();
}

/** @returns {{provider, providerUserId, email, emailVerified, fullName, avatarUrl}} */
export async function verifyGoogle({ idToken, accessToken }) {
  const allowed = googleClientIds();
  if (!allowed.length) throw new AppError(503, 'Máy chủ chưa cấu hình đăng nhập Google');
  if (!idToken && !accessToken) throw new AppError(400, 'Thiếu token Google');

  let info;
  let profile;
  if (idToken) {
    info = await getJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!allowed.includes(info.aud)) throw new AppError(401, 'Token Google không thuộc ứng dụng này');
    if (!GOOGLE_ISSUERS.has(info.iss)) throw new AppError(401, 'Token Google không hợp lệ');
    profile = info;
  } else {
    info = await getJson(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!allowed.includes(info.aud) && !allowed.includes(info.azp)) throw new AppError(401, 'Token Google không thuộc ứng dụng này');
    profile = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', { Authorization: `Bearer ${accessToken}` });
  }
  const sub = profile.sub || info.sub;
  if (!sub) throw new AppError(401, 'Không đọc được tài khoản Google');
  return {
    provider: 'google',
    providerUserId: String(sub),
    email: (profile.email || '').toLowerCase() || null,
    emailVerified: String(profile.email_verified ?? info.email_verified ?? '').toLowerCase() === 'true',
    fullName: profile.name || null,
    avatarUrl: profile.picture || null,
  };
}

export async function verifyFacebook({ accessToken }) {
  if (!facebookEnabled()) throw new AppError(503, 'Máy chủ chưa cấu hình đăng nhập Facebook');
  if (!accessToken) throw new AppError(400, 'Facebook cần access_token');
  const appToken = `${settings.facebookAppId}|${settings.facebookAppSecret}`;
  const debug = await getJson(
    `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appToken)}`,
  );
  const data = debug.data ?? {};
  if (!data.is_valid || String(data.app_id) !== String(settings.facebookAppId)) {
    throw new AppError(401, 'Token Facebook không thuộc ứng dụng này');
  }
  const me = await getJson(
    `https://graph.facebook.com/me?fields=id,name,email,picture.width(256).height(256)&access_token=${encodeURIComponent(accessToken)}`,
  );
  return {
    provider: 'facebook',
    providerUserId: String(me.id),
    email: (me.email || '').toLowerCase() || null,
    emailVerified: !!me.email, // Facebook chỉ trả email đã xác minh
    fullName: me.name || null,
    avatarUrl: me.picture?.data?.url || null,
  };
}
