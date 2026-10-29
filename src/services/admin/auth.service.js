import bcrypt from 'bcrypt';
import { query } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { signToken } from '../../utils/jwt.js';

export const loginAdmin = async(identifier, password)=>{ 
    const {rows} = await  query (
        `select id, email, phone, full_name, avatar_url, role, status, password_hash
        from users
        where email = $1 or phone = $1
        limit 1`,
        [identifier],
    );
    const user = rows[0];

    const ok = user?.password_hash && (await bcrypt.compare(password, user.password_hash))
    if (!ok) throw new AppError(401, 'Sai email/số điện thoại hoặc mật khẩu');
    if (user.role !== 'admin') throw new AppError(403, 'Bạn không có quyền truy cập trang quản trị');
    if (user.status !== 'active') throw new AppError(403, 'Tài khoản đang bị khoá');

    await query('update users set last_login_at = now() where id = $1', [user.id]);

    const token = signToken({sub: String(user.id), role: user.role});
    const { password_hash, ...safeUser} = user;
    return {token, user: safeUser};
} 