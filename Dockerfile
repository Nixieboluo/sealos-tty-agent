# syntax=docker/dockerfile:1.4

# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:22-slim AS deps

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol-client/package.json ./packages/protocol-client/

# Install dependencies with cache mount
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ============================================
# Stage 2: Build
# ============================================
FROM deps AS build

# Copy source code
COPY . .

# Build the protocol-client package (generates dist/)
RUN pnpm run build

# ============================================
# Stage 3: Runtime
# ============================================
FROM node:22-slim AS runtime

WORKDIR /app

# Install pnpm for workspace resolution
RUN corepack enable && corepack prepare pnpm@latest --activate

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol-client/package.json ./packages/protocol-client/

# Install production dependencies only
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Copy built protocol-client package
COPY --from=build /app/packages/protocol-client/dist ./packages/protocol-client/dist

# Copy source code (will be executed directly with --experimental-strip-types)
COPY src ./src

# Copy config example (user should mount actual config.json)
COPY config.example.json ./config.json

# Use non-root user
USER node

# Expose port
EXPOSE 3000

# Health check without curl
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/', (r) => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

# Start application using Node.js experimental strip-types
CMD ["node", "--experimental-strip-types", "src/index.ts"]
