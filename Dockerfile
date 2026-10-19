# Backend THỢ NHANH (Node.js + Express) — dùng chung cho web quản trị, app khách, app thợ
FROM node:22-slim
WORKDIR /app
ENV TZ=Asia/Ho_Chi_Minh NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# migration -> seed demo (SEED_DEMO=true) -> server
CMD ["node", "scripts/docker-start.js"]
