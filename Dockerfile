FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium
COPY . .
ENV PORT=10000
ENV POLL_MS=1
EXPOSE 10000
CMD ["node","server.js"]
