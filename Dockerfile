FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm i --production

COPY server.js ./

ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]


