import * as authService from '../services/auth.service.js';
import { authCookieOptions, AUTH_COOKIE } from '../utils/cookie.js';
import { AppError } from '../utils/AppError.js';

export const login = async(req, res) => {
    const identifier = req.body?.identifier?.trim();
    const password = req.body?.password;
    if (!identifier || !password) throw new AppError(400, 'Identifier and password are required');
    
    const {token, user} = await authService.loginAdmin(identifier, password);
    res.cookie(AUTH_COOKIE, token, authCookieOptions);
    res.json({
        message: 'Login successful',
        user
    });
}