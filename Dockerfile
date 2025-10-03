FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

# تعيين environment variable للـ PORT بشكل افتراضي
ENV PORT=3000

EXPOSE 3000

# استخدام node مباشرة
CMD ["node", "server.js"]
