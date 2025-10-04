# 🚀 Enhanced Uniswap V2 Zapper Bot

A production-ready Telegram bot for zapping in and out of Uniswap V2 liquidity pools on Ethereum mainnet.

## ✨ Features

- 🎯 **Dynamic Slippage Protection** - Auto-adjusts based on price impact (0.5% - 50%)
- ⚡ **EIP-1559 Gas Optimization** - Smart gas pricing with Etherscan V2 API
- 🛡️ **Triple Fallback System** - Etherscan → RPC → Default (always works!)
- 📊 **Real-time Position Tracking** - Auto-refresh every 15 seconds
- 💰 **Flexible Zap Amounts** - Presets + custom amounts
- 🔥 **Multiple Zap Out Options** - 25%, 50%, 75%, 100%
- 🔧 **Fully Configurable** - Everything customizable via `.env`

## 🚀 Quick Start

### 1. Configure Environment

Edit `.env` file:
```bash
RPC_URL=https://mainnet.infura.io/v3/YOUR_PROJECT_ID
PRIVATE_KEY=your_private_key_without_0x
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
ETHERSCAN_API_KEY=your_etherscan_api_key
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Run the Bot

```bash
npm run zapbot
```

### 4. Use on Telegram

Send `/start` to your bot and follow the instructions!

## 📋 Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and features |
| `/zapin` | Add liquidity to a pool |
| `/positions` | View and manage positions |
| `/status` | Check bot and wallet status |
| `/help` | Detailed help instructions |

## 🔧 Configuration

All settings in `.env` file:

```bash
# Required
RPC_URL=your_rpc_url
PRIVATE_KEY=your_private_key
TELEGRAM_BOT_TOKEN=your_bot_token
ETHERSCAN_API_KEY=your_api_key

# Contracts (Already set for Ethereum mainnet)
ZAPPER_ADDRESS=0x6cc707f9097e9e5692bC4Ad21E17Ed01659D5952
UNISWAP_V2_FACTORY_ADDRESS=0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
UNISWAP_V2_ROUTER_ADDRESS=0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D

# Optional (with defaults)
ENABLE_DYNAMIC_SLIPPAGE=true
SLIPPAGE_BPS=2000
MIN_SLIPPAGE_BPS=50
MAX_SLIPPAGE_BPS=5000
DEFAULT_GAS_PRICE_GWEI=30.0
ZAP_AMOUNT_PRESETS=0.001,0.003,0.005,0.008
ZAP_OUT_PERCENTAGES=25,50,75,100
```

## 📚 Documentation

- **[ETHERSCAN_V2_UPDATE.md](ETHERSCAN_V2_UPDATE.md)** - Etherscan V2 API update info
- **[GAS_PRICE_FIX.md](GAS_PRICE_FIX.md)** - Gas price fallback system details
- **[SETUP_COMPLETE.md](SETUP_COMPLETE.md)** - Setup summary and features

## 🎯 How It Works

### Zap In Flow
1. Enter token address
2. Bot fetches token info and pair data
3. Choose amount (preset or custom)
4. Dynamic slippage calculated based on price impact
5. Transaction executed with optimal gas prices
6. Position saved and tracked

### Zap Out Flow
1. View your positions
2. Select percentage to zap out
3. Bot calculates optimal parameters
4. Approves LP tokens
5. Executes zap out to ETH
6. Updates or closes position

### Gas Price Strategy
1. **Try Etherscan V2 API** - Fast and accurate
2. **Fallback to RPC** - If Etherscan fails
3. **Use Default 30 Gwei** - If both fail

**Your bot always works!**

## 🛡️ Safety Features

- ✅ Balance validation before transactions
- ✅ Dynamic slippage based on price impact
- ✅ Gas price capping (prevents overpaying)
- ✅ Transaction deadlines
- ✅ Clear error messages
- ✅ Automatic fallbacks

## 💡 Tips

- Start with small amounts (0.001 ETH) for testing
- Check `/status` before zapping to see gas prices
- Enable dynamic slippage for best results
- Monitor positions with auto-refresh
- Use partial zap outs (25%, 50%) to take profits while staying exposed

## 🔐 Security

- `.env` file is in `.gitignore` (never commit it!)
- Use a separate wallet for bot operations
- Keep your private key secure
- Start with small test amounts
- Verify token addresses before zapping

## 📊 Example Usage

```bash
# Start bot
npm run zapbot

# In Telegram:
/start
/zapin
# Enter: 0x6B175474E89094C44Da98b954EedeAC495271d0F (DAI)
# Choose: 0.001 ETH
# ✅ Zap successful!

/positions
# View your DAI/ETH LP position
# Click: 🔥 Zap Out 50%
# ✅ Half position closed!
```

## 🐛 Troubleshooting

### "NOTOK" errors from Etherscan
- ✅ **FIXED!** Bot now uses Etherscan V2 API
- Falls back to RPC if needed
- Bot works regardless

### "Conflict: terminated by other getUpdates"
- Another bot instance is running
- Stop all Node processes: `pkill -f "node.*zapbot"`
- Restart: `npm run zapbot`

### "Insufficient ETH"
- Need ETH for both zap amount AND gas fees
- Check "Max Safe Zap" amount in UI
- Add more ETH to wallet

## 📈 Performance

- Response time: < 2 seconds (with cache)
- Gas optimization: EIP-1559 with priority fees
- Position refresh: Every 15 seconds
- API caching: 10 seconds

## 🎉 What Makes This Special

✅ Production-ready code  
✅ Etherscan V2 API support  
✅ Triple fallback system  
✅ Dynamic slippage protection  
✅ Real-time position tracking  
✅ Fully documented  
✅ No manual work needed  

**Just configure `.env` and run!**

## 📜 License

ISC

## 👤 Author

Nima Zeighami

## 🔗 Links

- [GitHub Repository](https://github.com/NimaZeighami/Uniswap-V2-Zapper)
- [Etherscan V2 API Docs](https://docs.etherscan.io/v/v2-api-documentation/)
- [Uniswap V2 Docs](https://docs.uniswap.org/contracts/v2/overview)

---

**Ready to start?** 🚀

```bash
npm run zapbot
```

Then open Telegram and send `/start` to your bot!
