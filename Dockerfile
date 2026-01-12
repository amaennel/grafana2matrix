FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["node", "src/index.js"]
