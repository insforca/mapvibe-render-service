# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
RUN npx playwright install chromium --with-deps
COPY src/ ./src/
RUN npx tsc
EXPOSE 3000
CMD ["node", "dist/server.js"]
