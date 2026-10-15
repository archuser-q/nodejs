import { env } from '../config/env.js';

export const AUTH_COOKIE = 'access_token';

export const authCookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: env.isProd ? 'none' : 'lax',
  maxAge: 24 * 60 * 60 * 1000,
  path: '/',
};