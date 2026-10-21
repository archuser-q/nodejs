import { AppError } from "../utils/AppError.js"
import { AUTH_COOKIE } from "../utils/cookie.js"
import { verifyToken } from "../utils/jwt.js"
import { query } from "../config/db.js"

export const requireAdmin = async (req, res, next) => {
    const token = req.cookies?.[AUTH_COOKIE]
    if (!token) throw new AppError(401, 'Bạn chưa đăng nhập')
    
    let payload
    try{
        payload = verifyToken(token)
    } catch{
        throw new AppError(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại')
    }

    const {rows} = await query(
        `select id, email, phone, full_name, avatar_url, role, status
        from users where id = $1`,
        [payload.sub],
    )

    const user = rows[0]
    if (!user || user.role !== 'admin' || user.status !==  'active'){
        throw new AppError(403, 'Bạn không có quyền truy cập trang quản trị')
    }

    req.user = user; 
    next();
}