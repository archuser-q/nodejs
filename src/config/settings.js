/**
 * Cấu hình của App Thợ + bộ điều phối ghép cặp (Thành viên B).
 * Đọc từ biến môi trường, không có thì dùng giá trị mặc định bên dưới (xem .env.example).
 */
import 'dotenv/config';

const num = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const bool = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};
const str = (key) => process.env[key]?.trim() || null;

export const settings = {
  // ── Thu nhập, ví ─────────────────────────────────────────────────────────
  // Mọi thanh toán đi qua cổng thanh toán (MoMo / VNPay), không nhận tiền mặt:
  // nền tảng giữ tiền -> ví thợ cộng phần thực nhận -> thợ rút về ngân hàng.
  commissionRate: num('COMMISSION_RATE', 0.15), // hoa hồng nền tảng trên tổng tiền đơn
  minWithdrawal: num('MIN_WITHDRAWAL', 50_000),
  // false (mặc định): lệnh rút của thợ chờ admin duyệt ở trang Tài chính; true: duyệt ngay (tiện khi demo một mình)
  withdrawalAutoApprove: bool('WITHDRAWAL_AUTO_APPROVE', false),

  // ── Điều phối đơn ────────────────────────────────────────────────────────
  dispatcherEnabled: bool('DISPATCHER_ENABLED', true),
  dispatcherTickSeconds: num('DISPATCHER_TICK_SECONDS', 2),
  locationMaxAgeMinutes: num('LOCATION_MAX_AGE_MINUTES', 10), // 0 = không kiểm tra độ mới của vị trí
  // Thợ mới duyệt, chưa có đơn / đánh giá nào và chưa được tính điểm tin cậy (trust_score = 0):
  // khi ghép dùng mức trung tính này thay cho 0, để thợ mới không luôn bị xếp cuối (cold start)
  trustColdStart: num('TRUST_COLD_START', 0.5),
  dispatchRetrySeconds: num('DISPATCH_RETRY_SECONDS', 20), // không có ứng viên thì bao lâu thử lại
  dispatchMaxWaitMinutes: num('DISPATCH_MAX_WAIT_MINUTES', 15), // đơn đặt ngay chờ tối đa rồi hệ thống huỷ
  scheduledCancelBeforeMinutes: num('SCHEDULED_CANCEL_BEFORE_MINUTES', 15),
  scheduleConflictMinutes: num('SCHEDULE_CONFLICT_MINUTES', 120), // 2 lịch của 1 thợ phải cách nhau
  scheduleReminderMinutes: num('SCHEDULE_REMINDER_MINUTES', 60),
  busyBeforeScheduleMinutes: 60, // trong 60 phút trước giờ hẹn thợ tính là bận và mới được bắt đầu di chuyển

  // ── Upload ảnh ───────────────────────────────────────────────────────────
  mediaDir: process.env.MEDIA_DIR || 'media',
  publicBaseUrl: str('PUBLIC_BASE_URL'), // VD http://192.168.1.10:3000 — trống thì lấy theo request
  uploadMaxMb: num('UPLOAD_MAX_MB', 8),

  // ── Đăng nhập Google / Facebook ──────────────────────────────────────────
  googleWebClientId: str('GOOGLE_WEB_CLIENT_ID'),
  googleAndroidClientId: str('GOOGLE_ANDROID_CLIENT_ID'),
  googleIosClientId: str('GOOGLE_IOS_CLIENT_ID'),
  facebookAppId: str('FACEBOOK_APP_ID'),
  facebookAppSecret: str('FACEBOOK_APP_SECRET'),

  // ── Email quên mật khẩu ──────────────────────────────────────────────────
  smtpHost: str('SMTP_HOST'),
  smtpPort: num('SMTP_PORT', 587),
  smtpUser: str('SMTP_USER'),
  smtpPassword: str('SMTP_PASSWORD'),
  smtpFrom: str('SMTP_FROM'),
  passwordResetCodeMinutes: num('PASSWORD_RESET_CODE_MINUTES', 15),

  // ── Thông báo đẩy (Expo Push) ────────────────────────────────────────────
  pushEnabled: bool('PUSH_ENABLED', false),
};

export const isProd = process.env.NODE_ENV === 'production';
