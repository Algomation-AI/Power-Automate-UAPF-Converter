# Power-Automate-UAPF-Converter — web service and CLI in one image.
#   docker build -t pa2uapf .
#   docker run -p 8080:8080 pa2uapf                      # web, http://localhost:8080
#   docker run --rm -v "$PWD:/w" pa2uapf node src/cli.js /w/MySolution.zip -o /w/out.uapf
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY web ./web
COPY schemas ./schemas
COPY samples ./samples
ENV NODE_ENV=production PORT=8080 MAX_UPLOAD_MB=10 RATE_PER_MIN=30
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/server.js"]
