import 'dotenv/config';
import { Bot, session, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import {
    JsonRpcProvider,
    Wallet,
    Contract,
    formatEther,
    parseEther,
    ZeroAddress,
    getAddress,
    isAddress,
    formatUnits,
    parseUnits
} from 'ethers';
import fs from 'fs/promises';

// =================================================================
// --- SETUP, CONFIGURATION & CONSTANTS ---
// =================================================================

// --- Helper for consistent logging ---
const log = (level, message, ...args) => {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, message, ...args);
};

if (!process.env.RPC_URL || !process.env.PRIVATE_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    log("error", "FATAL ERROR: Please set RPC_URL, PRIVATE_KEY, and TELEGRAM_BOT_TOKEN in the .env file.");
    process.exit(1);
}

// --- Core Addresses ---
const ZAPPER_ADDRESS = '0x6cc707f9097e9e5692bC4Ad21E17Ed01659D5952';
const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// --- File Paths ---
const POSITIONS_FILE_PATH = './positions.json';

// --- Transaction Parameters ---
const SLIPPAGE_BPS = 2000; // 20% slippage tolerance
const DEADLINE_MINUTES = 20; // 20 minutes for transactions to succeed
const GAS_BUMP_GWEI = 0n; // Add 5 Gwei to the priority fee to speed up transactions. Set to 0n to disable.

// --- ABIs (Application Binary Interfaces) ---
const ZAPPER_ABI = [
    { "inputs": [{ "internalType": "address", "name": "tokenOther", "type": "address" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }], "name": "zapInETH", "outputs": [{ "internalType": "uint256", "name": "liquidity", "type": "uint256" }], "stateMutability": "payable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }], "name": "zapOut", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
];
const UNISWAP_V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) external view returns (address pair)'];
const UNISWAP_V2_PAIR_ABI = ['function balanceOf(address owner) external view returns (uint256)', 'function approve(address spender, uint256 amount) external returns (bool)', 'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function token0() external view returns (address)', 'function totalSupply() view returns (uint256)'];
const ERC20_ABI = ["function name() view returns (string)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"];

// =================================================================
// --- ETHEREUM & CONTRACT SETUP ---
// =================================================================

const provider = new JsonRpcProvider(process.env.RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const zapperContract = new Contract(ZAPPER_ADDRESS, ZAPPER_ABI, wallet);
const factoryContract = new Contract(UNISWAP_V2_FACTORY_ADDRESS, UNISWAP_V2_FACTORY_ABI, provider);

// =================================================================
// --- DATA PERSISTENCE HELPERS ---
// =================================================================

async function loadPositions() {
    try {
        await fs.access(POSITIONS_FILE_PATH);
        const data = await fs.readFile(POSITIONS_FILE_PATH, 'utf-8');
        log("info", `Loaded ${JSON.parse(data).length} positions from ${POSITIONS_FILE_PATH}`);
        return JSON.parse(data);
    } catch (error) {
        log("warn", "positions.json not found or is empty. Starting with a clean slate.");
        return [];
    }
}

async function savePositions(positions) {
    try {
        await fs.writeFile(POSITIONS_FILE_PATH, JSON.stringify(positions, null, 2));
        log("info", `Successfully saved ${positions.length} positions to ${POSITIONS_FILE_PATH}`);
    } catch (error) {
        log("error", "Failed to save positions.json:", error);
    }
}

// =================================================================
// --- BLOCKCHAIN HELPER FUNCTIONS ---
// =================================================================

async function getTokenInfo(tokenAddress) {
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);
    try {
        const [name, symbol, decimals] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()]);
        return { name, symbol, decimals: BigInt(decimals) };
    } catch (error) {
        log("warn", `Could not fetch token info for ${tokenAddress}. Falling back to defaults.`, error);
        return { name: "Unknown Token", symbol: "N/A", decimals: 18n };
    }
}

async function getPairInfo(tokenOtherAddress) {
    const pairAddress = await factoryContract.getPair(WETH_ADDRESS, tokenOtherAddress);
    if (pairAddress === ZeroAddress) throw new Error("Pair does not exist for this token.");

    const pairContract = new Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);
    const tokenOtherContract = new Contract(tokenOtherAddress, ERC20_ABI, provider);

    const [reserves, token0, tokenTotalSupply, tokenDecimals] = await Promise.all([
        pairContract.getReserves(),
        pairContract.token0(),
        tokenOtherContract.totalSupply(),
        tokenOtherContract.decimals().catch(() => 18n)
    ]);

    const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(WETH_ADDRESS)
        ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];

    if (reserveToken === 0n || reserveWETH === 0n) {
        return { pairAddress, price: '0', marketCap: '0' };
    }

    const priceInWei = (reserveWETH * (10n ** BigInt(tokenDecimals))) / reserveToken;
    const marketCapInWei = (reserveWETH * tokenTotalSupply) / reserveToken;

    return { pairAddress, price: formatEther(priceInWei), marketCap: formatEther(marketCapInWei) };
}

async function getTxOptions(value = 0n) {
    const feeData = await provider.getFeeData();
    const options = { value };

    const priorityFeeBump = parseUnits(GAS_BUMP_GWEI.toString(), "gwei");

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        options.maxFeePerGas = feeData.maxFeePerGas;
        options.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas + priorityFeeBump;
        log("info", `EIP-1559 Tx: Prio Fee Bumped to ${formatUnits(options.maxPriorityFeePerGas, "gwei")} Gwei`);
    } else {
        options.gasPrice = feeData.gasPrice + priorityFeeBump;
        log("info", `Legacy Tx: Gas Price Bumped to ${formatUnits(options.gasPrice, "gwei")} Gwei`);
    }
    return options;
}


// =================================================================
// --- TELEGRAM CONVERSATIONS ---
// =================================================================

async function zapInConversation(conversation, ctx) {
    await ctx.reply("Please provide the token contract address to pair with ETH.");
    const tokenAddressMsg = await conversation.wait();
    const tokenAddressText = tokenAddressMsg.message?.text;

    if (!tokenAddressText || !isAddress(tokenAddressText)) {
        await ctx.reply("❌ Invalid Ethereum address. Please start again with /zapin.");
        return;
    }
    const tokenAddress = getAddress(tokenAddressText);

    const waitingMessage = await ctx.reply("🔍 Fetching token info and estimating base gas cost...");
    let tokenInfo, pairInfo, estimatedTotalFee, gasPriceInGwei;

    try {
        const [
            localTokenInfo,
            localPairInfo,
            gasEstimate,
            feeData
        ] = await Promise.all([
            getTokenInfo(tokenAddress),
            getPairInfo(tokenAddress),
            zapperContract.zapInETH.estimateGas(tokenAddress, 0n, 0n, wallet.address, Math.floor(Date.now() / 1000) + 120, SLIPPAGE_BPS, { value: parseEther('0.0001') }),
            provider.getFeeData()
        ]);

        tokenInfo = localTokenInfo;
        pairInfo = localPairInfo;

        // ========== GWEI DISPLAY CHANGE STARTS HERE ==========
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

        // Calculate the current gas price in Gwei for display
        gasPriceInGwei = parseFloat(formatUnits(gasPrice, "gwei")).toFixed(2);

        // Calculate the total estimated fee in ETH for display
        estimatedTotalFee = formatEther(gasEstimate * gasPrice);
        // ========== GWEI DISPLAY CHANGE ENDS HERE ==========

    } catch (e) {
        log("error", "Error during zap-in pre-flight checks:", e);
        await ctx.api.editMessageText(ctx.chat.id, waitingMessage.message_id, `❌ Error fetching token data: ${e.reason || e.message}`);
        return;
    }

    // ========== GWEI DISPLAY CHANGE STARTS HERE ==========
    // Updated the text to show both Gwei price and the total fee in ETH
    const infoText = `
*Token Found:*
*Name:* ${tokenInfo.name} (${tokenInfo.symbol})
*Address:* \`${tokenAddress}\`
*Market Cap:* ~${parseFloat(pairInfo.marketCap).toFixed(2)} ETH
*Current Gas Price:* ~${gasPriceInGwei} Gwei
*Est. Total Fee:* ~${parseFloat(estimatedTotalFee).toFixed(5)} ETH

How much ETH would you like to zap in? (e.g., '0.05')`;
    // ========== GWEI DISPLAY CHANGE ENDS HERE ==========
    await ctx.api.editMessageText(ctx.chat.id, waitingMessage.message_id, infoText, { parse_mode: "Markdown" });

    const ethAmountMsg = await conversation.wait();
    const ethAmount = ethAmountMsg.message?.text;
    if (!ethAmount || isNaN(parseFloat(ethAmount)) || parseFloat(ethAmount) <= 0) {
        await ctx.reply("❌ Invalid amount. Please start again with /zapin.");
        return;
    }

    await ctx.reply(`🚀 Zapping ${ethAmount} ETH... Please wait for blockchain confirmation.`);
    const amountIn = parseEther(ethAmount);

    try {
        const deadline = Math.floor(Date.now() / 1000) + (DEADLINE_MINUTES * 60);
        const txOptions = await getTxOptions(amountIn);
        const tx = await zapperContract.zapInETH(tokenAddress, 0n, 0n, wallet.address, deadline, SLIPPAGE_BPS, txOptions);

        log("info", `Zap-in transaction submitted: ${tx.hash}`);
        await ctx.reply(`Transaction submitted! View on Etherscan: https://etherscan.io/tx/${tx.hash}`);

        await tx.wait();
        log("info", `Zap-in transaction confirmed for ${ethAmount} ETH with ${tokenInfo.symbol}.`);

        const positions = await loadPositions();
        positions.push({
            tokenAddress,
            pairAddress: pairInfo.pairAddress,
            initialEthValue: ethAmount,
            initialMarketCap: pairInfo.marketCap,
            timestamp: Date.now()
        });
        await savePositions(positions);

        await ctx.reply(`✅ Zap In successful!`);
    } catch (e) {
        log("error", "Zap In execution error:", e);
        await ctx.reply(`❌ Zap In failed: ${e.reason || e.message}`);
    }
}


// =================================================================
// --- TELEGRAM BOT SETUP & MIDDLEWARE ---
// =================================================================

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({ initial: () => ({ positionIndex: 0 }) }));
bot.use(conversations());
bot.use(createConversation(zapInConversation));

// =================================================================
// --- COMMAND HANDLERS ---
// =================================================================

bot.command("start", (ctx) => {
    ctx.reply("Welcome to the Uniswap V2 Zapper Bot!\n\n/zapin - Add liquidity to a new pool.\n/positions - View and manage your open positions.");
});

bot.command("zapin", async (ctx) => {
    await ctx.conversation.enter("zapInConversation");
});

bot.command("positions", async (ctx) => {
    const positions = await loadPositions();
    if (positions.length === 0) {
        await ctx.reply("You have no open LP positions.");
        return;
    }
    ctx.session.positionIndex = 0;
    await displayPosition(ctx);
});

// =================================================================
// --- CALLBACK QUERY (BUTTON) HANDLERS ---
// =================================================================

bot.callbackQuery(/^(prev_pos|next_pos)$/, async (ctx) => {
    const positions = await loadPositions();
    if (positions.length === 0) {
        await ctx.editMessageText("No positions found.");
        return ctx.answerCallbackQuery();
    }
    const direction = ctx.match[1];
    if (direction === 'prev_pos') {
        ctx.session.positionIndex = (ctx.session.positionIndex - 1 + positions.length) % positions.length;
    } else {
        ctx.session.positionIndex = (ctx.session.positionIndex + 1) % positions.length;
    }
    await displayPosition(ctx, true);
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^execute_zapout:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); // Acknowledge immediately
    const percentage = parseInt(ctx.match[1], 10);
    let positions = await loadPositions();
    const positionIndex = ctx.session.positionIndex;
    const position = positions[positionIndex];

    if (!position) {
        await ctx.editMessageText("❌ Position not found. It may have been removed.");
        return;
    }

    await ctx.editMessageText(`⏳ Processing ${percentage}% Zap Out for token ${position.tokenAddress.slice(0, 6)}... Please wait...`, { reply_markup: undefined });

    try {
        const pairContract = new Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, wallet);
        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) throw new Error("You have no LP tokens for this pair to zap out.");

        const liquidityToZap = (lpBalance * BigInt(percentage)) / 100n;

        log("info", `Approving ${formatEther(liquidityToZap)} LP tokens for Zap Out...`);
        const approveTx = await pairContract.approve(ZAPPER_ADDRESS, liquidityToZap);
        await approveTx.wait();
        log("info", "Approval successful.");

        const deadline = Math.floor(Date.now() / 1000) + (DEADLINE_MINUTES * 60);
        const txOptions = await getTxOptions(); // No ETH value needed
        const zapOutTx = await zapperContract.zapOut(WETH_ADDRESS, position.tokenAddress, liquidityToZap, WETH_ADDRESS, 0n, 0n, 0n, wallet.address, deadline, SLIPPAGE_BPS, txOptions);

        log("info", `Zap-out transaction submitted: ${zapOutTx.hash}`);
        await ctx.reply(`Transaction submitted! View on Etherscan: https://etherscan.io/tx/${zapOutTx.hash}`);

        await zapOutTx.wait();
        log("info", `Zap-out transaction confirmed.`);

        if (percentage === 100) {
            positions.splice(positionIndex, 1);
            ctx.session.positionIndex = Math.max(0, positionIndex - 1);
        }
        await savePositions(positions);
        await ctx.reply(`✅ ${percentage}% Zap Out successful!`);

        if (positions.length > 0) {
            await displayPosition(ctx);
        } else {
            await ctx.reply("All positions have been closed.");
        }

    } catch (e) {
        log("error", "Zap Out Error:", e);
        await ctx.reply(`❌ Zap Out failed: ${e.reason || e.message}`);
    }
});

// =================================================================
// --- DISPLAY LOGIC ---
// =================================================================

async function displayPosition(ctx, edit = false) {
    const positions = await loadPositions();
    const index = ctx.session.positionIndex;

    if (!positions[index]) {
        const message = "You have no open positions.";
        edit ? await ctx.editMessageText(message, { reply_markup: undefined }) : await ctx.reply(message);
        return;
    }
    const position = positions[index];

    const waitMessage = edit
        ? await ctx.editMessageText(`⏳ Loading position ${index + 1}/${positions.length}...`)
        : await ctx.reply(`⏳ Loading position ${index + 1}/${positions.length}...`);

    try {
        const pairContract = new Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, provider);
        const [tokenInfo, reserves, lpBalance, pairTotalSupply, currentPairInfo] = await Promise.all([
            getTokenInfo(position.tokenAddress),
            pairContract.getReserves(),
            pairContract.balanceOf(wallet.address),
            pairContract.totalSupply(),
            getPairInfo(position.tokenAddress)
        ]);

        if (pairTotalSupply === 0n || reserves[0] === 0n || reserves[1] === 0n) {
            await ctx.api.editMessageText(ctx.chat.id, waitMessage.message_id, "Could not calculate value: Pool has no liquidity.");
            return;
        }

        const token0 = await pairContract.token0();
        const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(WETH_ADDRESS)
            ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];

        const userShareOfWETH = (reserveWETH * lpBalance) / pairTotalSupply;
        const userShareOfToken = (reserveToken * lpBalance) / pairTotalSupply;
        const valueOfTokenInWETH = (userShareOfToken * reserveWETH) / reserveToken;
        const userLpValueWei = userShareOfWETH + valueOfTokenInWETH;

        const userLpValueEth = parseFloat(formatEther(userLpValueWei));
        const initialValueEth = parseFloat(position.initialEthValue);
        const lpProfitPercent = initialValueEth > 0 ? ((userLpValueEth - initialValueEth) / initialValueEth) * 100 : 0;
        const lpProfitSign = lpProfitPercent >= 0 ? '💹 +' : '🔻 ';

        const initialMarketCap = parseFloat(position.initialMarketCap);
        const currentMarketCap = parseFloat(currentPairInfo.marketCap);
        const mcapProfitPercent = initialMarketCap > 0 ? ((currentMarketCap - initialMarketCap) / initialMarketCap) * 100 : 0;
        const mcapProfitSign = mcapProfitPercent >= 0 ? '📈 +' : '📉 ';

        const userSharePercent = Number((lpBalance * 10000n) / pairTotalSupply) / 100;


        const messageText = `
*Position ${index + 1} of ${positions.length}*
*Token:* ${tokenInfo.name} (${tokenInfo.symbol})
*Pair Address:* \`${position.pairAddress}\`

*Your LP Balance:* \`${formatEther(lpBalance)}\` LP
*Your Pool Share:* ~${userSharePercent.toFixed(4)}%

--- *Performance* ---
*Initial ETH Value:* ${initialValueEth.toFixed(5)} ETH
*Current LP Value:* ~${userLpValueEth.toFixed(5)} ETH
*LP Value P/L:* *${lpProfitSign}${lpProfitPercent.toFixed(2)}%*

*Initial MCAP:* ~${initialMarketCap.toFixed(2)} ETH
*Current MCAP:* ~${currentMarketCap.toFixed(2)} ETH
*Token MCAP P/L:* *${mcapProfitSign}${mcapProfitPercent.toFixed(2)}%*

_(Note: LP Value P/L is your actual return. Token MCAP P/L shows the token's performance, not your investment's.)_`;

        const keyboard = new InlineKeyboard()
            .text('⬅️ Prev', 'prev_pos').text('Next ➡️', 'next_pos').row()
            .text('🔥 Zap Out 50%', 'execute_zapout:50')
            .text('💥 Zap Out 100%', 'execute_zapout:100');

        await ctx.api.editMessageText(ctx.chat.id, waitMessage.message_id, messageText, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
        });

    } catch (e) {
        log("error", "Display Position Error:", e);
        await ctx.api.editMessageText(ctx.chat.id, waitMessage.message_id, `❌ Could not load position data: ${e.message}`);
    }
}


// =================================================================
// --- BOT STARTUP & GLOBAL ERROR HANDLING ---
// =================================================================

bot.catch((err) => {
    const ctx = err.ctx;
    log("error", `Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) log("error", "Error in request:", e.description);
    else if (e instanceof HttpError) log("error", "Could not contact Telegram:", e);
    else log("error", "Unknown error:", e);
});

async function startBot() {
    try {
        const balance = await provider.getBalance(wallet.address);
        log("info", "=========================================");
        log("info", "Bot starting...");
        log("info", `Wallet Address: ${wallet.address}`);
        log("info", `Current Balance: ${formatEther(balance)} ETH`);
        log("info", "=========================================");
        await bot.start();
    } catch (e) {
        log("error", "FATAL: Could not connect to RPC or start the bot.", e);
        process.exit(1);
    }
}

startBot();