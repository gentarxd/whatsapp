FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Copy package files first to leverage Docker's build cache
COPY package*.json ./

# Use 'npm ci' for faster, more reliable installs in production
RUN npm ci --only=production

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# The command to start your application
CMD ["node", "server.js"]
