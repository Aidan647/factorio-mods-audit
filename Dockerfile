FROM oven/bun:latest
LABEL authors="Traineratwot"

WORKDIR /app

copy . /app
RUN bun install --frozen-lockfile

expose 3000

ENTRYPOINT ["bun", "run", "serve"]
