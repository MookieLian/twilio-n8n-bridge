FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (handle missing package-lock.json gracefully)
RUN npm install --omit=dev

# Copy source code
COPY server.js ./

# Set environment and expose port
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]


