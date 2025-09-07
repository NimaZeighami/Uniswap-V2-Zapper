import 'dotenv/config';
import { Bot, session, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { ethers, formatEther, parseEther, ZeroAddress, getAddress } from 'ethers';
import fs from 'fs/promises';

// =================================================================
// --- SETUP, CONFIGURATION & CONSTANTS ---
// =================================================================

if (!process.env.RPC_URL || !process.env.PRIVATE_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    console.error("FATAL ERROR: Please set RPC_URL, PRIVATE_KEY, and TELEGRAM_BOT_TOKEN in the .env file.");
    process.exit(1);
}

const ZAPPER_ADDRESS = '0x6cc707f9097e9e5692bC4Ad21E17Ed01659D5952';
const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const POSITIONS_FILE_PATH = './positions.json';
const SLIPPAGE_BPS = 2000;

const ZAPPER_ABI = [
    { "inputs": [{ "internalType": "address", "name": "tokenOther", "type": "address" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }], "name": "zapInETH", "outputs": [{ "internalType": "uint256", "name": "liquidity", "type": "uint256" }], "stateMutability": "payable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }], "name": "zapOut", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
];
const UNISWAP_V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) external view returns (address pair)'];
const UNISWAP_V2_PAIR_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function totalSupply() view returns (uint256)'
];
const ERC20_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)"
];

// =================================================================
// --- ETHEREUM & CONTRACT SETUP ---
// =================================================================

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const zapperContract = new ethers.Contract(ZAPPER_ADDRESS, ZAPPER_ABI, wallet);
const factoryContract = new ethers.Contract(UNISWAP_V2_FACTORY_ADDRESS, UNISWAP_V2_FACTORY_ABI, provider);

// =================================================================
// --- DATA PERSISTENCE HELPERS ---
// =================================================================

async function loadPositions() {
    try {
        await fs.access(POSITIONS_FILE_PATH);
        const data = await fs.readFile(POSITIONS_FILE_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function savePositions(positions) {
    await fs.writeFile(POSITIONS_FILE_PATH, JSON.stringify(positions, null, 2));
}

// =================================================================
// --- BLOCKCHAIN HELPER FUNCTIONS ---
// =================================================================

async function getTokenInfo(tokenAddress) {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    try {
        const [name, symbol, decimals] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()]);
        return { name, symbol, decimals };
    } catch (error) {
        return { name: "Unknown Token", symbol: "N/A", decimals: 18n };
    }
}

async function getPairInfo(tokenOtherAddress) {
    const pairAddress = await factoryContract.getPair(WETH_ADDRESS, tokenOtherAddress);
    if (pairAddress === ZeroAddress) throw new Error("Pair does not exist for this token.");

    const pairContract = new ethers.Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);
    const tokenOtherContract = new ethers.Contract(tokenOtherAddress, ERC20_ABI, provider);

    const [reserves, token0, totalSupply, tokenDecimals] = await Promise.all([
        pairContract.getReserves(),
        pairContract.token0(),
        tokenOtherContract.totalSupply(),
        tokenOtherContract.decimals().catch(() => 18n)
    ]);

    const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(WETH_ADDRESS)
        ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];

    if (reserveToken === 0n || reserveWETH === 0n) return { pairAddress, price: '0', marketCap: '0' };

    const price = (reserveWETH * (10n ** tokenDecimals)) / reserveToken;
    const marketCap = (price * totalSupply) / (10n ** 18n);

    return { pairAddress, price: formatEther(price), marketCap: formatEther(marketCap) };
}

// =================================================================
// --- TELEGRAM CONVERSATIONS ---
// =================================================================

async function zapInConversation(conversation, ctx) {
    // === STEP 1: Get Token Address ===
    await ctx.reply("Please provide the token contract address to pair with ETH.");
    const tokenAddressMsg = await conversation.wait();
    const tokenAddressText = tokenAddressMsg.message?.text;

    if (!tokenAddressText || !ethers.isAddress(tokenAddressText)) {
        await ctx.reply("❌ Invalid Ethereum address. Please start again.");
        return;
    }
    const tokenAddress = getAddress(tokenAddressText);

    const waitingMessage = await ctx.reply("🔍 Fetching token info...");
    let tokenInfo, pairInfo;
    try {
        [tokenInfo, pairInfo] = await Promise.all([getTokenInfo(tokenAddress), getPairInfo(tokenAddress)]);
    } catch (e) {
        await ctx.api.editMessageText(ctx.chat.id, waitingMessage.message_id, `❌ Error fetching token data: ${e.message}`);
        return;
    }

    // === STEP 2: Get ETH Amount (Moved before gas estimation) ===
    const infoText = `
*Token Found:*
*Name:* ${tokenInfo.name} (${tokenInfo.symbol})
*Address:* \`${tokenAddress}\`
*Market Cap:* ~${parseFloat(pairInfo.marketCap).toFixed(2)} ETH

How much ETH would you like to zap in? (e.g., '0.05')`;
    await ctx.api.editMessageText(ctx.chat.id, waitingMessage.message_id, infoText, { parse_mode: "Markdown" });

    const ethAmountMsg = await conversation.wait();
    const ethAmount = ethAmountMsg.message?.text;
    if (!ethAmount || isNaN(parseFloat(ethAmount)) || parseFloat(ethAmount) <= 0) {
        await ctx.reply("❌ Invalid amount. Please start again.");
        return;
    }

    // === STEP 3: Estimate Gas & Confirm (Now with the user's amount) ===
    await ctx.reply("⏳ Estimating gas cost...");
    const amountIn = parseEther(ethAmount);
    let estimatedGasCost;
    try {
        const feeData = await provider.getFeeData();
        const gasEstimate = await zapperContract.zapInETH.estimateGas(tokenAddress, 0, 0, wallet.address, Math.floor(Date.now() / 1000) + 120, SLIPPAGE_BPS, { value: amountIn });
        estimatedGasCost = formatEther(gasEstimate * feeData.gasPrice);
    } catch (e) {
        console.error("Gas Estimation Error:", e);
        await ctx.reply(`❌ Could not estimate gas. Error: ${e.reason || e.message}. This usually means your balance is too low for the amount you entered.`);
        return;
    }

    const confirmKeyboard = new InlineKeyboard().text("✅ Confirm Zap In", "confirm_zap").text("❌ Cancel", "cancel_zap");
    await ctx.reply(`You are about to zap in ${ethAmount} ETH for ${tokenInfo.symbol}.\n*Estimated Gas:* ~${parseFloat(estimatedGasCost).toFixed(5)} ETH\nPlease confirm.`, { parse_mode: "Markdown", reply_markup: confirmKeyboard });

    const confirmation = await conversation.waitForCallbackQuery(["confirm_zap", "cancel_zap"]);
    if (confirmation.match === "cancel_zap") {
        await confirmation.editMessageText("Zap In cancelled.");
        return;
    }

    // === STEP 4: Execute Transaction ===
    await confirmation.editMessageText("⏳ Processing transaction, please wait...");
    try {
        const deadline = Math.floor(Date.now() / 1000) + (20 * 60);
        const tx = await zapperContract.zapInETH(tokenAddress, 0n, 0n, wallet.address, deadline, SLIPPAGE_BPS, { value: amountIn });
        await tx.wait();

        const positions = await loadPositions();
        positions.push({ tokenAddress, pairAddress: pairInfo.pairAddress, initialEthValue: ethAmount, timestamp: Date.now() });
        await savePositions(positions);

        await confirmation.editMessageText(`✅ Zap In successful!\nTransaction: https://etherscan.io/tx/${tx.hash}`);
    } catch (e) {
        console.error("Zap In Error:", e);
        await confirmation.editMessageText(`❌ Zap In failed: ${e.reason || e.message}`);
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

bot.callbackQuery("zapout_menu", async (ctx) => {
    const keyboard = new InlineKeyboard().text("Zap Out 50%", "execute_zapout:50").text("Zap Out 100%", "execute_zapout:100").row().text("⬅️ Back", "back_to_pos");
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    await ctx.answerCallbackQuery();
});

bot.callbackQuery("back_to_pos", async (ctx) => {
    await displayPosition(ctx, true);
    await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^execute_zapout:(\d+)$/, async (ctx) => {
    const percentage = parseInt(ctx.match[1], 10);
    let positions = await loadPositions();
    const position = positions[ctx.session.positionIndex];

    if (!position) {
        await ctx.editMessageText("❌ Position not found. It may have been removed.");
        return;
    }
    await ctx.editMessageText(`⏳ Processing ${percentage}% Zap Out for ${position.tokenAddress}. Please wait...`, { reply_markup: undefined });

    try {
        const pairContract = new ethers.Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, wallet);
        const lpBalance = await pairContract.balanceOf(wallet.address);
        if (lpBalance === 0n) throw new Error("You have no LP tokens for this pair to zap out.");

        const liquidityToZap = (lpBalance * BigInt(percentage)) / 100n;
        const approveTx = await pairContract.approve(ZAPPER_ADDRESS, liquidityToZap);
        await approveTx.wait();

        const deadline = Math.floor(Date.now() / 1000) + (20 * 60);
        const zapOutTx = await zapperContract.zapOut(WETH_ADDRESS, position.tokenAddress, liquidityToZap, WETH_ADDRESS, 0n, 0n, 0n, wallet.address, deadline, SLIPPAGE_BPS);
        await zapOutTx.wait();

        if (percentage === 100) {
            positions.splice(ctx.session.positionIndex, 1);
            ctx.session.positionIndex = Math.max(0, ctx.session.positionIndex - 1);
        }
        await savePositions(positions);
        await ctx.reply(`✅ ${percentage}% Zap Out successful!\nTransaction: https://etherscan.io/tx/${zapOutTx.hash}`);
    } catch (e) {
        console.error("Zap Out Error:", e);
        await ctx.reply(`❌ Zap Out failed: ${e.reason || e.message}`);
    } finally {
        await ctx.answerCallbackQuery();
    }
});

// =================================================================
// --- DISPLAY LOGIC ---
// =================================================================

/**
 * Displays the current position to the user, either as a new message or by editing an existing one.
 * @param {Context} ctx The grammy context object.
 * @param {boolean} edit Whether to edit the existing message or send a new one.
 */
async function displayPosition(ctx, edit = false) {
    const positions = await loadPositions();
    const index = ctx.session.positionIndex;

    if (!positions[index]) {
        const message = "You have no open positions.";
        edit ? await ctx.editMessageText(message) : await ctx.reply(message);
        return;
    }
    const position = positions[index];

    const waitMessage = edit
        ? await ctx.editMessageText(`⏳ Loading position ${index + 1}/${positions.length}...`)
        : await ctx.reply(`⏳ Loading position ${index + 1}/${positions.length}...`);

    try {
        const pairContract = new ethers.Contract(position.pairAddress, UNISWAP_V2_PAIR_ABI, provider);
        const [tokenInfo, reserves, lpBalance, pairTotalSupply] = await Promise.all([
            getTokenInfo(position.tokenAddress),
            pairContract.getReserves(),
            pairContract.balanceOf(wallet.address),
            pairContract.totalSupply()
        ]);

        // --- NEW, MORE ACCURATE P/L Estimation Logic ---
        if (pairTotalSupply > 0n) {
            // Determine which reserve is WETH and which is the other token
            const token0 = await pairContract.token0();
            const [reserveWETH, reserveToken] = getAddress(token0) === getAddress(WETH_ADDRESS)
                ? [reserves[0], reserves[1]]
                : [reserves[1], reserves[0]];

            // Calculate user's share of each asset in the pool
            const userShareOfWETH = (reserveWETH * lpBalance) / pairTotalSupply;
            const userShareOfToken = (reserveToken * lpBalance) / pairTotalSupply;

            // Convert the token's value back to WETH to get a total value
            // This is safer than using the pre-calculated market cap
            const valueOfTokenInWETH = (userShareOfToken * reserveWETH) / reserveToken;

            // Total value is the user's WETH share + the value of their token share in WETH
            const userLpValueWei = userShareOfWETH + valueOfTokenInWETH;
            const userLpValueEth = parseFloat(formatEther(userLpValueWei));

            const initialValueEth = parseFloat(position.initialEthValue);
            const profitPercent = initialValueEth > 0 ? ((userLpValueEth - initialValueEth) / initialValueEth) * 100 : 0;
            const profitSign = profitPercent >= 0 ? '💹 +' : '🔻 ';
            const userSharePercent = Number(lpBalance * 10000n / pairTotalSupply) / 100;

            const messageText = `
*Position ${index + 1} of ${positions.length}*
*Token:* ${tokenInfo.name} (${tokenInfo.symbol})
*Pair Address:* \`${position.pairAddress}\`

*Your LP Balance:* \`${formatEther(lpBalance)}\` LP
*Your Pool Share:* ~${userSharePercent.toFixed(4)}%

*Initial ETH Value:* ${initialValueEth.toFixed(5)} ETH
*Est. Current Value:* ${userLpValueEth.toFixed(5)} ETH
*Est. P/L:* *${profitSign}${profitPercent.toFixed(2)}%*

_(Note: P/L is a simple estimation and does not account for impermanent loss or gas fees.)_`;

            const keyboard = new InlineKeyboard()
                .text('⬅️ Prev', 'prev_pos').text('Next ➡️', 'next_pos').row()
                .text('🔥 Zap Out 🔥', 'zapout_menu');

            await ctx.api.editMessageText(ctx.chat.id, waitMessage.message_id, messageText, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });

        } else {
            await ctx.api.editMessageText(ctx.chat.id, waitMessage.message_id, "Could not calculate value: Pool has no liquidity.");
        }

    } catch (e) {
        console.error("Display Position Error:", e);
        await ctx.api.editMessageText(ctx.chat.id, waitMessage.message_id, `❌ Could not load position data: ${e.message}`);
    }
}

// =================================================================
// --- BOT STARTUP & GLOBAL ERROR HANDLING ---
// =================================================================

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) console.error("Error in request:", e.description);
    else if (e instanceof HttpError) console.error("Could not contact Telegram:", e);
    else console.error("Unknown error:", e);
});

async function startBot() {
    // === BALANCE & ADDRESS CHECK ON STARTUP ===
    const balance = await provider.getBalance(wallet.address);
    console.log(`Bot starting... Wallet Address: ${wallet.address}`);
    console.log(`Current Balance: ${formatEther(balance)} ETH`);
    // ==========================================
    await bot.start();
}

startBot();