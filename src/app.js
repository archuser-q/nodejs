import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import {env} from './config/env.js'
import routes from './routes/admin/index.js'
import customerRoutes from './routes/customer/index.js'
// [B] App thợ + tải ảnh dùng chung
import workerRoutes from './routes/worker/index.js'
import uploadRoutes, { MEDIA_ROOT } from './routes/upload.routes.js'

import { NotFound, ErrorHandler } from './middlewares/ErrorHandler.js'

const app = express()

const allowedOrigins = env.clientOrigin.split(',').map((o) => o.trim())
// [B] CORS_ORIGIN_REGEX (tuỳ chọn): cho bản web của app chạy trên IP LAN bất kỳ, VD ^http://192\.168\.\d+\.\d+:\d+$
const originRegex = process.env.CORS_ORIGIN_REGEX ? new RegExp(process.env.CORS_ORIGIN_REGEX) : null
app.use(cors({
    // CLIENT_ORIGIN có thể ghi nhiều địa chỉ, cách nhau dấu phẩy (app di động không gửi Origin nên không bị chặn)
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin) || !!originRegex?.test(origin)),
    credentials:  true
}));
app.use(cookieParser());
app.use(express.json());

app.use('/api', routes);
app.use('/api/customer', customerRoutes);
app.use('/api/worker', workerRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/media', express.static(MEDIA_ROOT, { maxAge: '7d' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use(NotFound);
app.use(ErrorHandler);

export default app;
