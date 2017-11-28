FROM mhart/alpine-node:8

WORKDIR /app
COPY . .

RUN apk update && \
    apk add git && \
    npm install --production

CMD ["node", "server.js"]
