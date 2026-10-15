import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_SECRET', 'CLIENT_ORIGIN', 'NODE_ENV', 'PORT', 'JWT_EXPIRES_IN'];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const env = {
  port: process.env.PORT,
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
  clientOrigin: process.env.CLIENT_ORIGIN,
  isProd: process.env.NODE_ENV,
};