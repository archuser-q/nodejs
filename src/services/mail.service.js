/** Gửi email (mã đặt lại mật khẩu). Chưa cấu hình SMTP thì chỉ ghi ra log.  [Thành viên B] */
import nodemailer from 'nodemailer';
import { settings } from '../config/worker.js';

export const smtpConfigured = () => !!(settings.smtpHost && settings.smtpFrom);

let transporter = null;

export async function sendEmail(to, subject, text) {
  if (!smtpConfigured()) {
    console.log(`[mail] (chưa cấu hình SMTP) tới ${to}: ${subject}`);
    return false;
  }
  transporter ??= nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPassword } : undefined,
  });
  try {
    await transporter.sendMail({ from: settings.smtpFrom, to, subject, text });
    return true;
  } catch (err) {
    console.error('[mail] gửi thất bại', err.message);
    return false;
  }
}
