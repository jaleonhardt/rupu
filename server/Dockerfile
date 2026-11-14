FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "--no-warnings", "src/server.js"]
