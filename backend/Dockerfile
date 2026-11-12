FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone https://github.com/mosabbir-maruf/Decryptor.git vendor && cd vendor && git checkout 84cadf46729339410f39e64d8010b54839de6659 && npm ci --omit=dev && rm -rf .git && mv src/extractors/nxsha.js src/extractors/nxsha-upstream.js
COPY nxsha-diagnostics.mjs /app/vendor/src/extractors/nxsha.js
COPY server.mjs /app/vendor/watch-server.mjs
RUN node --check /app/vendor/watch-server.mjs && node --check /app/vendor/src/extractors/nxsha.js
ENV NODE_ENV=production PORT=10000
USER node
EXPOSE 10000
CMD ["node", "/app/vendor/watch-server.mjs"]
