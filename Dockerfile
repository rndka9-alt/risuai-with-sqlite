FROM node:20-slim AS builder
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY --from=builder /app/dist ./dist
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "dist/server.js"]
