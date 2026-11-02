# Multi-stage production build for My Health App Backend
# Small footprint, fast startup. Runs on ECS Fargate (ARM) and on Render.

FROM node:22-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl libc6-compat

# Install dependencies
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy source code and build
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# --- Production Runner Stage ---
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Install OpenSSL for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl libc6-compat

# Install only production dependencies + prisma CLI for migrations
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev && npm install -g prisma@5.22.0

# Copy generated Prisma Client and built application from builder
COPY --from=builder /app/node_modules/@prisma /app/node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=builder /app/dist ./dist

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 expressuser && \
    chown -R expressuser:nodejs /app

USER expressuser

EXPOSE 4000

# The container only starts the API. Migrations are a separate step:
#   - AWS: the deploy workflow runs the one-shot migrate task (command: prisma migrate deploy) first.
#   - Render: render.yaml sets dockerCommand to run migrations before the server.
# The extraction worker uses the same image with the command: node dist/worker.js
CMD ["node", "dist/index.js"]
