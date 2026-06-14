# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:alpine AS base
WORKDIR /app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy production dependencies and source code into final image
FROM base AS release
COPY . .
COPY --from=install /temp/prod/node_modules node_modules

# Runtime config — override via docker -e
ENV DATA_DIR=./data
ENV DISABLE_CLAMAV=true
ENV DISABLE_DISK_CACHE=false
ENV CACHE_EXPIRY_MS=86400000
ENV WS_LOG=true

# run the app
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "serve", "--port", "3000", "--host", "0.0.0.0" ]
