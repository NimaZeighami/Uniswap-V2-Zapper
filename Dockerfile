# =================================================================
# STAGE 1: Build - Install dependencies
# =================================================================
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --only=production

# =================================================================
# STAGE 2: Production - Create the final lightweight image
# =================================================================
FROM node:20-alpine

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules

COPY Uniswapv2ZapperEtherscan.js .
COPY positions.json .

USER node


CMD ["sh", "-c", "node Uniswapv2ZapperEtherscan.js >> /usr/src/app/logs/app.log 2>&1"]