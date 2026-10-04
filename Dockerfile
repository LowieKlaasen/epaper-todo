# Use the same Node version as your Angular build for consistency
ARG NODE_VERSION=24.12.0-alpine

FROM node:${NODE_VERSION}

# Set environment to production
ENV NODE_ENV=production

# Create app directory
WORKDIR /app

# Copy package files first to cache the 'npm ci' layer
COPY package*.json ./

# Install only production dependencies (no devDependencies)
RUN npm ci --only=production

# Install fonts for SVG rendering
RUN apk add --no-cache fontconfig ttf-dejavu
RUN fc-cache -f -v

# Copy the rest of your source code
COPY server.js ./
COPY ticktick-auth.js ./
COPY .ticktick-token.json ./
COPY fonts ./fonts

# Use a non-root user for security (provided by the node image)
USER node

# Match the port your Express app listens on
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]