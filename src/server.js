import http from 'http'
import app from './app.js'
import { env } from './config/env.js'
import { initSocket } from './realtime/socket.js'
import { settings } from './config/settings.js'
import { dispatcher } from './services/matching/dispatcher.js'

const server = http.createServer(app)
initSocket(server)

// 0.0.0.0 để điện thoại trong cùng mạng Wi-Fi gọi được
server.listen(env.port, '0.0.0.0', ()=>{
    console.log(`Server running at http://localhost:${env.port}`)
    // [B] Vòng điều phối ghép cặp chạy nền (tắt bằng DISPATCHER_ENABLED=false)
    if (settings.dispatcherEnabled) dispatcher.start()
})

const shutdown = async () => {
    await dispatcher.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
