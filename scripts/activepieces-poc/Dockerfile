FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
WORKDIR /pilot
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY *.mjs LICENSE.activepieces ./
USER node
CMD ["node", "demo.mjs"]
