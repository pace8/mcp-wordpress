FROM node:22-alpine

# Werkmap in de container
WORKDIR /app

# Eerst alleen package.json, lockfiles en tsconfig kopiëren
COPY package*.json tsconfig.json ./

# Dependencies installeren (incl. devDependencies, dus TypeScript)
RUN npm install --include=dev --ignore-scripts

# Nu de rest van de code kopiëren
COPY . .

# TypeScript build draaien (maakt dist/)
RUN npm run build

# Cloud Run geeft ons een PORT env var
ENV PORT=8080
EXPOSE 8080

# Start de server – pas aan als jouw entry anders heet
CMD ["node", "build/server.js"]
