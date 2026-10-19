/**
 * Đăng ký / đăng nhập App Thợ: email + mật khẩu, Google, Facebook, quên mật khẩu.  [Thành viên B]
 * Token giống app khách: JWT { sub, role } gửi qua header "Authorization: Bearer <token>".
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool, q, sql } from '../../config/db.js';
import { env } from '../../config/env.js';
import { isProd, settings } from '../../config/worker.js';
import { AppError } from '../../utils/AppError.js';
import { signToken } from '../../utils/jwt.js';
import { transaction } from '../../utils/tx.js';
import { USER_FIELDS } from '../../middlewares/requireCustomer.js';
import { sendEmail, smtpConfigured } from '../mail.service.js';
import { facebookEnabled, googleClientIds, verifyFacebook, verifyGoogle } from './social.js';

const ROLE_LABEL = { customer: 'khách hàng', worker: 'thợ', admin: 'quản trị' };
const MAX_RESET_ATTEMPTS = 5;
const RESET_COOLDOWN_SECONDS = 60;

const issue = (user, extra = {}) => ({
  token: signToken({ sub: String(user.id), role: user.role }, env.mobileJwtExpiresIn),
  user,
  ...extra,
});

const strip = ({ password_hash, google_id, facebook_id, ...user }) => user;

const checkUsable = (user) => {
  if (user.status !== 'active') throw new AppError(403, 'Tài khoản đã bị khoá, vui lòng liên hệ CSKH');
  if (user.role !== 'worker') {
    throw new AppError(403, `Đây là tài khoản ${ROLE_LABEL[user.role] ?? user.role}, không dùng được cho app thợ`);
  }
};

const findByEmail = async (db, email) =>
  (await sql(db, `SELECT ${USER_FIELDS}, password_hash, google_id, facebook_id FROM users WHERE lower(email) = lower($1)`, [email]))
    .rows[0];

async function createWorker(db, { fullName, email = null, phone = null, password = null, avatarUrl = null, googleId = null, facebookId = null }) {
  const hash = password ? await bcrypt.hash(password, 10) : null;
  const { rows } = await sql(
    db,
    `INSERT INTO users (email, phone, password_hash, full_name, avatar_url, role, google_id, facebook_id, last_login_at)
     VALUES ($1, $2, $3, $4, $5, 'worker', $6, $7, NOW())
     RETURNING ${USER_FIELDS}`,
    [email, phone, hash, fullName, avatarUrl, googleId, facebookId],
  );
  await sql(db, 'INSERT INTO workers (user_id) VALUES ($1)', [rows[0].id]);
  return rows[0];
}

// ── Email + mật khẩu ────────────────────────────────────────────────────────

export async function register({ fullName, email, phone, password }) {
  if (await findByEmail(pool, email)) throw new AppError(409, 'Email đã được đăng ký');
  if (phone && (await q('SELECT 1 FROM users WHERE phone = $1', [phone])).rows.length) {
    throw new AppError(409, 'Số điện thoại đã được đăng ký');
  }
  const user = await transaction((db) => createWorker(db, { fullName, email, phone, password }));
  return issue(user);
}

export async function login(identifier, password) {
  const byEmail = identifier.includes('@');
  const { rows } = await q(
    `SELECT ${USER_FIELDS}, password_hash, google_id, facebook_id FROM users
     WHERE ${byEmail ? 'lower(email) = lower($1)' : 'phone = $1'} LIMIT 1`,
    [identifier],
  );
  const user = rows[0];
  const wrong = byEmail ? 'Sai email hoặc mật khẩu' : 'Sai số điện thoại hoặc mật khẩu';
  if (user && !user.password_hash && (user.google_id || user.facebook_id)) {
    const names = [user.google_id && 'Google', user.facebook_id && 'Facebook'].filter(Boolean).join(' / ');
    throw new AppError(401, `Tài khoản này đăng nhập bằng ${names}. Bấm nút ${names} để đăng nhập.`);
  }
  if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) throw new AppError(401, wrong);
  checkUsable(user);
  // Tài khoản thợ tạo từ nơi khác (VD admin, script) mà chưa có hồ sơ thợ: tạo bù
  await q('INSERT INTO workers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
  await q('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
  return issue(strip(user));
}

export async function changePassword(userId, oldPassword, newPassword) {
  const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const hash = rows[0]?.password_hash;
  // Tài khoản Google/Facebook chưa có mật khẩu thì được đặt mới không cần mật khẩu cũ
  if (hash && !(oldPassword && (await bcrypt.compare(oldPassword, hash)))) {
    throw new AppError(400, 'Mật khẩu cũ không đúng');
  }
  await q('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [userId, await bcrypt.hash(newPassword, 10)]);
}

// ── Google / Facebook ───────────────────────────────────────────────────────

export const providers = () => ({
  google: googleClientIds().length
    ? {
        web_client_id: settings.googleWebClientId,
        android_client_id: settings.googleAndroidClientId,
        ios_client_id: settings.googleIosClientId,
      }
    : null,
  facebook: facebookEnabled() ? { app_id: settings.facebookAppId } : null,
  password_reset_by_email: true,
  smtp_configured: smtpConfigured(),
});

export async function socialLogin(provider, tokens) {
  const profile = provider === 'google' ? await verifyGoogle(tokens) : await verifyFacebook(tokens);
  const col = provider === 'google' ? 'google_id' : 'facebook_id';

  const result = await transaction(async (db) => {
    let { rows } = await sql(db, `SELECT ${USER_FIELDS}, password_hash, google_id, facebook_id FROM users WHERE ${col} = $1`, [
      profile.providerUserId,
    ]);
    let user = rows[0];
    let isNew = false;
    if (!user) {
      // Email đã xác minh trùng tài khoản có sẵn -> liên kết vào tài khoản đó
      user = profile.email && profile.emailVerified ? await findByEmail(db, profile.email) : null;
      if (user) {
        checkUsable(user);
        await sql(db, `UPDATE users SET ${col} = $2, avatar_url = COALESCE(avatar_url, $3), updated_at = NOW() WHERE id = $1`, [
          user.id,
          profile.providerUserId,
          profile.avatarUrl,
        ]);
      } else {
        // Bảng users bắt buộc có email hoặc SĐT (CHECK của nhóm)
        if (!profile.email || !profile.emailVerified) {
          throw new AppError(400, `Tài khoản ${provider === 'google' ? 'Google' : 'Facebook'} chưa có email đã xác minh, hãy đăng ký bằng email`);
        }
        user = await createWorker(db, {
          fullName: (profile.fullName || (profile.email || 'Thợ mới').split('@')[0]).slice(0, 100),
          email: profile.email,
          avatarUrl: profile.avatarUrl,
          [provider === 'google' ? 'googleId' : 'facebookId']: profile.providerUserId,
        });
        isNew = true;
      }
    }
    checkUsable(user);
    await sql(db, 'INSERT INTO workers (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    await sql(db, 'UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    const { rows: fresh } = await sql(db, `SELECT ${USER_FIELDS} FROM users WHERE id = $1`, [user.id]);
    return { user: fresh[0], isNew };
  });
  return issue(result.user, { is_new: result.isNew });
}

// ── Quên mật khẩu (mã 6 số qua email) ───────────────────────────────────────

export async function forgotPassword(email) {
  const generic = `Nếu email đã đăng ký, mã xác nhận gồm 6 chữ số đã được gửi tới hộp thư (hiệu lực ${settings.passwordResetCodeMinutes} phút)`;
  const user = await findByEmail(pool, email);
  if (!user || user.status !== 'active') return { message: generic };

  const { rows: last } = await q(
    `SELECT EXTRACT(EPOCH FROM NOW() - created_at) AS ago FROM password_reset_codes
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  if (last[0] && last[0].ago < RESET_COOLDOWN_SECONDS) throw new AppError(429, 'Vui lòng chờ 1 phút rồi gửi lại mã');

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await transaction(async (db) => {
    await sql(db, 'UPDATE password_reset_codes SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await sql(
      db,
      `INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
      [user.id, await bcrypt.hash(code, 10), settings.passwordResetCodeMinutes],
    );
  });
  await sendEmail(
    user.email,
    '[Thợ Nhanh] Mã đặt lại mật khẩu',
    `Xin chào ${user.full_name},\n\nMã đặt lại mật khẩu của bạn là: ${code}\n` +
      `Mã có hiệu lực trong ${settings.passwordResetCodeMinutes} phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.\n\nThợ Nhanh`,
  );
  // Môi trường dev chưa có SMTP: trả mã về để thử (không bao giờ trả khi chạy production)
  return !isProd && !smtpConfigured() ? { message: generic, debug_code: code } : { message: generic };
}

export async function resetPassword(email, code, newPassword) {
  const invalid = new AppError(400, 'Mã xác nhận không đúng hoặc đã hết hạn');
  const user = await findByEmail(pool, email);
  if (!user) throw invalid;
  const ok = await transaction(async (db) => {
    const { rows } = await sql(
      db,
      `SELECT id, code_hash, attempts, expires_at < NOW() AS expired FROM password_reset_codes
       WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id],
    );
    const rec = rows[0];
    if (!rec || rec.expired || rec.attempts >= MAX_RESET_ATTEMPTS) return false;
    if (!(await bcrypt.compare(code, rec.code_hash))) {
      await sql(db, 'UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = $1', [rec.id]);
      return false;
    }
    await sql(db, 'UPDATE password_reset_codes SET used_at = NOW() WHERE id = $1', [rec.id]);
    await sql(db, 'UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [user.id, await bcrypt.hash(newPassword, 10)]);
    return true;
  });
  if (!ok) throw invalid;
}
