FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV MATCHSTATS_URL=https://matchstats.us.ffesports.com/

EXPOSE 3000

CMD ["npm", "start"]
