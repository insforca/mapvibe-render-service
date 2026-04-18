FROM mcr.microsoft.com/playwright:v1.52.0-jammy
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci
RUN npx playwright install chromium --with-deps
COPY src/ ./src/
RUN npx tsc
EXPOSE 3000
# L01: run as non-root
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser
CMD ["node", "dist/server.js"]
