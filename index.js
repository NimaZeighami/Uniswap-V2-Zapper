import 'dotenv/config';
import { ethers, formatEther, parseEther, ZeroAddress } from 'ethers';

if (!process.env.RPC_URL || !process.env.PRIVATE_KEY) {
    console.error("Error: Please set RPC_URL and PRIVATE_KEY variables in the .env file.");
    process.exit(1);
}

// --- CONSTANTS ---
const ZAPPER_ADDRESS = '0x6cc707f9097e9e5692bC4Ad21E17Ed01659D5952'; 
const ZAPPER_ABI = [
    { "inputs": [{ "internalType": "address", "name": "tokenOther", "type": "address" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }], "name": "zapInETH", "outputs": [{ "internalType": "uint256", "name": "liquidity", "type": "uint256" }], "stateMutability": "payable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "tokenA", "type": "address" }, { "internalType": "address", "name": "tokenB", "type": "address" }, { "internalType": "uint256", "name": "liquidity", "type": "uint256" }, { "internalType": "address", "name": "tokenOut", "type": "address" }, { "internalType": "uint256", "name": "amountOutMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountAMin", "type": "uint256" }, { "internalType": "uint256", "name": "amountBMin", "type": "uint256" }, { "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "deadline", "type": "uint256" }, { "internalType": "uint256", "name": "slippageToleranceBps", "type": "uint256" }], "name": "zapOut", "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "tokenIn", "type": "address" }, { "internalType": "address", "name": "tokenOther", "type": "address" }, { "internalType": "uint256", "name": "amountIn", "type": "uint256" }], "name": "previewZapIn", "outputs": [{ "internalType": "uint256", "name": "swapAmount", "type": "uint256" }, { "internalType": "uint256", "name": "liquidityEstimate", "type": "uint256" }], "stateMutability": "view", "type": "function" }
];
const UNISWAP_V2_FACTORY_ADDRESS = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const UNISWAP_V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) external view returns (address pair)'];
const UNISWAP_V2_PAIR_ABI = [
    'function balanceOf(address owner) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)'
];
const UNISWAP_V2_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNISWAP_V2_ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)'
];

// --- Adjustable Parameters ---
const ETH_AMOUNT_TO_ZAP = '0.001';
const TOKEN_OTHER_ADDRESS = '0x0a19a78a3db698a492dfbaa2805ff43f43bf1a74'; 
const SLIPPAGE_BPS = 2000; // 50 BPS = 0.5%

// --- Initial Setup ---
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const zapperContract = new ethers.Contract(ZAPPER_ADDRESS, ZAPPER_ABI, wallet);
const routerContract = new ethers.Contract(UNISWAP_V2_ROUTER_ADDRESS, UNISWAP_V2_ROUTER_ABI, provider);
const factoryContract = new ethers.Contract(UNISWAP_V2_FACTORY_ADDRESS, UNISWAP_V2_FACTORY_ABI, provider);


async function main() {
    console.log(`Wallet connected: ${wallet.address}`);
    const initialBalance = await provider.getBalance(wallet.address);
    console.log(`Initial balance: ${formatEther(initialBalance)} ETH`);
    console.log('---'.repeat(10));

    const amountIn = parseEther(ETH_AMOUNT_TO_ZAP);

    // =================================================================
    // STEP 1: ZAP IN OPERATION
    // =================================================================
    console.log("1. Starting Zap In operation...");

    try {
        const deadline = Math.floor(Date.now() / 1000) + (20 * 60); // 20 minutes from now
        const txOptions = { value: amountIn };

        const zapInTx = await zapperContract.zapInETH(
            TOKEN_OTHER_ADDRESS,
            0n,
            0n,
            wallet.address,
            deadline,
            SLIPPAGE_BPS,
            txOptions
        );

        console.log(`   - Zap In transaction sent. Transaction Details: https://etherscan.io/tx/${zapInTx.hash}`);
        console.log("   - Waiting for transaction to be confirmed...");
        await zapInTx.wait();
        console.log("   - ✅ Zap In transaction confirmed successfully.");
    } catch (error) {
        console.error("   - ❌ An error occurred during Zap In operation:", error.reason || error.message);
        return; // Exit if Zap In fails
    }
    console.log('---'.repeat(10));

    // =================================================================
    // STEP 2: GET LP TOKEN BALANCE
    // =================================================================
    console.log("2. Checking LP Token balance...");
    const pairAddress = await factoryContract.getPair(WETH_ADDRESS, TOKEN_OTHER_ADDRESS);
    console.log(`   - LP Token (Pair) Address: ${pairAddress}`);

    const pairContract = new ethers.Contract(pairAddress, UNISWAP_V2_PAIR_ABI, wallet);
    const lpBalance = await pairContract.balanceOf(wallet.address);

    if (lpBalance === 0n) {
        console.log("   - ❌ No LP tokens found. Exiting.");
        return;
    }
    console.log(`   - ✅ Found LP Token Balance: ${formatEther(lpBalance)}`);
    console.log('---'.repeat(10));

    // =================================================================
    // STEP 3: APPROVE ZAPPER TO SPEND LP TOKENS
    // =================================================================
    console.log("3. Approving Zapper contract to spend LP tokens...");
    try {
        const approveTx = await pairContract.approve(ZAPPER_ADDRESS, lpBalance);
        console.log(`   - Approval transaction sent. Transaction Details: https://etherscan.io/tx/${approveTx.hash}`);
        console.log("   - Waiting for approval to be confirmed...");
        await approveTx.wait();
        console.log("   - ✅ Approval confirmed successfully.");
    } catch (error) {
        console.error("   - ❌ An error occurred during approval:", error.reason || error.message);
        return;
    }
    console.log('---'.repeat(10));

    // =================================================================
    // STEP 4: ZAP OUT OPERATION
    // =================================================================
    console.log("4. Starting Zap Out operation...");
    try {
        const deadline = Math.floor(Date.now() / 1000) + (20 * 60);
        const zapOutTx = await zapperContract.zapOut(
            WETH_ADDRESS,           // tokenA
            TOKEN_OTHER_ADDRESS,    // tokenB
            lpBalance,              // liquidity
            WETH_ADDRESS,           // tokenOut (we want ETH back)
            0n,                     // amountOutMin (rely on contract's internal slippage protection)
            0n,                     // amountAMin
            0n,                     // amountBMin
            wallet.address,         // to
            deadline,
            SLIPPAGE_BPS
        );

        console.log(`   - Zap Out transaction sent. Transaction Details: https://etherscan.io/tx/${zapOutTx.hash}`);
        console.log("   - Waiting for transaction to be confirmed...");
        await zapOutTx.wait();
        console.log("   - ✅ Zap Out transaction confirmed successfully.");

    } catch (error) {
        console.error("   - ❌ An error occurred during Zap Out operation:", error.reason || error.message);
        return;
    }
    console.log('---'.repeat(10));

    // =================================================================
    // STEP 5: FINAL BALANCE CHECK
    // =================================================================
    const finalBalance = await provider.getBalance(wallet.address);
    console.log("5. Final balance check:");
    console.log(`   - Initial ETH Balance: ${formatEther(initialBalance)}`);
    console.log(`   - Final ETH Balance:   ${formatEther(finalBalance)}`);
    const difference = finalBalance - initialBalance;
    console.log(`   - Net Change (includes gas fees): ${formatEther(difference)} ETH`);

}

main().catch((error) => {
    console.error("An unexpected error occurred while running the program:", error);
    process.exit(1);
});