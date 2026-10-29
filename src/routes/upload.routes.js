/**
 * Tải ảnh lên (dùng chung app thợ / app khách): giấy tờ thợ, ảnh trước/sau, ảnh chat, ảnh đại diện.  [Thành viên B]
 *
 *   POST /api/uploads   multipart/form-data, trường "file"   ->   201 { url, path, size, content_type }
 *
 * Ảnh lưu ở MEDIA_DIR (Docker: volume "media"), phục vụ tại /media/... ; tên file là chuỗi ngẫu nhiên
 * nên không đoán được đường dẫn. Định dạng nhận theo vài byte đầu của file (không tin Content-Type client gửi).
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { settings } from '../config/settings.js';
import { AppError } from '../utils/AppError.js';
import { requireMobileUser } from '../middlewares/requireWorker.js';

export const MEDIA_ROOT = path.resolve(settings.mediaDir);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: settings.uploadMaxMb * 1024 * 1024, files: 1 } });

function detect(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heif'].includes(buf.toString('ascii', 8, 12))) {
    return 'heic';
  }
  return null;
}

/** Địa chỉ công khai của API để ghép URL ảnh (PUBLIC_BASE_URL, không có thì theo request) */
export const publicBase = (req) => (settings.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** Lưu 1 buffer ảnh vào thư mục media, trả về đường dẫn tương đối YYYY/MM/<uuid>.<ext> */
export async function saveImage(buf, ext) {
  const now = new Date();
  const rel = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID().replaceAll('-', '')}.${ext}`;
  const dest = path.join(MEDIA_ROOT, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return rel;
}

const router = Router();

router.post(
  '/',
  requireMobileUser,
  (req, res, next) =>
    upload.single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, `Ảnh tối đa ${settings.uploadMaxMb} MB`));
      if (err) return next(new AppError(400, 'Tệp gửi lên không hợp lệ'));
      next();
    }),
  async (req, res) => {
    if (!req.file) throw new AppError(400, 'Thiếu tệp ảnh (trường "file")');
    const ext = detect(req.file.buffer);
    if (!ext) throw new AppError(400, 'Chỉ nhận ảnh JPG, PNG, WEBP hoặc HEIC');
    const rel = await saveImage(req.file.buffer, ext);
    res.status(201).json({ url: `${publicBase(req)}/media/${rel}`, path: rel, size: req.file.size, content_type: `image/${ext}` });
  },
);

export default router;
