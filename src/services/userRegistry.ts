/**
 * User Registry Service
 *
 * Central service that bridges Telegram-managed users with the trading pipeline.
 * - Loads all active users from MongoDB
 * - Caches CLOB clients per user (expensive to create)
 * - Provides methods for tradeMonitor and tradeExecutor
 * - Refreshes user list periodically
 */

import { ClobClient } from '@polymarket/clob-client';
import {
    IUserWallet,
    getAllActiveUsers,
    getAllUniqueTrackedTraders,
    getActiveWallet,
    decryptKey,
} from '../models/userWallet';
import createClobClient from '../utils/createClobClient';
import Logger from '../utils/logger';

// Tracked trader with the time tracking started
export interface TrackedTraderInfo {
    address: string;
    addedAt: Date;
}

// Represents a fully resolved user ready for trading
export interface ActiveUser {
    chatId: number;
    username?: string;
    walletAddress: string;
    privateKey: string;
    trackedTraders: TrackedTraderInfo[];
    watchOnlyMode: boolean;
}

class UserRegistry {
    // Cached active users (refreshed periodically)
    private activeUsers: ActiveUser[] = [];
    // Cached CLOB clients per user chatId
    private clobClients: Map<number, ClobClient> = new Map();
    // All unique trader addresses across all users
    private uniqueTraders: string[] = [];
    // Refresh interval handle
    private refreshInterval: ReturnType<typeof setInterval> | null = null;
    // How often to refresh the user list (ms)
    private refreshIntervalMs: number = 30000; // 30 seconds

    /**
     * Initialize the registry: load users from DB and start periodic refresh
     */
    async init(): Promise<void> {
        await this.refresh();
        this.refreshInterval = setInterval(() => {
            this.refresh().catch((err) =>
                Logger.error(`UserRegistry refresh error: ${err}`)
            );
        }, this.refreshIntervalMs);
        Logger.info(
            `UserRegistry initialized: ${this.activeUsers.length} active user(s), ${this.uniqueTraders.length} unique trader(s)`
        );
    }

    /**
     * Refresh the user list and unique traders from the database
     */
    async refresh(): Promise<void> {
        try {
            const dbUsers = await getAllActiveUsers();
            const newActiveUsers: ActiveUser[] = [];

            for (const dbUser of dbUsers) {
                const activeWallet = dbUser.wallets.find((w) => w.isActive) || dbUser.wallets[0];
                if (!activeWallet) continue;

                const privateKey = decryptKey(activeWallet.encryptedPrivateKey);
                if (!privateKey || privateKey.length === 0) continue;

                const traders: TrackedTraderInfo[] = dbUser.trackedTraders.map((t) => ({
                    address: t.address.toLowerCase(),
                    addedAt: t.addedAt || new Date(0), // fallback for old records
                }));
                if (traders.length === 0) continue;

                newActiveUsers.push({
                    chatId: dbUser.telegramChatId,
                    username: dbUser.telegramUsername,
                    walletAddress: activeWallet.address,
                    privateKey,
                    trackedTraders: traders,
                    watchOnlyMode: dbUser.watchOnlyMode || false,
                });
            }

            this.activeUsers = newActiveUsers;
            this.uniqueTraders = await getAllUniqueTrackedTraders();

            // Invalidate CLOB clients for users whose wallets may have changed
            for (const [chatId, _client] of this.clobClients.entries()) {
                const user = this.activeUsers.find((u) => u.chatId === chatId);
                if (!user) {
                    // User no longer active - remove cached client
                    this.clobClients.delete(chatId);
                }
            }
        } catch (error) {
            Logger.error(`UserRegistry refresh failed: ${error}`);
        }
    }

    /**
     * Get all active users
     */
    getActiveUsers(): ActiveUser[] {
        return this.activeUsers;
    }

    /**
     * Get all unique tracked trader addresses (across all users)
     */
    getUniqueTrackedTraders(): string[] {
        return this.uniqueTraders;
    }

    /**
     * Get all users tracking a specific trader address
     */
    getUsersTrackingTrader(traderAddress: string): ActiveUser[] {
        const normalized = traderAddress.toLowerCase();
        return this.activeUsers.filter((u) =>
            u.trackedTraders.some((t) => t.address === normalized)
        );
    }

    /**
     * Get or create a CLOB client for a specific user.
     * Clients are cached to avoid expensive API key creation on every trade.
     */
    async getClobClient(chatId: number): Promise<ClobClient | undefined> {
        // Return cached client if available
        const cached = this.clobClients.get(chatId);
        if (cached) return cached;

        // Find the user
        const user = this.activeUsers.find((u) => u.chatId === chatId);
        if (!user) {
            Logger.warning(`UserRegistry: No active user found for chatId ${chatId}`);
            return undefined;
        }

        try {
            // Create new CLOB client using user's wallet credentials
            const client = await createClobClient(user.privateKey, user.walletAddress);
            if (client) {
                this.clobClients.set(chatId, client);
                Logger.info(
                    `CLOB client created for user ${user.username || chatId} (${user.walletAddress.slice(0, 8)}...)`
                );
            }
            return client;
        } catch (error) {
            Logger.error(
                `Failed to create CLOB client for user ${chatId}: ${error}`
            );
            return undefined;
        }
    }

    /**
     * Invalidate (remove) a cached CLOB client for a user.
     * Call this when a user changes their active wallet.
     */
    invalidateClobClient(chatId: number): void {
        this.clobClients.delete(chatId);
    }

    /**
     * Get the number of active users
     */
    getUserCount(): number {
        return this.activeUsers.length;
    }

    /**
     * Get the number of unique tracked traders
     */
    getTraderCount(): number {
        return this.uniqueTraders.length;
    }

    /**
     * Stop the registry (cleanup)
     */
    stop(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        this.clobClients.clear();
        Logger.info('UserRegistry stopped');
    }
}

// Singleton instance
const userRegistry = new UserRegistry();
export default userRegistry;
