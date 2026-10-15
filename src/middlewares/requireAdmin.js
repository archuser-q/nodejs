import { AppError } from "../utils/AppError.js"
import { AUTH_COOKIE } from "../utils/cookie.js"
import { verifyToken } from "../utils/jwt.js"

export const requireAdmin = async (req, res, next) => {
    const token = req.cookie?.[AUTH_COOKIE]
    if (!token) throw new AppError(401, 'Not logged in')
    
    let payload
    try{
        payload = verifyToken(token)
    } catch{
        throw new AppError(401, 'Session expired, please log in again')
    }

    const {rows} = await query(
        `select id, email, phone, full_name, avatar_url, role, status
        from users where id = $1`,
        [payload.sub],
    )

    const user = rows[0]
    if (!user || user.role === 'admin' || user.status !==  'active'){
        throw new AppError(403, 'You do not have sufficient priviledge')
    }

    req.user = user; 
    next();
}