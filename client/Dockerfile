FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json index.html ./
COPY src ./src
# Empty = same-origin (nginx proxies /v1 to SpacetimeDB) — the right
# default for every containerized deployment.
ARG VITE_SPACETIMEDB_URI=
ARG VITE_DATABASE_NAME=digital-tennis
# Firebase web config. All four are PUBLIC values (they identify the project,
# they don't authorize anything), so baking them into the bundle is how
# Firebase is meant to be used. Leave them empty to run without accounts.
ARG VITE_FIREBASE_API_KEY=
ARG VITE_FIREBASE_AUTH_DOMAIN=
ARG VITE_FIREBASE_PROJECT_ID=
ARG VITE_FIREBASE_APP_ID=
ENV VITE_SPACETIMEDB_URI=$VITE_SPACETIMEDB_URI \
    VITE_DATABASE_NAME=$VITE_DATABASE_NAME \
    VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
