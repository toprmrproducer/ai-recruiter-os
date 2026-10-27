FROM node:22-slim
WORKDIR /app
# pdftotext (poppler) reads uploaded PDF resumes
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY *.js ./
COPY public ./public
COPY dograh ./dograh
COPY demo ./demo
COPY scripts ./scripts
ENV PORT=4870 DB_PATH=/data/recruiting.db
VOLUME /data
EXPOSE 4870
CMD ["node", "--experimental-sqlite", "--no-warnings", "server.js"]
