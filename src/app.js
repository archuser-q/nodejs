import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import {env} from './config/env.js'
import routes from './routes/admin/index.js'
import customerRoutes from './routes/customer/index.js'

import { NotFound, ErrorHandler } from './middlewares/ErrorHandler.js'

const app = express()

app.use(cors({
    // CLIENT_ORIGIN có thể ghi nhiều địa chỉ, cách nhau dấu phẩy (app di động không gửi Origin nên không bị chặn)
    origin: env.clientOrigin.split(',').map((o) => o.trim()),
    credentials:  true
}));
app.use(cookieParser());
app.use(express.json());

app.use('/api', routes);
app.use('/api/customer', customerRoutes);
// Công cụ giả lập thợ để test app khách (thư mục dev-tools, không bắt buộc).
// Chỉ nạp ngoài production; xoá thư mục dev-tools thì server vẫn chạy bình thường.
if (!env.isProd) {
    try {
        const { default: devRoutes } = await import('../dev-tools/dev.routes.js');
        app.use('/api/dev', devRoutes);
    } catch (err) {
        if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
}

app.use(NotFound);
app.use(ErrorHandler);

export default app;
