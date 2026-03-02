/**
 * Trade Monitor - Multi-User
 *
 * Dynamically fetches trade data for ALL tracked traders across ALL users.
 * Trader addresses come from the UserRegistry (backed by MongoDB),
 * not from static ENV variables.
 *
 * Stores trades in shared per-trader activity collections.
 * The tradeExecutor handles per-user processing separately.
 */

import { ENV } from '../config/env';
import { getUserActivityModel, getUserPositionModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import Logger from '../utils/logger';
import userRegistry from './userRegistry';

const FETCH_INTERVAL = ENV.FETCH_INTERVAL;

/**
 * Fetch trade data for all unique tracked traders from the registry.
 * Stores in shared per-trader activity collections (deduped by transactionHash).
 */
const fetchTradeData = async () => {
    const traderAddresses = userRegistry.getUniqueTrackedTraders();
    if (traderAddresses.length === 0) return;

    for (const address of traderAddresses) {
        try {
            const UserActivity = getUserActivityModel(address);
            const UserPosition = getUserPositionModel(address);

            // Fetch trade activities from Polymarket Data API
            const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE&limit=100&sortBy=TIMESTAMP&sortDirection=DESC`;
            const activities = await fetchData(apiUrl);

            if (!Array.isArray(activities) || activities.length === 0) {
                continue;
            }

            // Process each activity
            for (const activity of activities) {
                // Check if this trade already exists in database (dedup by txHash)
                const existingActivity = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (existingActivity) {
                    continue; // Already stored
                }

                // Save new trade to shared per-trader collection
                const newActivity = new UserActivity({
                    proxyWallet: activity.proxyWallet,
                    timestamp: activity.timestamp,
                    conditionId: activity.conditionId,
                    type: activity.type,
                    size: activity.size,
                    usdcSize: activity.usdcSize,
                    transactionHash: activity.transactionHash,
                    price: activity.price,
                    asset: activity.asset,
                    side: activity.side,
                    outcomeIndex: activity.outcomeIndex,
                    title: activity.title,
                    slug: activity.slug,
                    icon: activity.icon,
                    eventSlug: activity.eventSlug,
                    outcome: activity.outcome,
                    name: activity.name,
                    pseudonym: activity.pseudonym,
                    bio: activity.bio,
                    profileImage: activity.profileImage,
                    profileImageOptimized: activity.profileImageOptimized,
                    bot: false,
                    botExcutedTime: 0,
                });

                await newActivity.save();
                Logger.info(
                    `New trade detected for trader ${address.slice(0, 6)}...${address.slice(-4)}`
                );
            }

            // Also fetch and update positions for this trader
            const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`;
            const positions = await fetchData(positionsUrl);

            if (Array.isArray(positions) && positions.length > 0) {
                for (const position of positions) {
                    await UserPosition.findOneAndUpdate(
                        { asset: position.asset, conditionId: position.conditionId },
                        {
                            proxyWallet: position.proxyWallet,
                            asset: position.asset,
                            conditionId: position.conditionId,
                            size: position.size,
                            avgPrice: position.avgPrice,
                            initialValue: position.initialValue,
                            currentValue: position.currentValue,
                            cashPnl: position.cashPnl,
                            percentPnl: position.percentPnl,
                            totalBought: position.totalBought,
                            realizedPnl: position.realizedPnl,
                            percentRealizedPnl: position.percentRealizedPnl,
                            curPrice: position.curPrice,
                            redeemable: position.redeemable,
                            mergeable: position.mergeable,
                            title: position.title,
                            slug: position.slug,
                            icon: position.icon,
                            eventSlug: position.eventSlug,
                            outcome: position.outcome,
                            outcomeIndex: position.outcomeIndex,
                            oppositeOutcome: position.oppositeOutcome,
                            oppositeAsset: position.oppositeAsset,
                            endDate: position.endDate,
                            negativeRisk: position.negativeRisk,
                        },
                        { upsert: true }
                    );
                }
            }
        } catch (error) {
            Logger.error(
                `Error fetching data for trader ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
            );
        }
    }
};

// Track if monitor should continue running
let isRunning = true;

/**
 * Stop the trade monitor gracefully
 */
export const stopTradeMonitor = () => {
    isRunning = false;
    Logger.info('Trade monitor shutdown requested...');
};

const tradeMonitor = async () => {
    Logger.info('Trade monitor started (multi-user mode)');
    Logger.separator();

    while (isRunning) {
        try {
            const traderCount = userRegistry.getTraderCount();
            const userCount = userRegistry.getUserCount();

            if (traderCount === 0) {
                // No traders to monitor - idle
                // (Users will add traders via Telegram)
            } else {
                await fetchTradeData();
            }
        } catch (error) {
            // CRITICAL: catch any unhandled error so the loop keeps running
            Logger.error(`Trade monitor loop error (will retry): ${error}`);
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL * 1000));
    }

    Logger.info('Trade monitor stopped');
};

export default tradeMonitor;
