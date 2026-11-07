# Étape 1 : dépendances de production, avec npm.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Étape 2 : image finale sans npm ni yarn. Le service n'en a pas besoin à l'exécution,
# et leurs dépendances embarquées portaient des failles critiques (ES-10, scan Trivy).
FROM node:24-alpine
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# ES-09 : utilisateur non root (fourni par l'image node).
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
