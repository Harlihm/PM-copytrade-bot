/**
 * Auto-Resolver Service
 *
 * Automatically resolves/redeems positions when markets end:
 * - Redeems winning positions (price >= $0.99)
 * - Optionally sells losing positions (price <= $0.01)
 * - Runs on a configurable schedule
 * - Sends Telegram notifications
 */

import { ethers } from 'ethers';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import schedule from 'node-schedule';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import { sendNotification } from './telegramBot';

// Thresholds for considering a position "resolved"
const RESOLVED_HIGH = 0.99; // Position won (price ~$1)
const RESOLVED_LOW = 0.01; // Position lost (price ~$0)
const ZERO_THRESHOLD = 0.0001;
const MIN_SELL_TOKENS = 1.0;

// Contract addresses on Polygon
const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// CTF Contract ABI (only the functions we need)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
];

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

// Scheduled job reference
let autoResolveJob: schedule.Job | null = null;
let isRunning = false;
let clobClientRef: ClobClient | null = null;

/**
 * Load positions from Polymarket API
 */
const loadPositions = async (): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${ENV.PROXY_WALLET}`;
    const data = await fetchData(url);
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

/**
 * Redeem a winning position via smart contract
 */
const redeemPosition = async (
    ctfContract: ethers.Contract,
    position: Position
): Promise<{ success: boolean; error?: string }> => {
    try {
        const conditionIdBytes32 = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(position.conditionId).toHexString(),
            32
        );
        const parentCollectionId = ethers.constants.HashZero;
        const indexSets = [1, 2];

        const feeData = await ctfContract.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

        if (!gasPrice) {
            throw new Error('Could not determine gas price');
        }

        const adjustedGasPrice = gasPrice.mul(120).div(100);

        const tx = await ctfContract.redeemPositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            {
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );

        Logger.info(`⏳ Redemption tx submitted: ${tx.hash}`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
            return { success: true };
        } else {
            return { success: false, error: 'Transaction reverted' };
        }
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

/**
 * Sell a losing position on the order book
 */
const sellPosition = async (
    clobClient: ClobClient,
    position: Position
): Promise<{ success: boolean; soldTokens: number; error?: string }> => {
    let remaining = position.size;
    let soldTokens = 0;
    let attempts = 0;
    const maxAttempts = ENV.RETRY_LIMIT;

    if (remaining < MIN_SELL_TOKENS) {
        return { success: false, soldTokens: 0, error: 'Position too small to sell' };
    }

    while (remaining >= MIN_SELL_TOKENS && attempts < maxAttempts) {
        try {
            const orderBook = await clobClient.getOrderBook(position.asset);

            if (!orderBook.bids || orderBook.bids.length === 0) {
                return { success: false, soldTokens, error: 'No bids available' };
            }

            const bestBid = orderBook.bids.reduce((max: any, bid: any) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            const bidSize = parseFloat(bestBid.size);
            const bidPrice = parseFloat(bestBid.price);
            const sellAmount = Math.min(remaining, bidSize);

            if (sellAmount < MIN_SELL_TOKENS) {
                break;
            }

            const orderArgs = {
                side: Side.SELL,
                tokenID: position.asset,
                amount: sellAmount,
                price: bidPrice,
            };

            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            if (resp.success === true) {
                soldTokens += sellAmount;
                remaining -= sellAmount;
                attempts = 0;
            } else {
                attempts++;
            }
        } catch (error) {
            attempts++;
        }
    }

    return {
        success: soldTokens > 0,
        soldTokens,
        error: remaining >= MIN_SELL_TOKENS ? 'Could not sell all tokens' : undefined,
    };
};

/**
 * Run the auto-resolve check
 */
const runAutoResolve = async (): Promise<void> => {
    if (isRunning) {
        Logger.info('Auto-resolve already running, skipping...');
        return;
    }

    isRunning = true;
    Logger.info('🔄 Running auto-resolve check...');

    try {
        const positions = await loadPositions();

        if (positions.length === 0) {
            Logger.info('No positions to check');
            isRunning = false;
            return;
        }

        // Find resolved positions
        const redeemableWins = positions.filter(
            (pos) => pos.curPrice >= RESOLVED_HIGH && pos.redeemable === true
        );

        const unredeemableWins = positions.filter(
            (pos) => pos.curPrice >= RESOLVED_HIGH && pos.redeemable !== true
        );

        const losses = positions.filter((pos) => pos.curPrice <= RESOLVED_LOW);

        Logger.info(`📊 Found: ${redeemableWins.length} redeemable wins, ${unredeemableWins.length} unredeemable wins, ${losses.length} losses`);

        let totalRedeemed = 0;
        let totalSold = 0;
        const results: string[] = [];

        // Redeem winning positions
        if (redeemableWins.length > 0) {
            Logger.info(`💎 Redeeming ${redeemableWins.length} winning positions...`);

            const provider = new ethers.providers.JsonRpcProvider(ENV.RPC_URL);
            const wallet = new ethers.Wallet(ENV.PRIVATE_KEY, provider);
            const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

            // Group by conditionId to avoid duplicate redemptions
            const byCondition = new Map<string, Position[]>();
            redeemableWins.forEach((pos) => {
                const existing = byCondition.get(pos.conditionId) || [];
                existing.push(pos);
                byCondition.set(pos.conditionId, existing);
            });

            for (const [conditionId, conditionPositions] of byCondition.entries()) {
                const totalValue = conditionPositions.reduce((sum, pos) => sum + pos.currentValue, 0);

                if (totalValue < ENV.AUTO_RESOLVE_MIN_VALUE) {
                    Logger.info(`Skipping condition ${conditionId} - value $${totalValue.toFixed(2)} below minimum`);
                    continue;
                }

                const result = await redeemPosition(ctfContract, conditionPositions[0]);

                if (result.success) {
                    totalRedeemed += totalValue;
                    const title = conditionPositions[0].title || conditionPositions[0].slug || 'Unknown';
                    results.push(`✅ Redeemed: ${title.slice(0, 30)}... ($${totalValue.toFixed(2)})`);
                    Logger.success(`Redeemed ${title} for $${totalValue.toFixed(2)}`);
                } else {
                    Logger.warning(`Failed to redeem: ${result.error}`);
                }

                // Small delay between redemptions
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }

        // Sell losing positions (if enabled)
        if (ENV.AUTO_RESOLVE_SELL_LOSSES && losses.length > 0 && clobClientRef) {
            Logger.info(`🔴 Selling ${losses.length} losing positions...`);

            for (const position of losses) {
                if (position.currentValue < ENV.AUTO_RESOLVE_MIN_VALUE) {
                    continue;
                }

                const result = await sellPosition(clobClientRef, position);

                if (result.success) {
                    const proceeds = result.soldTokens * position.curPrice;
                    totalSold += proceeds;
                    const title = position.title || position.slug || 'Unknown';
                    results.push(`🔴 Sold: ${title.slice(0, 30)}... (${result.soldTokens.toFixed(2)} tokens)`);
                    Logger.info(`Sold ${title} - ${result.soldTokens.toFixed(2)} tokens`);
                }

                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        // Send Telegram summary
        if (results.length > 0) {
            const summary = `
🔄 *Auto-Resolve Complete*

${results.join('\n')}

💰 *Total Redeemed:* $${totalRedeemed.toFixed(2)}
${ENV.AUTO_RESOLVE_SELL_LOSSES ? `💸 *Total Sold:* $${totalSold.toFixed(2)}` : ''}
            `;

            await sendNotification(summary).catch(() => {});
        } else {
            Logger.info('No positions met criteria for auto-resolution');
        }
    } catch (error) {
        Logger.error(`Auto-resolve error: ${error}`);
        await sendNotification(`⚠️ Auto-resolve error: ${error}`).catch(() => {});
    }

    isRunning = false;
};

/**
 * Initialize the auto-resolver
 */
export const initAutoResolver = (clobClient?: ClobClient): void => {
    if (!ENV.AUTO_RESOLVE_ENABLED) {
        Logger.info('Auto-resolver disabled (set AUTO_RESOLVE_ENABLED=true to enable)');
        return;
    }

    clobClientRef = clobClient || null;

    const intervalMinutes = ENV.AUTO_RESOLVE_INTERVAL_MINUTES;
    Logger.success(`Auto-resolver enabled - checking every ${intervalMinutes} minutes`);
    Logger.info(`  Min value: $${ENV.AUTO_RESOLVE_MIN_VALUE}`);
    Logger.info(`  Sell losses: ${ENV.AUTO_RESOLVE_SELL_LOSSES ? 'YES' : 'NO'}`);

    // Schedule the job using cron syntax
    // Run every X minutes
    const cronExpression = `*/${intervalMinutes} * * * *`;
    autoResolveJob = schedule.scheduleJob(cronExpression, async () => {
        await runAutoResolve();
    });

    // Run immediately on startup (after a short delay)
    setTimeout(async () => {
        Logger.info('Running initial auto-resolve check...');
        await runAutoResolve();
    }, 10000); // 10 second delay to let other services initialize
};

/**
 * Stop the auto-resolver
 */
export const stopAutoResolver = (): void => {
    if (autoResolveJob) {
        autoResolveJob.cancel();
        autoResolveJob = null;
        Logger.info('Auto-resolver stopped');
    }
};

/**
 * Manually trigger auto-resolve
 */
export const triggerAutoResolve = async (): Promise<void> => {
    await runAutoResolve();
};

export default {
    initAutoResolver,
    stopAutoResolver,
    triggerAutoResolve,
};

