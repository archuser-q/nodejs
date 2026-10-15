import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import {env} from './config/env.js'
import routes from './routes/admin/index.js'

import { NotFound, ErrorHandler } from './middlewares/ErrorHandler.js'

const app = express()

app.use(cors({
    origin: env.clientOrigin,
    credentials:  true
}));
app.use(cookieParser());
app.use(express.json());

app.use('/api', routes);

app.use(NotFound);
app.use(ErrorHandler);

export default app;