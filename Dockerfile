FROM node:22
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p /app/auth_info
ENV AUTH_FOLDER=/app/auth_info
EXPOSE 3000
CMD ["node", "server.js"]
