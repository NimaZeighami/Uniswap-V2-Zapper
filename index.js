import { config } from 'dotenv';
config();
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

if (!process.env.RPC_URL || !process.env.PRIVATE_KEY || !process.env.TELEGRAM_BOT_TOKEN || !process.env.ETHERSCAN_API_KEY) {
    log("error", "FATAL ERROR: Please set RPC_URL, PRIVATE_KEY, TELEGRAM_BOT_TOKEN, and ETHERSCAN_API_KEY in the .env file.");
    process.exit(1);
}

// --- Etherscan Configuration ---
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_URL = 'https://api.etherscan.io/api';


// --- Core Addresses ---
const ZAPPER_ADDRESS = '0x6cc707f9097e9e5692bC4Ad21E17Ed01659D5952';
const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// --- File Paths ---
const POSITIONS_FILE_PATH = './positions.json';

// --- Transaction Parameters ---
const SLIPPAGE_BPS = 2000; // 20% slippage tolerance
const DEADLINE_MINUTES = 3; // 3 minutes for transactions to succeed
const BUMP_PERCENT = 20n; // 20% dynamic bump for faster transactions

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
        const positions = JSON.parse(data);
        log("info", `Loaded ${positions.length} positions from ${POSITIONS_FILE_PATH}`);
        return positions;
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
        log("warn", `Could not fetch token info for ${tokenAddress}. Falling back to defaults.`);
        return { name: "Unknown Token", symbol: "N/A", decimals: 18n };
    }
}

async function getPairInfo(tokenOtherAddress) {
    const pairAddress = await factoryContract.getPair(WETH_ADDRESS, tokenOtherAddress);
    if (pairAddress === ZeroAddress) throw new Error("Pair does not exist for this token.");

    const pairContract = new Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);
    const tokenOtherContract = new Contract(tokenOtherAddress, ERC20_ABI, provider);

    const [reserves, token0, tokenTotalSupply, tokenDecimalsNum] = await Promise.all([
        pairContract.getReserves(),
        pairContract.token0(),
        tokenOtherContract.totalSupply(),
        tokenOtherContract.decimals().catch(() => 18)
    ]);

    const tokenDecimals = BigInt(tokenDecimalsNum);

    const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(WETH_ADDRESS)
        ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];

    if (reserveToken === 0n || reserveWETH === 0n) {
        return { pairAddress, price: '0', marketCap: '0' };
    }

    const priceInWei = (reserveWETH * (10n ** tokenDecimals)) / reserveToken;
    const marketCapInWei = (reserveWETH * tokenTotalSupply) / reserveToken;

    return { pairAddress, price: formatEther(priceInWei), marketCap: formatEther(marketCapInWei) };
}

async function getTxOptions(value = 0n) {
    const url = `${ETHERSCAN_API_URL}?module=gastracker&action=gasoracle&apikey=${ETHERSCAN_API_KEY}`;
    const options = { value };
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.status !== '1') throw new Error(`Etherscan API error: ${data.message}`);

        // Using FastGasPrice for quicker transaction inclusion
        const { suggestBaseFee, FastGasPrice } = data.result;

        log("info", `Etherscan Gas Oracle: Base=${suggestBaseFee}, Fast=${FastGasPrice}`);
        const baseFeeGwei = parseFloat(suggestBaseFee);
        const fastGasPriceGwei = parseFloat(FastGasPrice);
        const priorityFeeGwei = Math.max(0.1, fastGasPriceGwei - baseFeeGwei); // Ensure a minimal tip
        const maxFeePerGasInitial = parseUnits(fastGasPriceGwei.toFixed(9), 'gwei');
        const maxPriorityFeePerGasInitial = parseUnits(priorityFeeGwei.toFixed(9), 'gwei');
        const priorityBump = (maxPriorityFeePerGasInitial * BUMP_PERCENT) / 100n;
        options.maxPriorityFeePerGas = maxPriorityFeePerGasInitial + priorityBump;
        options.maxFeePerGas = maxFeePerGasInitial + priorityBump;
        const effectiveGasPrice = options.maxFeePerGas;
        log("info", `EIP-1559 Tx (Fast): Priority Fee bumped to ${formatUnits(options.maxPriorityFeePerGas, "gwei")} Gwei`);
        return { gasPrice: effectiveGasPrice, ...options };
    } catch (error) {
        log("error", `FATAL: Could not fetch gas price from Etherscan. ${error.message}.`);
        throw new Error(`Failed to get gas prices from Etherscan. Please try again later.`);
    }
}

async function getEthPriceInUsd() {
    const url = `${ETHERSCAN_API_URL}?module=stats&action=ethprice&apikey=${ETHERSCAN_API_KEY}`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.status !== '1') throw new Error(`Etherscan API error: ${data.message} - ${data.result}`);
        const ethPrice = parseFloat(data.result.ethusd);
        log('info', `Fetched ETH price from Etherscan: $${ethPrice.toFixed(2)}`);
        return ethPrice;
    } catch (error) {
        log('warn', `Could not fetch ETH price from Etherscan: ${error.message}. Defaulting to 0.`);
        return 0;
    }
}

// =================================================================
// --- TELEGRAM CONVERSATIONS ---
// =================================================================

async function zapInConversation(conversation, ctx) {
    activeConversations.add(ctx.chat.id);
    let mainMessage;
    try {
        mainMessage = await ctx.reply("Please provide the token contract address to pair with ETH.");
        const tokenAddressMsg = await conversation.wait();
        const tokenAddressText = tokenAddressMsg.message?.text;
        try { await ctx.api.deleteMessage(ctx.chat.id, tokenAddressMsg.message.message_id); }
        catch (e) { log('warn', 'Could not delete user message', e.description); }

        if (!tokenAddressText || !isAddress(tokenAddressText)) {
            await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, "❌ Invalid Ethereum address. Please start again.");
            return;
        }
        const tokenAddress = getAddress(tokenAddressText);
        await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, '⏳ Fetching token data...');

        try {
            const { messageText, keyboard } = await generateZapInTokenMessage(tokenAddress);
            await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, messageText, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (e) {
            log("error", "Initial token data fetch failed:", e);
            await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `❌ Could not load token data: ${e.message}`);
            return;
        }

        let keepWaiting = true;
        while (keepWaiting) {
            const response = await conversation.waitFor(["message:text", "callback_query"]);
            let ethAmount;

            if (response.callbackQuery) {
                if (response.callbackQuery.data.startsWith('zap_amount:')) {
                    await response.answerCallbackQuery();
                    ethAmount = response.callbackQuery.data.split(':')[1];
                    keepWaiting = false;
                } else if (response.callbackQuery.data.startsWith('refresh_zap:')) {
                    await response.answerCallbackQuery({ text: 'Refreshing...' });
                    try {
                        const { messageText, keyboard } = await generateZapInTokenMessage(tokenAddress);
                        await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, messageText, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(e => { if (!e.description.includes("message is not modified")) throw e; });
                    } catch (e) { log('error', "Error refreshing zap-in info", e); }
                    continue;
                }
            } else {
                const potentialAmount = response.message?.text;
                try { await ctx.api.deleteMessage(ctx.chat.id, response.message.message_id); }
                catch (e) { log('warn', 'Could not delete user message', e.description); }
                if (potentialAmount && !isNaN(parseFloat(potentialAmount)) && parseFloat(potentialAmount) > 0) {
                    ethAmount = potentialAmount;
                    keepWaiting = false;
                } else {
                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, "❌ Invalid input. The process has been cancelled.", { reply_markup: undefined });
                    return;
                }
            }

            if (!keepWaiting) {
                if (!ethAmount || isNaN(parseFloat(ethAmount)) || parseFloat(ethAmount) <= 0) {
                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, "❌ Invalid amount. Please start again.");
                    return;
                }
                const amountIn = parseEther(ethAmount);
                await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `⏳ Estimating transaction for zapping ${ethAmount} ETH...`, { reply_markup: undefined });

                try {
                    const deadline = Math.floor(Date.now() / 1000) + (DEADLINE_MINUTES * 60);
                    const { gasPrice, ...txOptions } = await getTxOptions(amountIn);

                    // ================== GAS LIMIT FIX v2 (ZAP IN) ==================
                    const estimatedGasLimit = await zapperContract.zapInETH.estimateGas(tokenAddress, 0n, 0n, wallet.address, deadline, SLIPPAGE_BPS, txOptions);
                    const gasLimit = (estimatedGasLimit * 130n) / 100n; // Use a more aggressive 30% buffer
                    txOptions.gasLimit = gasLimit; // CRITICAL: Apply the new gas limit to the transaction options
                    log('info', `ZapIn Gas: Estimated=${estimatedGasLimit}, Using=${gasLimit} (30% buffer)`);
                    // ===============================================================

                    const estimatedFeeWei = gasLimit * gasPrice;
                    const estimatedFeeEth = formatEther(estimatedFeeWei);
                    const ethPriceUsd = await getEthPriceInUsd();
                    const estimatedFeeUsd = parseFloat(estimatedFeeEth) * ethPriceUsd;
                    const gasPriceGwei = formatUnits(gasPrice, "gwei");

                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `🚀 Zapping ${ethAmount} ETH...\n\n*Est. Fee:*\nGas Price: ~${parseFloat(gasPriceGwei).toFixed(1)} Gwei\nTx Fee: ~$${estimatedFeeUsd.toFixed(4)}`, { parse_mode: 'Markdown', reply_markup: undefined });

                    const tx = await zapperContract.zapInETH(tokenAddress, 0n, 0n, wallet.address, deadline, SLIPPAGE_BPS, txOptions);

                    log("info", `Zap-in transaction submitted: ${tx.hash}`);
                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `Transaction submitted! Waiting for confirmation...\n\n[View on Etherscan](https://etherscan.io/tx/${tx.hash})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
                    await tx.wait();

                    const [tokenInfo, pairInfo] = await Promise.all([getTokenInfo(tokenAddress), getPairInfo(tokenAddress)]);
                    log("info", `Zap-in transaction confirmed for ${ethAmount} ETH with ${tokenInfo.symbol}.`);

                    const positions = await loadPositions();
                    const existingPositionIndex = positions.findIndex(p => getAddress(p.tokenAddress) === getAddress(tokenAddress));
                    if (existingPositionIndex > -1) {
                        const existingPosition = positions[existingPositionIndex];
                        const oldEth = parseFloat(existingPosition.initialEthValue);
                        const newEth = parseFloat(ethAmount);
                        const oldMCap = parseFloat(existingPosition.initialMarketCap);
                        const newMCap = parseFloat(pairInfo.marketCap);
                        const totalEth = oldEth + newEth;
                        const weightedMCap = ((oldMCap * oldEth) + (newMCap * newEth)) / totalEth;
                        existingPosition.initialEthValue = totalEth.toString();
                        existingPosition.initialMarketCap = weightedMCap.toString();
                        existingPosition.timestamp = Date.now();
                    } else {
                        positions.push({ tokenAddress, pairAddress: pairInfo.pairAddress, initialEthValue: ethAmount, initialMarketCap: pairInfo.marketCap, timestamp: Date.now() });
                    }
                    await savePositions(positions);

                    const finalIndex = existingPositionIndex > -1 ? existingPositionIndex : positions.length - 1;
                    (ctx.session ?? (ctx.session = {})).positionIndex = finalIndex;

                    const keyboard = new InlineKeyboard().text("✅ View Position", "show_position");
                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `✅ Zap In successful for ${tokenInfo.symbol}!`, { reply_markup: keyboard, parse_mode: 'Markdown' });
                } catch (e) {
                    log("error", "Zap In execution error:", e);
                    const errorMessage = e.reason || e.message || "An unknown error occurred.";
                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `❌ Zap In failed: ${errorMessage}`);
                }
                break;
            }
        }
    } catch (e) {
        log('error', "Error in zapInConversation", e);
        if (mainMessage) {
            await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, "An unexpected error occurred.").catch(err => log('error', 'Failed to send final error message.', err));
        }
    } finally {
        activeConversations.delete(ctx.chat.id);
    }
}

// =================================================================
// --- TELEGRAM BOT SETUP & MIDDLEWARE ---
// =================================================================

const activeWatchers = new Map();
const activeConversations = new Set();

function stopWatcher(chatId) {
    if (activeWatchers.has(chatId)) {
        clearInterval(activeWatchers.get(chatId).intervalId);
        activeWatchers.delete(chatId);
        log('info', `Stopped watcher for chat ID: ${chatId}`);
    }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({ initial: () => ({ positionIndex: 0 }) }));
bot.use(conversations());
bot.use(createConversation(zapInConversation));

// =================================================================
// --- COMMAND HANDLERS ---
// =================================================================

bot.command("start", (ctx) => {
    stopWatcher(ctx.chat.id);
    ctx.reply("Welcome to the Uniswap V2 Zapper Bot!\n\n/zapin - Add liquidity.\n/positions - Manage positions.");
});

bot.command("zapin", async (ctx) => {
    stopWatcher(ctx.chat.id);
    await ctx.conversation.enter("zapInConversation");
});

bot.command("positions", async (ctx) => {
    stopWatcher(ctx.chat.id);
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

bot.callbackQuery(/^zap_amount:(.+)$/, (ctx) => ctx.answerCallbackQuery());
bot.callbackQuery("show_position", async (ctx) => {
    await ctx.answerCallbackQuery();
    await displayPosition(ctx, true);
});

bot.callbackQuery(/^(prev_pos|next_pos)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const positions = await loadPositions();
    if (positions.length === 0) {
        await ctx.editMessageText("No positions found.").catch(e => log("warn", "Edit failed on pos nav", e));
        return;
    }
    const direction = ctx.match[1];
    let currentIndex = ctx.session?.positionIndex ?? 0;
    if (direction === 'prev_pos') {
        currentIndex = (currentIndex - 1 + positions.length) % positions.length;
    } else {
        currentIndex = (currentIndex + 1) % positions.length;
    }
    (ctx.session ?? (ctx.session = {})).positionIndex = currentIndex;
    await displayPosition(ctx, true);
});

bot.callbackQuery('refresh_pos', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Refreshing...' });
    await displayPosition(ctx, true);
});

bot.callbackQuery(/^execute_zapout:(\d+)$/, async (ctx) => {
    stopWatcher(ctx.chat.id);
    await ctx.answerCallbackQuery();
    const percentage = parseInt(ctx.match[1], 10);
    const positions = await loadPositions();
    let positionIndex = ctx.session?.positionIndex ?? 0;
    const position = positions[positionIndex];

    if (!position) {
        await ctx.editMessageText("❌ Position not found.", { reply_markup: undefined });
        return;
    }
    await ctx.editMessageText(`⏳ Processing ${percentage}% Zap Out...`, { reply_markup: undefined });

    try {
        const pairContract = new Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, wallet);
        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) throw new Error("You have no LP tokens to zap out.");
        const liquidityToZap = (lpBalance * BigInt(percentage)) / 100n;

        log("info", `Approving ${formatEther(liquidityToZap)} LP tokens...`);
        const approveTx = await pairContract.approve(ZAPPER_ADDRESS, liquidityToZap);
        await approveTx.wait();
        log("info", "Approval successful.");

        const deadline = Math.floor(Date.now() / 1000) + (DEADLINE_MINUTES * 60);
        const { gasPrice, ...txOptions } = await getTxOptions();

        // ================== GAS LIMIT FIX v2 (ZAP OUT) =================
        const estimatedGasLimit = await zapperContract.zapOut.estimateGas(
            WETH_ADDRESS, position.tokenAddress, liquidityToZap, WETH_ADDRESS, 0n, 0n, 0n,
            wallet.address, deadline, SLIPPAGE_BPS, txOptions
        );
        const gasLimit = (estimatedGasLimit * 130n) / 100n; // Use a more aggressive 30% buffer
        txOptions.gasLimit = gasLimit; // CRITICAL: Apply the new gas limit to the transaction options
        log('info', `ZapOut Gas: Estimated=${estimatedGasLimit}, Using=${gasLimit} (30% buffer)`);
        // ===============================================================

        const estimatedFeeWei = gasLimit * gasPrice;
        const estimatedFeeEth = formatEther(estimatedFeeWei);
        const ethPriceUsd = await getEthPriceInUsd();
        const estimatedFeeUsd = parseFloat(estimatedFeeEth) * ethPriceUsd;

        await ctx.editMessageText(
            `⏳ Executing ${percentage}% Zap Out...\n\n` +
            `*Est. Fee:*\n` +
            `Gas Price: ~${parseFloat(formatUnits(gasPrice, "gwei")).toFixed(1)} Gwei\n` +
            `Tx Fee: ~$${estimatedFeeUsd.toFixed(4)}`,
            { parse_mode: 'Markdown' }
        );

        const zapOutTx = await zapperContract.zapOut(
            WETH_ADDRESS, position.tokenAddress, liquidityToZap, WETH_ADDRESS, 0n, 0n, 0n,
            wallet.address, deadline, SLIPPAGE_BPS, txOptions
        );

        log("info", `Zap-out transaction submitted: ${zapOutTx.hash}`);
        await ctx.reply(`Transaction submitted! View on Etherscan: https://etherscan.io/tx/${zapOutTx.hash}`);
        await zapOutTx.wait();
        log("info", `Zap-out transaction confirmed.`);

        let newPositions = await loadPositions();
        if (percentage === 100) {
            newPositions.splice(positionIndex, 1);
            positionIndex = Math.max(0, positionIndex - 1);
            (ctx.session ?? (ctx.session = {})).positionIndex = positionIndex;
        }
        await savePositions(newPositions);
        await ctx.reply(`✅ ${percentage}% Zap Out successful!`);

        if (newPositions.length > 0) {
            await displayPosition(ctx, true);
        } else {
            await ctx.editMessageText("All positions have been closed.", { reply_markup: undefined });
        }
    } catch (e) {
        log("error", "Zap Out Error:", e);
        await ctx.reply(`❌ Zap Out failed: ${e.reason || e.message}`);
        await displayPosition(ctx, true);
    }
});

// =================================================================
// --- DISPLAY LOGIC ---
// =================================================================

async function generateZapInTokenMessage(tokenAddress) {
    const [tokenInfo, pairInfo, ethPriceUsd] = await Promise.all([
        getTokenInfo(tokenAddress),
        getPairInfo(tokenAddress),
        getEthPriceInUsd()
    ]);

    let gasPriceGwei = 'N/A';
    let estimatedFeeUsd = 0;
    try {
        const { gasPrice } = await getTxOptions();
        const ESTIMATED_ZAPIN_GAS_LIMIT = 400000n;
        const estimatedFeeWei = ESTIMATED_ZAPIN_GAS_LIMIT * gasPrice;
        estimatedFeeUsd = parseFloat(formatEther(estimatedFeeWei)) * ethPriceUsd;
        gasPriceGwei = parseFloat(formatUnits(gasPrice, "gwei")).toFixed(1);
    } catch (e) { log('warn', 'Could not get gas estimate for display', e.message); }

    const mcapEth = parseFloat(pairInfo.marketCap);
    const mcapUsd = mcapEth * ethPriceUsd;
    const priceEth = parseFloat(pairInfo.price);
    const priceUsdString = (priceEth * ethPriceUsd).toPrecision(8);

    const messageText = `*Token Found:*
*Name:* ${tokenInfo.name} (${tokenInfo.symbol})
*Address:* \`${tokenAddress}\`
*Market Cap:* $${mcapUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })}
*Price:* $${priceUsdString} / ${priceEth.toFixed(18)} ETH

*Network Estimate (Etherscan Fast):*
Gas Price: ${gasPriceGwei} Gwei
Est. Tx Fee: $${estimatedFeeUsd.toFixed(4)}

How much ETH would you like to zap in?
_(Updated: ${new Date().toLocaleTimeString()})_`;

    const keyboard = new InlineKeyboard()
        .text("0.001", "zap_amount:0.001").text("0.003", "zap_amount:0.003").row()
        .text("0.005", "zap_amount:0.005").text("0.008", "zap_amount:0.008").row()
        .text('🔄 Refresh', `refresh_zap:${tokenAddress}`);

    return { messageText, keyboard };
}

async function generatePositionMessage(position) {
    const [pairContract, tokenInfo, currentPairInfo, ethPriceUsd] = await Promise.all([
        new Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, provider),
        getTokenInfo(position.tokenAddress),
        getPairInfo(position.tokenAddress),
        getEthPriceInUsd()
    ]);

    const [reserves, lpBalance, pairTotalSupply, token0] = await Promise.all([
        pairContract.getReserves(),
        pairContract.balanceOf(wallet.address),
        pairContract.totalSupply(),
        pairContract.token0()
    ]);

    if (pairTotalSupply === 0n) throw new Error("Pool has no liquidity.");

    const [reserveWETH,] = getAddress(token0) === getAddress(WETH_ADDRESS)
        ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];

    const userLpValueWei = (reserveWETH * 2n * lpBalance) / pairTotalSupply;
    const userLpValueEth = parseFloat(formatEther(userLpValueWei));
    const userLpValueUsd = userLpValueEth * ethPriceUsd;
    const initialMarketCapEth = parseFloat(position.initialMarketCap);
    const currentMarketCapEth = parseFloat(currentPairInfo.marketCap);
    const initialMarketCapUsd = initialMarketCapEth > 0 ? initialMarketCapEth * ethPriceUsd : 0;
    const currentMarketCapUsd = currentMarketCapEth * ethPriceUsd;
    const mcapProfitPercent = initialMarketCapEth > 0 ? ((currentMarketCapEth - initialMarketCapEth) / initialMarketCapEth) * 100 : 0;
    const userSharePercent = Number((lpBalance * 10000n) / pairTotalSupply) / 100;

    let gasPriceGwei = 'N/A', estimatedFeeUsd = 0;
    try {
        const { gasPrice } = await getTxOptions();
        const estimatedGasLimit = 300000n;
        const estimatedFeeWei = estimatedGasLimit * gasPrice;
        estimatedFeeUsd = parseFloat(formatEther(estimatedFeeWei)) * ethPriceUsd;
        gasPriceGwei = parseFloat(formatUnits(gasPrice, "gwei")).toFixed(1);
    } catch (e) { log('warn', 'Could not get gas estimate for display', e.message); }

    const formatUsd = (val) => val.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

    const messageText = `*${tokenInfo.name} (${tokenInfo.symbol})*
Position Value: ${userLpValueEth.toFixed(6)} ETH (~$${userLpValueUsd.toFixed(2)})
*Address:* \`${position.tokenAddress}\`

Initial MCAP: ${formatUsd(initialMarketCapUsd)}
Current MCAP: ${formatUsd(currentMarketCapUsd)}
Token MCAP P/L: ${mcapProfitPercent >= 0 ? '📈 +' : '📉 '}${mcapProfitPercent.toFixed(2)}%

Pool Share: ${userSharePercent.toFixed(4)}%

*Est. Zap Out (Etherscan Fast):*
Gas Price: ${gasPriceGwei} Gwei
Est. Tx Fee: $${estimatedFeeUsd.toFixed(4)}
_(Updated: ${new Date().toLocaleTimeString()})_`;

    const keyboard = new InlineKeyboard()
        .text('⬅️ Prev', 'prev_pos').text('🔄 Refresh', 'refresh_pos').text('Next ➡️', 'next_pos').row()
        .text('🔥 Zap Out 50%', 'execute_zapout:50')
        .text('💥 Zap Out 100%', 'execute_zapout:100');

    return { messageText, keyboard };
}

async function displayPosition(ctx, edit = false) {
    const chatId = ctx.chat.id;
    stopWatcher(chatId);
    const positions = await loadPositions();
    const index = ctx.session?.positionIndex ?? 0;

    if (!positions[index]) {
        const message = "You have no open positions.";
        edit ? await bot.api.editMessageText(chatId, ctx.callbackQuery.message.message_id, message, { reply_markup: undefined }) : await ctx.reply(message);
        return;
    }

    let waitMessage;
    try {
        if (edit) {
            waitMessage = ctx.callbackQuery.message;
            await bot.api.editMessageText(chatId, waitMessage.message_id, `⏳ Loading position ${index + 1}/${positions.length}...`, { reply_markup: undefined });
        } else {
            waitMessage = await ctx.reply(`⏳ Loading position ${index + 1}/${positions.length}...`);
        }

        const { messageText, keyboard } = await generatePositionMessage(positions[index]);
        await bot.api.editMessageText(chatId, waitMessage.message_id, messageText, { parse_mode: 'Markdown', reply_markup: keyboard });
        const sentMessageId = waitMessage.message_id;

        const intervalId = setInterval(async () => {
            try {
                if (!activeWatchers.has(chatId) || activeConversations.has(chatId)) return;
                const currentPositions = await loadPositions();
                const currentPosition = currentPositions[index];
                if (!currentPosition) {
                    stopWatcher(chatId);
                    await bot.api.editMessageText(chatId, sentMessageId, "Position has been closed.", { reply_markup: undefined }).catch(e => log("warn", "Edit failed, msg deleted", e));
                    return;
                }
                const { messageText: newText, keyboard: newKeyboard } = await generatePositionMessage(currentPosition);
                await bot.api.editMessageText(chatId, sentMessageId, newText, { parse_mode: 'Markdown', reply_markup: newKeyboard, }).catch(e => {
                    if (!e?.description?.includes("message is not modified")) throw e;
                });
            } catch (error) {
                log('error', `Auto-refresh failed for chat ${chatId}:`, error);
                if (error instanceof GrammyError && (error.description?.includes("message to edit not found"))) {
                    stopWatcher(chatId);
                }
            }
        }, 15000); // Refresh every 15 seconds

        activeWatchers.set(chatId, { intervalId });
    } catch (e) {
        log("error", "Display Position Error:", e);
        const errorMessage = `❌ Could not load position data: ${e.message}`;
        if (waitMessage) await bot.api.editMessageText(chatId, waitMessage.message_id, errorMessage);
        else await ctx.reply(errorMessage);
    }
}

// =================================================================
// --- BOT ERROR HANDLING & STARTUP ---
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
        await bot.api.getMe();
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