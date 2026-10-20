# ---- 构建阶段：编译 TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
# 编译需要 typescript，临时装上再删
RUN npm install --no-save --ignore-scripts typescript@5.7 && \
    npm run build && \
    rm -rf node_modules/typescript

# ---- 运行阶段：只带生产依赖和编译产物 ----
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8848 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

VOLUME /app/data
EXPOSE 8848
CMD ["node", "dist/server.js"]
