FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm i --production

COPY server.js ./

ENV PORT=80 HOST=0.0.0.0
EXPOSE 80

CMD ["node", "server.js"]


