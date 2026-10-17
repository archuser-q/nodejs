import http from 'http'
import app from './app.js'
import { env } from './config/env.js'
import { initSocket } from './realtime/socket.js'

const server = http.createServer(app)
initSocket(server)

// 0.0.0.0 để điện thoại trong cùng mạng Wi-Fi gọi được
server.listen(env.port, '0.0.0.0', ()=>{
    console.log(`Server running at http://localhost:${env.port}`)
})
