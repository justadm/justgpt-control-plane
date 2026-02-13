FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# docker-cli-compose provides `docker compose ...`
RUN apk add --no-cache docker-cli docker-cli-compose nginx ca-certificates
# Host nginx.conf часто использует user www-data; создаем его в контейнере для nginx -t/reload.
RUN addgroup -S www-data >/dev/null 2>&1 || true \
    && adduser -S -D -H -G www-data www-data >/dev/null 2>&1 || true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
