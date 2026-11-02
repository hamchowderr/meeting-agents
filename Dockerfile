# Meeting agents: Mastra server (Hono) plus the web app, for Coolify.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV MASTRA_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production MASTRA_TELEMETRY_DISABLED=1 PORT=4111 HOST=0.0.0.0 WEB_DIST=/app/web/dist
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/web/dist ./web/dist
EXPOSE 4111
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||4111)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".mastra/output/index.mjs"]
