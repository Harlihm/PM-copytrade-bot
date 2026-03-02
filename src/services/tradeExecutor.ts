/**
 * Trade Executor - Multi-User
 *
 * For each active user in the registry:
 *   1. Reads recent trades from their tracked traders (timestamp-based, not bot flag)
 *   2. Filters out trades this user already processed (per-user ProcessedTrade model)
 *   3. Creates/gets a cached CLOB client for the user
 *   4. Executes copy trades using the user's wallet
 *   5. Records processed trades per-user
 *
 * Each user's trading is independent: own wallet, own balance, own positions.
 */

import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import {
    markTradeProcessedForUser,
    filterUnprocessedTrades,
} from '../models/userHistory';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';
import { sendNotificationToUser, sendTradeNotification } from './telegramBot';
import userRegistry, { ActiveUser, TrackedTraderInfo } from './userRegistry';

// Track if executor should continue running
let isRunning = true;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('Trade executor shutdown requested...');
};

/**
 * Read new unprocessed trades for a specific user from their tracked traders.
 * Uses TIMESTAMP-based queries (last 48h) + per-user ProcessedTrade model.
 * Does NOT rely on the `bot` flag (which breaks multi-user).
 */
const getUnprocessedTradesForUser = async (
    user: ActiveUser
): Promise<Array<UserActivityInterface & { traderAddress: string }>> => {
    const allTrades: Array<UserActivityInterface & { traderAddress: string }> = [];

    // Hard cutoff: never look further back than 48 hours (matches ProcessedTrade TTL)
    const hardCutoffTimestamp = Math.floor(Date.now() / 1000) - 48 * 60 * 60;

    for (const trackedTrader of user.trackedTraders) {
        const traderAddress = trackedTrader.address;
        try {
            const UserActivity = getUserActivityModel(traderAddress);

            // Use the LATER of: 48h ago OR when the user started tracking this trader.
            // This prevents flooding historical trades when a trader is first added.
            const addedAtTimestamp = Math.floor(trackedTrader.addedAt.getTime() / 1000);
            const effectiveCutoff = Math.max(hardCutoffTimestamp, addedAtTimestamp);

            // Get recent trades after the effective cutoff
            // Dedup is handled per-user by the ProcessedTrade model
            const trades = await UserActivity.find({
                type: 'TRADE',
                timestamp: { $gte: effectiveCutoff },
            }).exec();

            if (trades.length === 0) continue;

            // Filter out trades this specific user already processed
            const txHashes = trades
                .map((t) => t.transactionHash)
                .filter((h): h is string => !!h);
            const unprocessedHashes = await filterUnprocessedTrades(user.chatId, txHashes);

            for (const trade of trades) {
                if (trade.transactionHash && unprocessedHashes.has(trade.transactionHash)) {
                    allTrades.push({
                        ...(trade.toObject() as UserActivityInterface),
                        traderAddress,
                    });
                }
            }
        } catch (error) {
            Logger.error(
                `Error reading trades for user ${user.chatId} / trader ${traderAddress}: ${error}`
            );
        }
    }

    return allTrades;
};

/**
 * Send a watch-only notification for a trade to a SPECIFIC user
 */
const sendWatchOnlyNotification = async (
    user: ActiveUser,
    trade: UserActivityInterface & { traderAddress: string }
): Promise<void> => {
    const shortTrader = `${trade.traderAddress.slice(0, 6)}...${trade.traderAddress.slice(-4)}`;
    const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴';

    const message = `
${sideEmoji} *Trader Activity Detected*

*Trader:* \`${shortTrader}\`
*Side:* ${trade.side || 'UNKNOWN'}
*Market:* ${trade.title || trade.slug || 'Unknown'}
*Outcome:* ${trade.outcome || 'N/A'}
*Amount:* $${trade.usdcSize.toFixed(2)}
*Price:* $${trade.price.toFixed(4)}

👁️ _Watch only mode - trade NOT copied_
    `;

    // Send to THIS user only, not broadcast
    await sendNotificationToUser(user.chatId, message).catch(() => {});
};

/**
 * Execute a trade for a specific user
 */
const executeTradeForUser = async (
    user: ActiveUser,
    clobClient: ClobClient,
    trade: UserActivityInterface & { traderAddress: string }
): Promise<void> => {
    const shortUser = user.username || `${user.chatId}`;
    const shortTrader = `${trade.traderAddress.slice(0, 6)}...${trade.traderAddress.slice(-4)}`;

    Logger.info(`Processing trade for user ${shortUser} from trader ${shortTrader}`);

    // Watch-only mode: just notify, don't trade
    if (user.watchOnlyMode) {
        Logger.info(`👁️ Watch only mode for user ${shortUser} - sending notification`);
        await sendWatchOnlyNotification(user, trade);
        await markTradeProcessedForUser(user.chatId, trade.transactionHash, trade.traderAddress, trade.side);
        return;
    }

    try {
        // Fetch positions for this user and the trader
        const my_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${user.walletAddress}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
        );
        const user_positions: UserPositionInterface[] = await fetchData(
            `https://data-api.polymarket.com/positions?user=${trade.traderAddress}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
        );

        const my_position = my_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );
        const user_position = user_positions.find(
            (position: UserPositionInterface) => position.conditionId === trade.conditionId
        );

        // Get user's USDC balance
        const my_balance = await getMyBalance(user.walletAddress);

        // Calculate trader's total portfolio value
        const trader_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        Logger.balance(my_balance, trader_balance, trade.traderAddress);

        // Execute the trade using the user's CLOB client
        await postOrder(
            clobClient,
            trade.side === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            trade,
            my_balance,
            trader_balance,
            trade.traderAddress
        );

        // Mark as processed for this user
        await markTradeProcessedForUser(
            user.chatId,
            trade.transactionHash,
            trade.traderAddress,
            trade.side
        );

        // Send success notification to this specific user
        const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴';
        await sendNotificationToUser(
            user.chatId,
            `${sideEmoji} *Trade Copied*\n\n*Market:* ${trade.title?.slice(0, 40) || 'Unknown'}\n*Side:* ${trade.side}\n*Amount:* $${trade.usdcSize.toFixed(2)}\n*Price:* $${trade.price.toFixed(4)}\n\n👤 Copied from: \`${shortTrader}\``
        ).catch(() => {});

        Logger.info(`Trade processed for user ${shortUser}`);
    } catch (error) {
        Logger.error(`Trade execution failed for user ${shortUser}: ${error}`);

        // Send failure notification to this specific user
        await sendNotificationToUser(
            user.chatId,
            `❌ *Trade Copy Failed*\n\n*Market:* ${trade.title?.slice(0, 40) || 'Unknown'}\n*Side:* ${trade.side}\n*Error:* ${error}\n\n👤 Trader: \`${shortTrader}\``
        ).catch(() => {});

        // Still mark as processed to avoid infinite retries
        await markTradeProcessedForUser(
            user.chatId,
            trade.transactionHash,
            trade.traderAddress,
            trade.side
        );
    }
};

const tradeExecutor = async () => {
    Logger.info('Trade executor started (multi-user mode)');

    let lastCheck = Date.now();
    let lastStatusLog = 0;

    while (isRunning) {
        try {
            const activeUsers = userRegistry.getActiveUsers();

            if (activeUsers.length === 0) {
                // No active users - idle
                if (Date.now() - lastStatusLog > 30000) {
                    Logger.info('Trade executor idle: no active users with tracked traders');
                    lastStatusLog = Date.now();
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }

            // Process each user independently
            for (const user of activeUsers) {
                if (!isRunning) break;

                try {
                    const trades = await getUnprocessedTradesForUser(user);
                    if (trades.length === 0) continue;

                    const shortUser = user.username || `${user.chatId}`;
                    Logger.header(
                        `⚡ ${trades.length} NEW TRADE(S) for user ${shortUser}`
                    );

                    // Get or create CLOB client for this user
                    const clobClient = await userRegistry.getClobClient(user.chatId);

                    if (!clobClient && !user.watchOnlyMode) {
                        Logger.warning(
                            `No CLOB client for user ${shortUser} - sending watch-only notifications instead`
                        );
                        // Can't trade without CLOB client, send notifications instead
                        for (const trade of trades) {
                            await sendWatchOnlyNotification(user, trade);
                            await markTradeProcessedForUser(
                                user.chatId,
                                trade.transactionHash,
                                trade.traderAddress,
                                trade.side
                            );
                        }
                        continue;
                    }

                    // Execute each trade for this user
                    for (const trade of trades) {
                        if (!isRunning) break;

                        if (clobClient && !user.watchOnlyMode) {
                            await executeTradeForUser(user, clobClient, trade);
                        } else {
                            // Watch-only (either by preference or no CLOB client)
                            await sendWatchOnlyNotification(user, trade);
                            await markTradeProcessedForUser(
                                user.chatId,
                                trade.transactionHash,
                                trade.traderAddress,
                                trade.side
                            );
                        }

                        Logger.separator();
                    }

                    // NOTE: We do NOT mark trades as globally processed (bot: true) here.
                    // Per-user tracking via ProcessedTrade handles dedup independently.
                    // This ensures multiple users tracking the same trader all get their trades.
                    lastCheck = Date.now();
                } catch (error) {
                    Logger.error(`Error processing trades for user ${user.chatId}: ${error}`);
                }
            }

            // Waiting message
            if (Date.now() - lastCheck > 5000) {
                const userCount = userRegistry.getUserCount();
                const traderCount = userRegistry.getTraderCount();
                Logger.waiting(traderCount, `${userCount} user(s)`);
                lastCheck = Date.now();
            }
        } catch (error) {
            // CRITICAL: catch any unhandled error so the loop keeps running
            Logger.error(`Trade executor loop error (will retry): ${error}`);
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    Logger.info('Trade executor stopped');
};

export default tradeExecutor;
