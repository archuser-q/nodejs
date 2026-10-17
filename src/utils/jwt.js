import jwt from 'jsonwebtoken';
import {env} from '../config/env.js';

export const signToken = (payload, expiresIn = env.jwtExpiresIn) =>
    jwt.sign(payload, env.jwtSecret, {
        expiresIn
    });

export const verifyToken = (token) => 
    jwt.verify(token, env.jwtSecret);
