FROM oven/bun:latest
LABEL authors="Traineratwot"

WORKDIR /app

copy . /app
RUN bun install --frozen-lockfile

expose 3000

# Runtime config — override via docker -e
ENV DATA_DIR=./data
ENV DISABLE_CLAMAV=true
ENV DISABLE_DISK_CACHE=false
ENV CACHE_EXPIRY_MS=86400000

ENTRYPOINT ["bun", "run", "serve"]
