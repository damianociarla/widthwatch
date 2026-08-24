FROM node:24-bookworm
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/widthwatch/package.json packages/widthwatch/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev=false && npx playwright install --with-deps chromium
COPY packages/widthwatch packages/widthwatch
COPY apps/api apps/api
RUN npm run build --workspace widthwatch && npm run build --workspace @widthwatch/api && npm prune --omit=dev && chown -R node:node /app /ms-playwright
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]

