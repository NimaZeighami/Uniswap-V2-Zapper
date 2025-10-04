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
// --- LOGGING & ENVIRONMENT VALIDATION ---
// =================================================================

const log = (level, message, ...args) => {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, message, ...args);
};

const requiredEnvVars = [
    'RPC_URL', 'PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'ETHERSCAN_API_KEY',
    'ZAPPER_ADDRESS', 'UNISWAP_V2_FACTORY_ADDRESS', 'WETH_ADDRESS', 'UNISWAP_V2_ROUTER_ADDRESS'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    log("error", `FATAL ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
    log("error", "Please check your .env file and ensure all variables are set correctly.");
    process.exit(1);
}

// =================================================================
// --- CONSTANTS & CONFIGURATION ---
// =================================================================

const CONSTANTS = {
    ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,
    ZAPPER_ADDRESS: process.env.ZAPPER_ADDRESS,
    UNISWAP_V2_FACTORY_ADDRESS: process.env.UNISWAP_V2_FACTORY_ADDRESS,
    WETH_ADDRESS: process.env.WETH_ADDRESS,
    UNISWAP_V2_ROUTER_ADDRESS: process.env.UNISWAP_V2_ROUTER_ADDRESS,
    POSITIONS_FILE_PATH: process.env.POSITIONS_FILE_PATH || './positions.json',

    // Transaction settings
    SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS) || 2000,
    DEADLINE_MINUTES: parseInt(process.env.DEADLINE_MINUTES) || 3,

    // Caching settings
    CACHE_DURATION_SECONDS: parseInt(process.env.CACHE_DURATION_SECONDS) || 10,
    AUTO_REFRESH_INTERVAL_MS: parseInt(process.env.AUTO_REFRESH_INTERVAL_MS) || 15000,

    // Gas estimation settings
    ZAP_IN_GAS_LIMIT_ESTIMATE: BigInt(process.env.ZAP_IN_GAS_LIMIT_ESTIMATE || '500000'),
    ZAP_OUT_GAS_LIMIT_BUFFER_PERCENT: BigInt(process.env.ZAP_OUT_GAS_LIMIT_BUFFER_PERCENT || '130'),

    // Dynamic slippage settings
    ENABLE_DYNAMIC_SLIPPAGE: process.env.ENABLE_DYNAMIC_SLIPPAGE === 'true',
    MIN_SLIPPAGE_BPS: parseInt(process.env.MIN_SLIPPAGE_BPS) || 50,
    MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS) || 5000,

    // Gas price settings
    GAS_SPEED: process.env.GAS_SPEED || 'fast', // 'safe', 'standard', 'fast', 'instant'
    GAS_SPEED_MULTIPLIER: parseFloat(process.env.GAS_SPEED_MULTIPLIER) || 1.0,
    PRIORITY_FEE_GWEI: parseFloat(process.env.PRIORITY_FEE_GWEI) || 2.0,
    MAX_GAS_PRICE_GWEI: parseFloat(process.env.MAX_GAS_PRICE_GWEI) || 200.0,
    DEFAULT_GAS_PRICE_GWEI: parseFloat(process.env.DEFAULT_GAS_PRICE_GWEI) || 30.0,

    // Zap amount presets
    ZAP_AMOUNT_PRESETS: process.env.ZAP_AMOUNT_PRESETS
        ? process.env.ZAP_AMOUNT_PRESETS.split(',').map(a => a.trim())
        : ['0.001', '0.003', '0.005', '0.008'],

    // Zap out percentage options
    ZAP_OUT_PERCENTAGES: process.env.ZAP_OUT_PERCENTAGES
        ? process.env.ZAP_OUT_PERCENTAGES.split(',').map(p => parseInt(p.trim()))
        : [25, 50, 75, 100]
};

// ABIs for interacting with smart contracts
const ZAPPER_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "tokenOther", "type": "address" },
            { "internalType": "uint256", "name": "amountAMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountBMin", "type": "uint256" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" },
            { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }
        ],
        "name": "zapInETH",
        "outputs": [{ "internalType": "uint256", "name": "liquidity", "type": "uint256" }],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "tokenA", "type": "address" },
            { "internalType": "address", "name": "tokenB", "type": "address" },
            { "internalType": "uint256", "name": "liquidity", "type": "uint256" },
            { "internalType": "address", "name": "tokenOut", "type": "address" },
            { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountAMin", "type": "uint256" },
            { "internalType": "uint256", "name": "amountBMin", "type": "uint256" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "deadline", "type": "uint256" },
            { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }
        ],
        "name": "zapOut",
        "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const UNISWAP_V2_FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const UNISWAP_V2_PAIR_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() view returns (uint256)'
];

const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)"
];

const UNISWAP_V2_ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

// =================================================================
// --- ETHEREUM & CONTRACT SETUP ---
// =================================================================

const provider = new JsonRpcProvider(process.env.RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const zapperContract = new Contract(CONSTANTS.ZAPPER_ADDRESS, ZAPPER_ABI, wallet);
const factoryContract = new Contract(CONSTANTS.UNISWAP_V2_FACTORY_ADDRESS, UNISWAP_V2_FACTORY_ABI, provider);
const routerContract = new Contract(CONSTANTS.UNISWAP_V2_ROUTER_ADDRESS, UNISWAP_V2_ROUTER_ABI, provider);

// =================================================================
// --- CACHING & DATA PERSISTENCE ---
// =================================================================

const apiCache = new Map();

async function getCachedData(key, fetcherFunction, ...args) {
    const now = Date.now();
    const cachedItem = apiCache.get(key);

    if (cachedItem && (now - cachedItem.timestamp) < (CONSTANTS.CACHE_DURATION_SECONDS * 1000)) {
        return cachedItem.data;
    }

    log('info', `[CACHE MISS] Fetching new data for key: ${key}`);
    try {
        const data = await fetcherFunction(...args);
        apiCache.set(key, { data, timestamp: now });
        return data;
    } catch (error) {
        log('error', `Failed to fetch data for ${key}: ${error.message}`);
        if (cachedItem) {
            log('warn', `[CACHE STALE] Returning stale data for key: ${key}`);
            return cachedItem.data;
        }
        throw error;
    }
}

async function loadPositions() {
    try {
        await fs.access(CONSTANTS.POSITIONS_FILE_PATH);
        const data = await fs.readFile(CONSTANTS.POSITIONS_FILE_PATH, 'utf-8');
        const positions = JSON.parse(data);
        log("info", `Loaded ${positions.length} position(s) from ${CONSTANTS.POSITIONS_FILE_PATH}`);
        return positions;
    } catch (error) {
        log("warn", `${CONSTANTS.POSITIONS_FILE_PATH} not found. Starting with an empty list.`);
        return [];
    }
}

async function savePositions(positions) {
    try {
        await fs.writeFile(CONSTANTS.POSITIONS_FILE_PATH, JSON.stringify(positions, null, 2));
        log("info", `Successfully saved ${positions.length} position(s) to ${CONSTANTS.POSITIONS_FILE_PATH}`);
    } catch (error) {
        log("error", "Failed to save positions.json:", error);
    }
}

// =================================================================
// --- BLOCKCHAIN HELPER FUNCTIONS ---
// =================================================================

async function fetchTokenInfo(tokenAddress) {
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);
    try {
        const [name, symbol, decimals] = await Promise.all([
            contract.name(),
            contract.symbol(),
            contract.decimals()
        ]);
        return { name, symbol, decimals: BigInt(decimals) };
    } catch (error) {
        log("warn", `Could not fetch token info for ${tokenAddress}. Using defaults.`);
        return { name: "Unknown Token", symbol: "UNKNOWN", decimals: 18n };
    }
}

async function fetchPairInfo(tokenOtherAddress) {
    const pairAddress = await factoryContract.getPair(CONSTANTS.WETH_ADDRESS, tokenOtherAddress);
    if (pairAddress === ZeroAddress) {
        throw new Error("Pair does not exist for this token. Please ensure the token has a WETH pair on Uniswap V2.");
    }

    const pairContract = new Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);
    const tokenOtherContract = new Contract(tokenOtherAddress, ERC20_ABI, provider);

    const [reserves, token0, tokenTotalSupply, tokenDecimalsNum] = await Promise.all([
        pairContract.getReserves(),
        pairContract.token0(),
        tokenOtherContract.totalSupply(),
        tokenOtherContract.decimals().catch(() => 18)
    ]);

    const tokenDecimals = BigInt(tokenDecimalsNum);
    const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(CONSTANTS.WETH_ADDRESS)
        ? [reserves[0], reserves[1]]
        : [reserves[1], reserves[0]];

    if (reserveToken === 0n || reserveWETH === 0n) {
        return { pairAddress, price: '0', marketCap: '0', reserveWETH: 0n, reserveToken: 0n };
    }

    const priceInWei = (reserveWETH * (10n ** tokenDecimals)) / reserveToken;
    const marketCapInWei = (reserveWETH * tokenTotalSupply) / reserveToken;

    return {
        pairAddress,
        price: formatEther(priceInWei),
        marketCap: formatEther(marketCapInWei),
        reserveWETH,
        reserveToken
    };
}

async function fetchTxOptionsFromEtherscan() {
    // Use Etherscan V2 API with correct endpoint
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${CONSTANTS.ETHERSCAN_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (data.status !== '1') throw new Error(`Etherscan API error: ${data.message || data.result}`);

    // V2 API returns: SafeGasPrice, ProposeGasPrice, FastGasPrice, suggestBaseFee
    const safeGasPriceGwei = parseFloat(data.result.SafeGasPrice);
    const proposeGasPriceGwei = parseFloat(data.result.ProposeGasPrice);
    const fastGasPriceGwei = parseFloat(data.result.FastGasPrice);
    const baseFeeGwei = parseFloat(data.result.suggestBaseFee);

    // Select gas price based on speed setting
    let selectedGasPriceGwei;
    let speedName;
    switch (CONSTANTS.GAS_SPEED.toLowerCase()) {
        case 'safe':
            selectedGasPriceGwei = safeGasPriceGwei;
            speedName = 'Safe';
            break;
        case 'standard':
            selectedGasPriceGwei = proposeGasPriceGwei;
            speedName = 'Standard';
            break;
        case 'fast':
            selectedGasPriceGwei = fastGasPriceGwei;
            speedName = 'Fast';
            break;
        case 'instant':
            // Instant = Fast * 1.2 (20% boost for ultra-fast confirmation)
            selectedGasPriceGwei = fastGasPriceGwei * 1.2;
            speedName = 'Instant';
            break;
        default:
            selectedGasPriceGwei = fastGasPriceGwei;
            speedName = 'Fast (default)';
    }

    // Apply multiplier for custom speed control
    selectedGasPriceGwei = selectedGasPriceGwei * CONSTANTS.GAS_SPEED_MULTIPLIER;

    // Calculate priority fee (must be less than maxFee)
    const rawPriorityFeeGwei = Math.max(CONSTANTS.PRIORITY_FEE_GWEI, selectedGasPriceGwei - baseFeeGwei);

    // Cap maxFeePerGas at MAX_GAS_PRICE_GWEI
    const cappedMaxFeeGwei = Math.min(selectedGasPriceGwei, CONSTANTS.MAX_GAS_PRICE_GWEI);

    // Ensure priority fee is less than or equal to max fee
    const priorityFeeGwei = Math.min(rawPriorityFeeGwei, cappedMaxFeeGwei);

    const maxFeePerGas = parseUnits(cappedMaxFeeGwei.toFixed(9), 'gwei');
    const maxPriorityFeePerGas = parseUnits(priorityFeeGwei.toFixed(9), 'gwei');

    log('info', `Gas from Etherscan V2 [${speedName}${CONSTANTS.GAS_SPEED_MULTIPLIER !== 1.0 ? ` x${CONSTANTS.GAS_SPEED_MULTIPLIER}` : ''}]: Max ${cappedMaxFeeGwei.toFixed(2)} Gwei, Priority ${priorityFeeGwei.toFixed(2)} Gwei (Base: ${baseFeeGwei.toFixed(2)})`);
    return {
        gasPrice: maxFeePerGas,
        maxFeePerGas,
        maxPriorityFeePerGas
    };
}

async function fetchTxOptionsFromRPC() {
    log('info', 'Fetching gas price from RPC provider...');
    const feeData = await provider.getFeeData();

    if (!feeData.maxFeePerGas) {
        throw new Error('Could not fetch gas price from RPC');
    }

    // Cap the gas price
    const maxGasPrice = parseUnits(CONSTANTS.MAX_GAS_PRICE_GWEI.toString(), 'gwei');
    const maxFeePerGas = feeData.maxFeePerGas > maxGasPrice ? maxGasPrice : feeData.maxFeePerGas;

    // Ensure priority fee is less than or equal to max fee
    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || parseUnits(CONSTANTS.PRIORITY_FEE_GWEI.toString(), 'gwei');
    if (maxPriorityFeePerGas > maxFeePerGas) {
        maxPriorityFeePerGas = maxFeePerGas;
    }

    const gasPriceGwei = parseFloat(formatUnits(maxFeePerGas, 'gwei'));
    const priorityGwei = parseFloat(formatUnits(maxPriorityFeePerGas, 'gwei'));
    log('info', `Gas from RPC: Max ${gasPriceGwei.toFixed(2)} Gwei, Priority ${priorityGwei.toFixed(2)} Gwei`);

    return {
        gasPrice: maxFeePerGas,
        maxFeePerGas,
        maxPriorityFeePerGas
    };
}

async function fetchTxOptions() {
    // Try Etherscan first
    try {
        return await fetchTxOptionsFromEtherscan();
    } catch (error) {
        log("warn", `Could not fetch gas price from Etherscan: ${error.message}. Trying RPC fallback...`);
    }

    // Fallback to RPC provider
    try {
        return await fetchTxOptionsFromRPC();
    } catch (error) {
        log("warn", `Could not fetch gas price from RPC: ${error.message}. Using default values...`);
    }

    // Final fallback: use default gas price
    const defaultGasPrice = parseUnits(CONSTANTS.DEFAULT_GAS_PRICE_GWEI.toString(), 'gwei');
    const defaultPriorityFee = parseUnits(CONSTANTS.PRIORITY_FEE_GWEI.toString(), 'gwei');

    log('info', `Using default gas price: ${CONSTANTS.DEFAULT_GAS_PRICE_GWEI} Gwei`);
    return {
        gasPrice: defaultGasPrice,
        maxFeePerGas: defaultGasPrice,
        maxPriorityFeePerGas: defaultPriorityFee
    };
}

async function fetchEthPriceInUsd() {
    // Use Etherscan V2 API
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethprice&apikey=${CONSTANTS.ETHERSCAN_API_KEY}`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        if (data.status !== '1') throw new Error(`Etherscan API error: ${data.message || data.result}`);
        const ethPrice = parseFloat(data.result.ethusd);
        log('info', `ETH price from Etherscan V2: $${ethPrice.toFixed(2)}`);
        return ethPrice;
    } catch (error) {
        log('warn', `Could not fetch ETH price from Etherscan V2: ${error.message}. Defaulting to 0.`);
        return 0;
    }
}

function calculatePriceImpact(amountIn, reserveIn, reserveOut) {
    if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0;

    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * 1000n) + amountInWithFee;
    const amountOut = numerator / denominator;

    const priceBefore = Number(reserveOut) / Number(reserveIn);
    const priceAfter = Number(reserveOut - amountOut) / Number(reserveIn + amountIn);

    return Math.abs((priceAfter - priceBefore) / priceBefore) * 100;
}

function calculateDynamicSlippage(reserveIn, reserveOut, amountIn) {
    if (!CONSTANTS.ENABLE_DYNAMIC_SLIPPAGE) {
        return CONSTANTS.SLIPPAGE_BPS;
    }

    const priceImpact = calculatePriceImpact(amountIn, reserveIn, reserveOut);

    let slippageBps;
    if (priceImpact < 0.5) {
        slippageBps = CONSTANTS.MIN_SLIPPAGE_BPS;
    } else if (priceImpact < 2) {
        slippageBps = 100;
    } else if (priceImpact < 5) {
        slippageBps = 200;
    } else if (priceImpact < 10) {
        slippageBps = 500;
    } else {
        slippageBps = Math.min(CONSTANTS.MAX_SLIPPAGE_BPS, Math.ceil(priceImpact * 100));
    }

    log('info', `Price impact: ${priceImpact.toFixed(2)}%, Dynamic slippage: ${(slippageBps / 100).toFixed(2)}%`);
    return slippageBps;
}

function calculateAmountOut(amountIn, reserveIn, reserveOut) {
    if (amountIn === 0n) return 0n;
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * 1000n) + amountInWithFee;
    return numerator / denominator;
}

const getCachedTokenInfo = (tokenAddress) => getCachedData(`tokenInfo:${tokenAddress}`, fetchTokenInfo, tokenAddress);
const getCachedPairInfo = (tokenAddress) => getCachedData(`pairInfo:${tokenAddress}`, fetchPairInfo, tokenAddress);
const getCachedTxOptions = () => getCachedData('txOptions', fetchTxOptions);
const getCachedEthPriceInUsd = () => getCachedData('ethPrice', fetchEthPriceInUsd);

async function validateBalance(amountIn, estimatedGasFee) {
    const balance = await provider.getBalance(wallet.address);
    const totalRequired = amountIn + estimatedGasFee;

    if (balance < totalRequired) {
        const shortfall = totalRequired - balance;
        throw new Error(
            `Insufficient ETH. You need ${formatEther(totalRequired)} ETH total (${formatEther(amountIn)} for zap + ${formatEther(estimatedGasFee)} for gas), but you only have ${formatEther(balance)} ETH. Please add ${formatEther(shortfall)} ETH to your wallet.`
        );
    }
}

// =================================================================
// --- TELEGRAM CONVERSATIONS ---
// =================================================================

const activeConversations = new Set();

async function zapInConversation(conversation, ctx) {
    activeConversations.add(ctx.chat.id);
    let mainMessage;

    try {
        mainMessage = await ctx.reply("🔍 Please provide the token contract address to pair with ETH.\n\n_Make sure it has a WETH pair on Uniswap V2._", { parse_mode: 'Markdown' });
        const tokenAddressMsg = await conversation.wait();
        const tokenAddressText = tokenAddressMsg.message?.text;

        try {
            await ctx.api.deleteMessage(ctx.chat.id, tokenAddressMsg.message.message_id);
        } catch (e) { log('warn', 'Could not delete user message', e.description); }

        if (!tokenAddressText || !isAddress(tokenAddressText)) {
            await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, "❌ Invalid Ethereum address. Please try again with /zapin");
            return;
        }

        const tokenAddress = getAddress(tokenAddressText);
        await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, '⏳ Fetching token and pair data...');

        await displayZapInInfo(ctx, mainMessage.message_id, tokenAddress);

        let keepWaiting = true;
        while (keepWaiting) {
            const response = await conversation.waitFor(["message:text", "callback_query"]);
            let ethAmount;

            if (response.callbackQuery) await response.answerCallbackQuery();

            if (response.callbackQuery?.data.startsWith('zap_amount:')) {
                ethAmount = response.callbackQuery.data.split(':')[1];
                keepWaiting = false;
            } else if (response.callbackQuery?.data.startsWith('refresh_zap:')) {
                await displayZapInInfo(ctx, mainMessage.message_id, tokenAddress);
                continue;
            } else if (response.message?.text) {
                const potentialAmount = response.message.text;
                try {
                    await ctx.api.deleteMessage(ctx.chat.id, response.message.message_id);
                } catch (e) { log('warn', 'Could not delete user message', e.description); }

                if (potentialAmount && !isNaN(parseFloat(potentialAmount)) && parseFloat(potentialAmount) > 0) {
                    ethAmount = potentialAmount;
                    keepWaiting = false;
                } else {
                    await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, "❌ Invalid amount. Please enter a valid number or use /zapin to start again.", { reply_markup: undefined });
                    return;
                }
            } else { continue; }

            if (!keepWaiting) {
                await executeZapIn(ctx, mainMessage.message_id, tokenAddress, ethAmount);
                break;
            }
        }
    } catch (e) {
        log('error', "Error in zapInConversation", e);
        if (mainMessage) {
            await ctx.api.editMessageText(ctx.chat.id, mainMessage.message_id, `❌ An unexpected error occurred: ${e.message}`)
                .catch(err => log('error', 'Failed to send final error message.', err));
        }
    } finally {
        activeConversations.delete(ctx.chat.id);
    }
}

// =================================================================
// --- TRANSACTION EXECUTION LOGIC ---
// =================================================================

async function executeZapIn(ctx, messageId, tokenAddress, ethAmount) {
    if (!ethAmount || isNaN(parseFloat(ethAmount)) || parseFloat(ethAmount) <= 0) {
        await ctx.api.editMessageText(ctx.chat.id, messageId, "❌ Invalid amount. Please use /zapin to start again.");
        return;
    }

    const amountIn = parseEther(ethAmount);
    await ctx.api.editMessageText(ctx.chat.id, messageId, `⏳ Preparing to zap ${ethAmount} ETH...`, { reply_markup: undefined });

    try {
        const deadline = Math.floor(Date.now() / 1000) + (CONSTANTS.DEADLINE_MINUTES * 60);

        const pairInfo = await getCachedPairInfo(tokenAddress);
        const pairContract = new Contract(pairInfo.pairAddress, UNISWAP_V2_PAIR_ABI, provider);
        const reserves = await pairContract.getReserves();
        const token0 = await pairContract.token0();

        const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(CONSTANTS.WETH_ADDRESS)
            ? [reserves[0], reserves[1]]
            : [reserves[1], reserves[0]];

        const amountToSwap = amountIn / 2n;
        const dynamicSlippageBps = calculateDynamicSlippage(reserveWETH, reserveToken, amountToSwap);

        const expectedAmountToken = calculateAmountOut(amountToSwap, reserveWETH, reserveToken);
        const slippageMultiplier = 10000n - BigInt(dynamicSlippageBps);
        const amountAMin = (amountToSwap * slippageMultiplier) / 10000n;
        const amountBMin = (expectedAmountToken * slippageMultiplier) / 10000n;

        const txOptionsData = await getCachedTxOptions();
        const estimatedGasFee = CONSTANTS.ZAP_IN_GAS_LIMIT_ESTIMATE * txOptionsData.gasPrice;
        await validateBalance(amountIn, estimatedGasFee);

        const txOptions = {
            value: amountIn,
            gasLimit: CONSTANTS.ZAP_IN_GAS_LIMIT_ESTIMATE,
            maxFeePerGas: txOptionsData.maxFeePerGas,
            maxPriorityFeePerGas: txOptionsData.maxPriorityFeePerGas
        };

        const ethPriceUsd = await getCachedEthPriceInUsd();
        const estimatedFeeUsd = parseFloat(formatEther(estimatedGasFee)) * ethPriceUsd;

        await ctx.api.editMessageText(ctx.chat.id, messageId,
            `🚀 **Zapping ${ethAmount} ETH...**\n\n` +
            `*Transaction Details:*\n` +
            `Gas Price: ~${parseFloat(formatUnits(txOptionsData.gasPrice, "gwei")).toFixed(1)} Gwei\n` +
            `Est. Fee: ~$${estimatedFeeUsd.toFixed(4)}\n` +
            `Slippage: ${(dynamicSlippageBps / 100).toFixed(2)}%\n\n` +
            `_Sending transaction..._`,
            { parse_mode: 'Markdown' });

        const tx = await zapperContract.zapInETH(
            tokenAddress,
            amountAMin,
            amountBMin,
            wallet.address,
            deadline,
            dynamicSlippageBps,
            txOptions
        );

        log("info", `Zap-in transaction submitted: ${tx.hash}`);
        await ctx.api.editMessageText(ctx.chat.id, messageId,
            `✅ Transaction sent! Waiting for confirmation...\n\n[View on Etherscan](https://etherscan.io/tx/${tx.hash})`,
            { parse_mode: 'Markdown', disable_web_page_preview: true });

        const receipt = await tx.wait();
        log("info", `Zap-in confirmed in block ${receipt.blockNumber} for ${ethAmount} ETH with token ${tokenAddress}`);

        await updateAndSavePosition(tokenAddress, ethAmount);

        const tokenInfo = await getCachedTokenInfo(tokenAddress);
        const keyboard = new InlineKeyboard().text("📊 View Position", "show_position");
        await ctx.api.editMessageText(ctx.chat.id, messageId,
            `✅ **Zap In Successful!**\n\n` +
            `Token: ${tokenInfo.symbol}\n` +
            `Amount: ${ethAmount} ETH\n` +
            `Block: ${receipt.blockNumber}`,
            { reply_markup: keyboard, parse_mode: 'Markdown' });

    } catch (e) {
        log("error", "Zap In execution error:", e);
        let errorMessage = "An unknown error occurred.";

        if (e.code === 'INSUFFICIENT_FUNDS') {
            errorMessage = "Insufficient ETH to cover zap amount and gas fees.";
        } else if (e.message && e.message.includes('slippage')) {
            errorMessage = "Transaction would fail due to price slippage. Try again with higher slippage tolerance.";
        } else if (e.message && e.message.includes('priorityFee')) {
            errorMessage = "Gas price configuration error. The bot will use fallback gas prices. Please try again.";
        } else if (e.reason) {
            errorMessage = e.reason.substring(0, 200); // Limit length
        } else if (e.message) {
            errorMessage = e.message.substring(0, 200); // Limit length
        }

        // Escape markdown special characters
        errorMessage = errorMessage.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

        await ctx.api.editMessageText(ctx.chat.id, messageId,
            `❌ *Zap In Failed*\n\n*Reason:* ${errorMessage}`,
            { parse_mode: 'Markdown' });
    }
}

async function updateAndSavePosition(tokenAddress, ethAmount) {
    const positions = await loadPositions();
    const pairInfo = await getCachedPairInfo(tokenAddress);
    const existingIndex = positions.findIndex(p => getAddress(p.tokenAddress) === getAddress(tokenAddress));

    if (existingIndex > -1) {
        const pos = positions[existingIndex];
        const oldEth = parseFloat(pos.initialEthValue);
        const newEth = parseFloat(ethAmount);
        const oldMCap = parseFloat(pos.initialMarketCap);
        const newMCap = parseFloat(pairInfo.marketCap);
        const totalEth = oldEth + newEth;
        pos.initialMarketCap = (((oldMCap * oldEth) + (newMCap * newEth)) / totalEth).toString();
        pos.initialEthValue = totalEth.toString();
        pos.timestamp = Date.now();
    } else {
        positions.push({
            tokenAddress,
            pairAddress: pairInfo.pairAddress,
            initialEthValue: ethAmount,
            initialMarketCap: pairInfo.marketCap,
            timestamp: Date.now()
        });
    }
    await savePositions(positions);
}

// =================================================================
// --- TELEGRAM BOT SETUP & MIDDLEWARE ---
// =================================================================

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const activeWatchers = new Map();

function stopWatcher(chatId) {
    if (activeWatchers.has(chatId)) {
        clearInterval(activeWatchers.get(chatId));
        activeWatchers.delete(chatId);
        log('info', `Stopped auto-refresh for chat ID: ${chatId}`);
    }
}

bot.use(session({ initial: () => ({ positionIndex: 0 }) }));
bot.use(conversations());
bot.use(createConversation(zapInConversation));

// =================================================================
// --- COMMAND HANDLERS ---
// =================================================================

bot.command("start", (ctx) => {
    stopWatcher(ctx.chat.id);
    ctx.reply(
        "🚀 **Welcome to Enhanced Uniswap V2 Zapper Bot!**\n\n" +
        "✨ **Features:**\n" +
        "• Dynamic slippage protection\n" +
        "• Optimized gas management (EIP-1559)\n" +
        "• Real-time position tracking\n" +
        "• Enhanced error handling\n" +
        "• Price impact calculation\n\n" +
        "**Commands:**\n" +
        "/zapin - Add liquidity to a pool\n" +
        "/positions - View and manage positions\n" +
        "/help - Show help and instructions\n" +
        "/status - Check bot and wallet status",
        { parse_mode: 'Markdown' }
    );
});

bot.command("help", (ctx) => {
    ctx.reply(
        "📖 **Zapper Bot Help**\n\n" +
        "**How to Zap In:**\n" +
        "1. Use /zapin command\n" +
        "2. Enter token contract address\n" +
        "3. Review token info and choose amount\n" +
        "4. Confirm transaction\n\n" +
        "**How to Zap Out:**\n" +
        "1. Use /positions command\n" +
        "2. Navigate to your position\n" +
        "3. Choose zap out percentage\n" +
        "4. Confirm transaction\n\n" +
        "**Features Explained:**\n" +
        "• *Dynamic Slippage*: Auto-adjusts based on price impact\n" +
        "• *Gas Optimization*: Uses EIP-1559 with configurable limits\n" +
        "• *Auto-Refresh*: Position data updates every 15 seconds\n" +
        "• *Error Recovery*: Clear error messages and recovery steps\n\n" +
        "**Support:**\n" +
        "For issues, check your .env configuration and ensure:\n" +
        "- Valid RPC URL\n" +
        "- Sufficient ETH balance\n" +
        "- Correct contract addresses",
        { parse_mode: 'Markdown' }
    );
});

bot.command("status", async (ctx) => {
    try {
        const balance = await provider.getBalance(wallet.address);
        const ethPrice = await getCachedEthPriceInUsd();
        const gasData = await getCachedTxOptions();
        const positions = await loadPositions();

        const statusMessage =
            `📊 **Bot Status**\n\n` +
            `**Wallet:**\n` +
            `Address: \`${wallet.address}\`\n` +
            `Balance: ${parseFloat(formatEther(balance)).toFixed(4)} ETH (~$${(parseFloat(formatEther(balance)) * ethPrice).toFixed(2)})\n\n` +
            `**Network:**\n` +
            `Gas Price: ${parseFloat(formatUnits(gasData.gasPrice, 'gwei')).toFixed(1)} Gwei\n` +
            `ETH Price: $${ethPrice.toFixed(2)}\n\n` +
            `**Positions:**\n` +
            `Open Positions: ${positions.length}\n\n` +
            `**Configuration:**\n` +
            `Dynamic Slippage: ${CONSTANTS.ENABLE_DYNAMIC_SLIPPAGE ? 'Enabled' : 'Disabled'}\n` +
            `Default Slippage: ${CONSTANTS.SLIPPAGE_BPS / 100}%\n` +
            `Gas Limit: ${CONSTANTS.ZAP_IN_GAS_LIMIT_ESTIMATE.toString()}`;

        await ctx.reply(statusMessage, { parse_mode: 'Markdown' });
    } catch (e) {
        log('error', 'Status command error:', e);
        await ctx.reply(`❌ Could not fetch status: ${e.message}`);
    }
});

bot.command("zapin", async (ctx) => {
    stopWatcher(ctx.chat.id);
    await ctx.conversation.enter("zapInConversation");
});

bot.command("positions", async (ctx) => {
    stopWatcher(ctx.chat.id);
    const positions = await loadPositions();
    if (positions.length === 0) {
        await ctx.reply("📭 You have no open LP positions.\n\nUse /zapin to create your first position!");
        return;
    }
    ctx.session.positionIndex = 0;
    await displayPosition(ctx);
});

// =================================================================
// --- CALLBACK QUERY HANDLERS ---
// =================================================================

bot.callbackQuery("show_position", async (ctx) => {
    await ctx.answerCallbackQuery();
    const positions = await loadPositions();
    ctx.session.positionIndex = positions.length - 1;
    await displayPosition(ctx, true);
});

bot.callbackQuery(/^(prev_pos|next_pos)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const positions = await loadPositions();
    if (positions.length === 0) {
        await ctx.editMessageText("No positions found.").catch(e => log("warn", e));
        return;
    }
    const direction = ctx.match[1];
    let index = ctx.session.positionIndex ?? 0;
    index = (direction === 'prev_pos')
        ? (index - 1 + positions.length) % positions.length
        : (index + 1) % positions.length;
    ctx.session.positionIndex = index;
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
    const position = positions[ctx.session.positionIndex];

    if (!position) {
        await ctx.editMessageText("❌ Position not found. It may have been closed.", { reply_markup: undefined });
        return;
    }

    await ctx.editMessageText(`⏳ Processing ${percentage}% Zap Out...`, { reply_markup: undefined });

    try {
        const pairContract = new Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, wallet);
        const lpBalance = await pairContract.balanceOf(wallet.address);

        if (lpBalance === 0n) {
            throw new Error("You have no LP tokens for this pair. The position may have already been closed.");
        }

        const liquidityToZap = (lpBalance * BigInt(percentage)) / 100n;

        log("info", `Approving ${formatEther(liquidityToZap)} LP tokens for zap out...`);
        const approveTx = await pairContract.approve(CONSTANTS.ZAPPER_ADDRESS, liquidityToZap);
        await approveTx.wait();
        log("info", "LP token approval confirmed.");

        const deadline = Math.floor(Date.now() / 1000) + (CONSTANTS.DEADLINE_MINUTES * 60);
        const txOptionsData = await getCachedTxOptions();

        const estimatedGas = await zapperContract.zapOut.estimateGas(
            CONSTANTS.WETH_ADDRESS,
            position.tokenAddress,
            liquidityToZap,
            CONSTANTS.WETH_ADDRESS,
            0n, 0n, 0n,
            wallet.address,
            deadline,
            CONSTANTS.SLIPPAGE_BPS
        );

        const gasLimit = (estimatedGas * CONSTANTS.ZAP_OUT_GAS_LIMIT_BUFFER_PERCENT) / 100n;
        const txOptions = {
            maxFeePerGas: txOptionsData.maxFeePerGas,
            maxPriorityFeePerGas: txOptionsData.maxPriorityFeePerGas,
            gasLimit
        };

        const estimatedFeeWei = gasLimit * txOptionsData.gasPrice;
        const ethPriceUsd = await getCachedEthPriceInUsd();
        const estimatedFeeUsd = parseFloat(formatEther(estimatedFeeWei)) * ethPriceUsd;

        await ctx.editMessageText(
            `⏳ Executing ${percentage}% Zap Out...\n\n` +
            `*Est. Fee:*\n` +
            `Gas Price: ~${parseFloat(formatUnits(txOptionsData.gasPrice, "gwei")).toFixed(1)} Gwei\n` +
            `Tx Fee: ~$${estimatedFeeUsd.toFixed(4)}\n\n` +
            `_Sending transaction..._`,
            { parse_mode: 'Markdown' }
        );

        const zapOutTx = await zapperContract.zapOut(
            CONSTANTS.WETH_ADDRESS,
            position.tokenAddress,
            liquidityToZap,
            CONSTANTS.WETH_ADDRESS,
            0n, 0n, 0n,
            wallet.address,
            deadline,
            CONSTANTS.SLIPPAGE_BPS,
            txOptions
        );

        log("info", `Zap-out transaction submitted: ${zapOutTx.hash}`);
        await ctx.reply(
            `✅ Transaction sent! Waiting for confirmation...\n\n[View on Etherscan](https://etherscan.io/tx/${zapOutTx.hash})`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        const receipt = await zapOutTx.wait();
        log("info", `Zap-out confirmed in block ${receipt.blockNumber} for ${percentage}% of ${position.tokenAddress}`);

        let newPositions = await loadPositions();
        if (percentage === 100) {
            newPositions.splice(ctx.session.positionIndex, 1);
            ctx.session.positionIndex = Math.max(0, ctx.session.positionIndex - 1);
        }
        await savePositions(newPositions);

        await ctx.reply(`✅ **${percentage}% Zap Out Successful!**\n\nBlock: ${receipt.blockNumber}`, { parse_mode: 'Markdown' });

        if (newPositions.length > 0) {
            await displayPosition(ctx, true);
        } else {
            await ctx.editMessageText("🎉 All positions have been closed!", { reply_markup: undefined });
        }
    } catch (e) {
        log("error", "Zap Out Error:", e);
        let errorMessage = "An unknown error occurred.";

        if (e.message && e.message.includes('insufficient funds')) {
            errorMessage = "Insufficient ETH for gas fees.";
        } else if (e.message && e.message.includes('priorityFee')) {
            errorMessage = "Gas price configuration error. Please try again.";
        } else if (e.reason) {
            errorMessage = e.reason.substring(0, 200); // Limit length
        } else if (e.message) {
            errorMessage = e.message.substring(0, 200); // Limit length
        }

        // Escape markdown special characters
        errorMessage = errorMessage.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

        await ctx.reply(`❌ *Zap Out Failed*\n\n*Reason:* ${errorMessage}`, { parse_mode: 'Markdown' });
        await displayPosition(ctx, true).catch(() => { });
    }
});

// =================================================================
// --- DISPLAY LOGIC ---
// =================================================================

async function displayZapInInfo(ctx, messageId, tokenAddress) {
    try {
        const { messageText, keyboard } = await generateZapInTokenMessage(tokenAddress);
        await ctx.api.editMessageText(ctx.chat.id, messageId, messageText, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } catch (e) {
        log("error", "Zap-in info fetch failed:", e);
        await ctx.api.editMessageText(ctx.chat.id, messageId, `❌ Could not load token data: ${e.message}\n\nPlease check the token address and try again.`);
        throw e;
    }
}

async function generateZapInTokenMessage(tokenAddress) {
    const [tokenInfo, pairInfo, ethPriceUsd, balance] = await Promise.all([
        getCachedTokenInfo(tokenAddress),
        getCachedPairInfo(tokenAddress),
        getCachedEthPriceInUsd(),
        provider.getBalance(wallet.address)
    ]);

    let gasPriceGwei = 'N/A', estimatedFeeUsd = 0, estimatedGasFee = 0n;
    try {
        const { gasPrice } = await getCachedTxOptions();
        estimatedGasFee = CONSTANTS.ZAP_IN_GAS_LIMIT_ESTIMATE * gasPrice;
        gasPriceGwei = parseFloat(formatUnits(gasPrice, "gwei")).toFixed(1);
        if (ethPriceUsd > 0) {
            estimatedFeeUsd = parseFloat(formatEther(estimatedGasFee)) * ethPriceUsd;
        }
    } catch (e) {
        log('warn', 'Could not get gas estimate for display, using defaults', e.message);
        // Use fallback values
        gasPriceGwei = CONSTANTS.DEFAULT_GAS_PRICE_GWEI.toFixed(1);
        estimatedGasFee = CONSTANTS.ZAP_IN_GAS_LIMIT_ESTIMATE * parseUnits(CONSTANTS.DEFAULT_GAS_PRICE_GWEI.toString(), 'gwei');
        if (ethPriceUsd > 0) {
            estimatedFeeUsd = parseFloat(formatEther(estimatedGasFee)) * ethPriceUsd;
        }
    }

    const mcapUsd = parseFloat(pairInfo.marketCap) * ethPriceUsd;
    const priceEth = parseFloat(pairInfo.price);
    const priceUsd = (priceEth * ethPriceUsd).toPrecision(6);
    const maxSafeZapAmount = balance > estimatedGasFee ? balance - estimatedGasFee : 0n;
    const maxSafeZapEth = parseFloat(formatEther(maxSafeZapAmount));

    const messageText =
        `🎯 **Token Found**\n\n` +
        `**Name:** ${tokenInfo.name} (${tokenInfo.symbol})\n` +
        `**Address:** \`${tokenAddress}\`\n` +
        `**Market Cap:** ${mcapUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}\n` +
        `**Price:** $${priceUsd} / ${priceEth.toFixed(12)} ETH\n\n` +
        `⚡ **Network Status:**\n` +
        `Gas Price: ${gasPriceGwei} Gwei\n` +
        `Est. Tx Fee: ~$${estimatedFeeUsd.toFixed(3)}\n\n` +
        `💰 **Your Wallet:**\n` +
        `Balance: ${parseFloat(formatEther(balance)).toFixed(4)} ETH\n` +
        `Max Safe Zap: ~${maxSafeZapEth.toFixed(4)} ETH\n\n` +
        `**How much ETH would you like to zap in?**\n` +
        `_(Enter custom amount or use buttons below)_\n\n` +
        `_Updated: ${new Date().toLocaleTimeString()}_`;

    const keyboard = new InlineKeyboard();
    const safeAmounts = CONSTANTS.ZAP_AMOUNT_PRESETS.filter(a => parseFloat(a) <= maxSafeZapEth);

    if (safeAmounts.length > 0) {
        safeAmounts.forEach((amount, idx) => {
            keyboard.text(`${amount} ETH`, `zap_amount:${amount}`);
            if ((idx + 1) % 2 === 0 && idx < safeAmounts.length - 1) keyboard.row();
        });
        keyboard.row();
    } else {
        keyboard.text('⚠️ Insufficient Balance', 'insufficient_balance').row();
    }

    keyboard.text('🔄 Refresh', `refresh_zap:${tokenAddress}`);

    return { messageText, keyboard };
}

async function generatePositionMessage(position, index, total) {
    const [tokenInfo, currentPairInfo, ethPriceUsd] = await Promise.all([
        getCachedTokenInfo(position.tokenAddress),
        getCachedPairInfo(position.tokenAddress),
        getCachedEthPriceInUsd()
    ]);

    const pairContract = new Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, provider);
    const [reserves, lpBalance, pairTotalSupply, token0] = await Promise.all([
        pairContract.getReserves(),
        pairContract.balanceOf(wallet.address),
        pairContract.totalSupply(),
        pairContract.token0()
    ]);

    if (pairTotalSupply === 0n) throw new Error("Pool has no liquidity.");

    const [reserveWETH] = getAddress(token0) === getAddress(CONSTANTS.WETH_ADDRESS)
        ? [reserves[0], reserves[1]]
        : [reserves[1], reserves[0]];

    const userLpValueWei = (reserveWETH * 2n * lpBalance) / pairTotalSupply;
    const userLpValueEth = parseFloat(formatEther(userLpValueWei));
    const userLpValueUsd = userLpValueEth * ethPriceUsd;

    const initialMarketCapEth = parseFloat(position.initialMarketCap);
    const currentMarketCapEth = parseFloat(currentPairInfo.marketCap);
    const mcapProfitPercent = initialMarketCapEth > 0
        ? ((currentMarketCapEth - initialMarketCapEth) / initialMarketCapEth) * 100
        : 0;
    const userSharePercent = Number((lpBalance * 10000n) / pairTotalSupply) / 100;

    const formatUsd = (val) => val.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

    const messageText =
        `📊 **Position ${index + 1} of ${total}**\n\n` +
        `**Token:** ${tokenInfo.name} (${tokenInfo.symbol})\n` +
        `**Value:** ${userLpValueEth.toFixed(5)} ETH (~${formatUsd(userLpValueUsd)})\n` +
        `**Address:** \`${position.tokenAddress}\`\n\n` +
        `**Market Cap:**\n` +
        `Initial: ${formatUsd(initialMarketCapEth * ethPriceUsd)}\n` +
        `Current: ${formatUsd(currentMarketCapEth * ethPriceUsd)}\n` +
        `P/L: ${mcapProfitPercent >= 0 ? '📈 +' : '📉 '}${mcapProfitPercent.toFixed(2)}%\n\n` +
        `**Pool Share:** ${userSharePercent.toFixed(4)}%\n\n` +
        `_Updated: ${new Date().toLocaleTimeString()}_`;

    const keyboard = new InlineKeyboard()
        .text('⬅️', 'prev_pos')
        .text('🔄', 'refresh_pos')
        .text('➡️', 'next_pos')
        .row();

    CONSTANTS.ZAP_OUT_PERCENTAGES.forEach((pct, idx) => {
        const emoji = pct === 100 ? '💥' : pct >= 75 ? '🔥' : pct >= 50 ? '⚡' : '💧';
        keyboard.text(`${emoji} ${pct}%`, `execute_zapout:${pct}`);
        if ((idx + 1) % 2 === 0 && idx < CONSTANTS.ZAP_OUT_PERCENTAGES.length - 1) keyboard.row();
    });

    return { messageText, keyboard };
}

async function displayPosition(ctx, edit = false) {
    const chatId = ctx.chat.id;
    stopWatcher(chatId);
    const positions = await loadPositions();
    const index = ctx.session.positionIndex ?? 0;

    if (!positions[index]) {
        const message = "📭 You have no open positions.\n\nUse /zapin to create one!";
        if (edit) {
            await ctx.editMessageText(message).catch(() => ctx.reply(message));
        } else {
            await ctx.reply(message);
        }
        return;
    }

    let msg;
    const loadingText = `⏳ Loading position ${index + 1}/${positions.length}...`;

    try {
        msg = edit ? await ctx.editMessageText(loadingText) : await ctx.reply(loadingText);

        const update = async () => {
            if (activeConversations.has(chatId)) {
                stopWatcher(chatId);
                return;
            }
            try {
                const currentPositions = await loadPositions();
                const currentPosition = currentPositions[index];
                if (!currentPosition) {
                    stopWatcher(chatId);
                    await bot.api.editMessageText(chatId, msg.message_id, "Position has been closed.", { reply_markup: undefined });
                    return;
                }
                const { messageText, keyboard } = await generatePositionMessage(currentPosition, index, currentPositions.length);
                await bot.api.editMessageText(chatId, msg.message_id, messageText, { parse_mode: 'Markdown', reply_markup: keyboard })
                    .catch(e => {
                        if (!e.description.includes("message is not modified")) throw e;
                    });
            } catch (error) {
                log('error', `Auto-refresh failed for chat ${chatId}:`, error);
                if (error instanceof GrammyError && error.description.includes("message to edit not found")) {
                    stopWatcher(chatId);
                }
            }
        };

        await update();
        activeWatchers.set(chatId, setInterval(update, CONSTANTS.AUTO_REFRESH_INTERVAL_MS));

    } catch (e) {
        log("error", "Display Position Error:", e);
        const errorMessage = `❌ Could not load position data: ${e.message}`;
        if (msg) {
            await bot.api.editMessageText(chatId, msg.message_id, errorMessage).catch(() => { });
        } else {
            await ctx.reply(errorMessage);
        }
    }
}

// =================================================================
// --- BOT ERROR HANDLING & STARTUP ---
// =================================================================

bot.catch((err) => {
    const ctx = err.ctx;
    log("error", `Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;

    if (e instanceof GrammyError) {
        log("error", "Grammy Error:", e.description);
    } else if (e instanceof HttpError) {
        log("error", "HTTP Error - Could not contact Telegram:", e);
    } else {
        log("error", "Unknown error:", e);
    }
});

async function startBot() {
    try {
        const botInfo = await bot.api.getMe();
        const balance = await provider.getBalance(wallet.address);
        const ethPrice = await getCachedEthPriceInUsd();
        const balanceUsd = parseFloat(formatEther(balance)) * ethPrice;

        log("info", "=========================================");
        log("info", "🚀 Enhanced Uniswap V2 Zapper Bot");
        log("info", "=========================================");
        log("info", `Bot Username: @${botInfo.username}`);
        log("info", `Wallet Address: ${wallet.address}`);
        log("info", `Balance: ${parseFloat(formatEther(balance)).toFixed(4)} ETH (~$${balanceUsd.toFixed(2)})`);
        log("info", `Zapper Contract: ${CONSTANTS.ZAPPER_ADDRESS}`);
        log("info", `Dynamic Slippage: ${CONSTANTS.ENABLE_DYNAMIC_SLIPPAGE ? 'Enabled' : 'Disabled'}`);
        log("info", `Slippage Range: ${CONSTANTS.MIN_SLIPPAGE_BPS / 100}% - ${CONSTANTS.MAX_SLIPPAGE_BPS / 100}%`);
        log("info", "=========================================");

        await bot.start();
        log("info", "✅ Bot is now running!");
    } catch (e) {
        log("error", "FATAL: Could not start the bot.", e);
        log("error", "Please check your .env file and network connection.");
        process.exit(1);
    }
}

startBot();
