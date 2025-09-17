# Gunakan Node.js versi ringan
FROM node:18-alpine

# Set workdir
WORKDIR /usr/src/app

# Copy package.json dan package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy semua file source
COPY . .

# Expose port 3000
EXPOSE 3000

# Jalankan server
CMD ["npm", "start"]
