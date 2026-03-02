/**
 * Telegram Bot Service for Polymarket Copy Trading Bot (Multi-User)
 *
 * Provides:
 * - Wallet management (create, import, export, switch)
 * - Trader management (add/remove traders to copy)
 * - Real-time trade notifications
 * - Remote commands to check status, positions, and control the bot
 * - Daily P&L summaries
 *
 * All commands use per-user wallets from MongoDB, NOT static ENV vars.
 */

import TelegramBot from 'node-telegram-bot-api';
import schedule from 'node-schedule';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import getMyBalance from '../utils/getMyBalance';
import Logger from '../utils/logger';
import {
    getUserByChatId,
    createUserWithWallet,
    addWalletToUser,
    getUserWallets,
    getActiveWallet,
    setActiveWallet,
    removeWallet,
    renameWallet,
    importWalletToUser,
    addTrackedTrader,
    removeTrackedTrader,
    getTrackedTraders,
    setUserWatchOnlyMode,
} from '../models/userWallet';
import userRegistry from './userRegistry';

// Bot instance (singleton)
let bot: TelegramBot | null = null;

// Track subscribed users (chat IDs that should receive notifications)
const subscribedUsers: Set<number> = new Set();

// Bot control state (per-user pauses tracked in DB via watchOnlyMode)
const pausedUsers: Set<number> = new Set();

// Daily summary job
let dailySummaryJob: schedule.Job | null = null;

// Pending rename operations (chatId -> wallet address)
const pendingRenames: Map<number, string> = new Map();

/**
 * Initialize the Telegram bot
 */
export const initTelegramBot = (): TelegramBot | null => {
    const token = ENV.TELEGRAM_BOT_TOKEN;
    const enabled = ENV.TELEGRAM_ENABLED;

    if (!enabled || !token) {
        Logger.info('Telegram bot is disabled or token not configured');
        return null;
    }

    try {
        bot = new TelegramBot(token, { polling: true });

        // Register command handlers
        registerCommands(bot);

        // Schedule daily summary at 8:00 AM
        scheduleDailySummary();

        // Load all existing users as subscribers on startup
        // (so they receive notifications without needing to send a command first)
        loadSubscribersFromDB().catch((err) =>
            Logger.warning(`Failed to load subscribers from DB: ${err}`)
        );

        Logger.success('Telegram bot initialized and ready');
        return bot;
    } catch (error) {
        Logger.error(`Failed to initialize Telegram bot: ${error}`);
        return null;
    }
};

/**
 * Load all users from the database into subscribedUsers on startup.
 * This ensures notifications work even after a bot restart.
 */
const loadSubscribersFromDB = async (): Promise<void> => {
    try {
        const { getAllActiveUsers } = await import('../models/userWallet');
        const users = await getAllActiveUsers();
        for (const user of users) {
            subscribedUsers.add(user.telegramChatId);
        }
        // Also load users who have wallets but no traders yet (they still want notifications)
        const UserWallet = (await import('../models/userWallet')).default;
        const allUsers = await UserWallet.find({ 'wallets.0': { $exists: true } });
        for (const user of allUsers) {
            subscribedUsers.add(user.telegramChatId);
        }
        Logger.info(`Loaded ${subscribedUsers.size} subscriber(s) from database`);
    } catch (error) {
        Logger.warning(`Could not load subscribers: ${error}`);
    }
};

/**
 * Get the bot instance
 */
export const getTelegramBot = (): TelegramBot | null => bot;

/**
 * Check if trading is paused for a user via Telegram
 */
export const isTradingPausedByTelegram = (): boolean => false; // Legacy compat; per-user via watchOnlyMode

/**
 * Helper: Get user's active wallet address (from DB, not ENV)
 */
const getUserWalletAddress = async (chatId: number): Promise<string | null> => {
    const wallet = await getActiveWallet(chatId);
    return wallet ? wallet.address : null;
};

/**
 * Register all command handlers
 */
const registerCommands = (bot: TelegramBot): void => {
    // /start - Welcome and create wallet for new users
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from?.username;
        subscribedUsers.add(chatId);

        try {
            const existingUser = await getUserByChatId(chatId);

            if (existingUser && existingUser.wallets.length > 0) {
                const activeWallet = await getActiveWallet(chatId);
                const shortAddr = activeWallet
                    ? `${activeWallet.address.slice(0, 8)}...${activeWallet.address.slice(-6)}`
                    : 'None';

                const traderCount = existingUser.trackedTraders?.length || 0;

                const welcomeBackMessage = `
🤖 *Welcome Back!*

You have ${existingUser.wallets.length} wallet(s) and ${traderCount} tracked trader(s).

*Active Wallet:* \`${shortAddr}\`

*Quick Start:*
/addtrader \`0x...\` - Add a trader to copy
/traders - View tracked traders
/wallets - View all your wallets
/status - Bot status and balance
/help - All commands
                `;

                await bot.sendMessage(chatId, welcomeBackMessage, { parse_mode: 'Markdown' });
            } else {
                const { wallet } = await createUserWithWallet(chatId, username);
                const shortAddr = `${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}`;

                const welcomeMessage = `
🎉 *Welcome to Polymarket Copy Trading Bot\\!*

✅ *Your wallet has been created\\!*

🔐 *Wallet Address:*
\`${wallet.address}\`

⚠️ *IMPORTANT \\- Save Your Private Key:*
||${wallet.privateKey}||

_Tap the hidden text above to reveal\\. Save this somewhere safe\\!_

*Next Steps:*
1️⃣ Send USDC \\(Polygon\\) to your wallet address
2️⃣ Send a small amount of POL/MATIC for gas fees
3️⃣ Add a trader to copy: /addtrader \`0xADDRESS\`
4️⃣ Use /status to check your balance

*Commands:*
/addtrader \\- Add trader to copy
/traders \\- View tracked traders
/wallets \\- View your wallets
/help \\- All commands

Your wallet: \`${shortAddr}\`
                `;

                await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'MarkdownV2' });
            }
        } catch (error) {
            Logger.error(`Error in /start: ${error}`);
            await bot.sendMessage(
                chatId,
                '❌ Error setting up your account. Please try again or contact support.'
            );
        }
    });

    // /help - Show available commands
    bot.onText(/\/help/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        const helpMessage = `
📖 *Available Commands:*

*Trader Management:*
/addtrader \`0x...\` - Add a trader to copy
/removetrader \`0x...\` - Stop copying a trader
/traders - View all tracked traders with stats

*Wallet Commands:*
/wallets - View all your wallets
/settings - Manage wallets
/addwallet - Create a new wallet
/importwallet - Import existing wallet
/export - Export wallet (address + private key)

*Info Commands:*
/status - Bot status, balance, tracked traders
/positions - List all current positions with P&L
/balance - Check USDC and POL balance

*Control Commands:*
/stop - Pause trade copying (watch only)
/resume - Resume trade copying
/watch - Toggle watch only mode

*Position Management:*
/close - Close all resolved positions
/redeem - Redeem winning positions

*Reports:*
/daily - Force send daily P&L summary
        `;

        await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    });

    // ============================================================
    // TRADER MANAGEMENT (NEW for multi-user)
    // ============================================================

    // /addtrader <address> - Add a trader to copy
    bot.onText(/\/addtrader(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        const address = match?.[1]?.trim();

        if (!address) {
            await bot.sendMessage(
                chatId,
                `📋 *Add a Trader to Copy*

Send a Polymarket trader address:

\`/addtrader 0x1234...abcd\`

💡 *Where to find trader addresses:*
• Polymarket Leaderboard: polymarket.com/leaderboard
• Predictfolio: predictfolio.com
• Copy the address from a trader's profile URL`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        try {
            const result = await addTrackedTrader(chatId, address);

            if (result.success) {
                const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;

                // Mark all existing trades from this trader as already processed
                // so the user doesn't get flooded with historical notifications
                try {
                    const { getUserActivityModel } = await import('../models/userHistory');
                    const { markTradeProcessedForUser } = await import('../models/userHistory');
                    const UserActivity = getUserActivityModel(address.toLowerCase());
                    const existingTrades = await UserActivity.find({ type: 'TRADE' }).select('transactionHash side').exec();
                    for (const trade of existingTrades) {
                        if (trade.transactionHash) {
                            await markTradeProcessedForUser(chatId, trade.transactionHash, address.toLowerCase(), trade.side || '');
                        }
                    }
                    Logger.info(`Marked ${existingTrades.length} historical trades as processed for user ${chatId}`);
                } catch (err) {
                    // Non-critical - worst case user gets some old notifications
                    Logger.warning(`Could not mark historical trades: ${err}`);
                }

                // Force registry refresh so the monitor picks up the new trader
                await userRegistry.refresh();

                await bot.sendMessage(
                    chatId,
                    `✅ *Trader Added!*

Now tracking: \`${shortAddr}\`

The bot will automatically copy their future trades.

*Note:* Only NEW trades will be copied (not historical ones).

/traders - View all tracked traders
/removetrader \`${address}\` - Stop copying`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await bot.sendMessage(chatId, `❌ ${result.error}`);
            }
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error adding trader: ${error}`);
        }
    });

    // /removetrader <address> - Remove a tracked trader
    bot.onText(/\/removetrader(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        const address = match?.[1]?.trim();

        if (!address) {
            // Show list of current traders for easy removal
            const traders = await getTrackedTraders(chatId);
            if (traders.length === 0) {
                await bot.sendMessage(chatId, '📋 You are not tracking any traders.\n\nUse /addtrader to start.');
                return;
            }

            let list = '📋 *Your Tracked Traders:*\n\n';
            for (const t of traders) {
                const short = `${t.address.slice(0, 8)}...${t.address.slice(-6)}`;
                list += `• \`${t.address}\`\n  /removetrader \`${t.address}\`\n\n`;
            }
            list += '_Tap an address above to copy, then use /removetrader_';

            await bot.sendMessage(chatId, list, { parse_mode: 'Markdown' });
            return;
        }

        try {
            const removed = await removeTrackedTrader(chatId, address);
            if (removed) {
                await userRegistry.refresh();
                const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
                await bot.sendMessage(
                    chatId,
                    `✅ Stopped tracking \`${shortAddr}\`\n\n/traders - View remaining traders`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await bot.sendMessage(chatId, '❌ Trader not found in your tracked list.');
            }
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error removing trader: ${error}`);
        }
    });

    // /traders - Show tracked traders
    bot.onText(/\/traders/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const traders = await getTrackedTraders(chatId);

            if (traders.length === 0) {
                await bot.sendMessage(
                    chatId,
                    `📋 *No Tracked Traders*

You're not copying anyone yet.

Add a trader: /addtrader \`0xADDRESS\`

💡 Find top traders at:
• polymarket.com/leaderboard
• predictfolio.com`,
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            let tradersList = '';
            for (let i = 0; i < traders.length; i++) {
                const t = traders[i];
                const shortAddr = `${t.address.slice(0, 8)}...${t.address.slice(-6)}`;

                // Fetch trader positions for stats
                let posCount = 0;
                let totalValue = 0;
                try {
                    const positions = await fetchData(
                        `https://data-api.polymarket.com/positions?user=${t.address}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
                    );
                    if (Array.isArray(positions)) {
                        posCount = positions.length;
                        positions.forEach((pos: any) => {
                            totalValue += pos.currentValue || 0;
                        });
                    }
                } catch {
                    // Ignore fetch errors
                }

                tradersList += `${i + 1}. \`${shortAddr}\`\n`;
                tradersList += `   📊 ${posCount} positions | $${totalValue.toFixed(0)} value\n\n`;
            }

            const message = `
👥 *Your Tracked Traders* (${traders.length})

${tradersList}
/addtrader \`0x...\` - Add another
/removetrader \`0x...\` - Stop copying
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error fetching traders: ${error}`);
        }
    });

    // ============================================================
    // STATUS & INFO COMMANDS (using per-user wallet from DB)
    // ============================================================

    // /status - Bot status
    bot.onText(/\/status/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const walletAddress = await getUserWalletAddress(chatId);
            const traders = await getTrackedTraders(chatId);
            const user = await getUserByChatId(chatId);
            const isWatchOnly = user?.watchOnlyMode || false;
            const isPaused = pausedUsers.has(chatId);

            let balance = 0;
            if (walletAddress) {
                try {
                    balance = await getMyBalance(walletAddress);
                } catch {
                    // Ignore balance errors
                }
            }

            let statusEmoji: string;
            let statusText: string;

            if (!walletAddress) {
                statusEmoji = '❌';
                statusText = 'NO WALLET';
            } else if (isWatchOnly) {
                statusEmoji = '👁️';
                statusText = 'WATCH ONLY';
            } else if (isPaused) {
                statusEmoji = '⏸️';
                statusText = 'PAUSED';
            } else {
                statusEmoji = '✅';
                statusText = 'RUNNING';
            }

            const shortWallet = walletAddress
                ? `${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}`
                : 'None - use /start';

            const statusMessage = `
🤖 *Bot Status*

${statusEmoji} Status: *${statusText}*
💰 Balance: *$${balance.toFixed(2)}* USDC
👥 Tracking: *${traders.length}* trader(s)
🔗 Wallet: \`${shortWallet}\`
${isWatchOnly ? '\n👁️ _Watch only mode - trades are monitored but NOT copied_' : ''}
${traders.length === 0 ? '\n💡 _Add a trader: /addtrader 0xADDRESS_' : ''}
            `;

            await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error fetching status: ${error}`);
        }
    });

    // /positions - List positions
    bot.onText(/\/positions/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const walletAddress = await getUserWalletAddress(chatId);
            if (!walletAddress) {
                await bot.sendMessage(chatId, '❌ No wallet configured. Use /start to create one.');
                return;
            }

            const positions = await fetchData(
                `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
            );

            if (!Array.isArray(positions) || positions.length === 0) {
                await bot.sendMessage(chatId, '📊 No open positions found.');
                return;
            }

            let totalValue = 0;
            let totalPnL = 0;
            positions.forEach((pos: any) => {
                totalValue += pos.currentValue || 0;
                totalPnL += pos.cashPnl || 0;
            });

            const topPositions = positions
                .sort((a: any, b: any) => (b.currentValue || 0) - (a.currentValue || 0))
                .slice(0, 10);

            let positionsList = '';
            topPositions.forEach((pos: any, idx: number) => {
                const pnlEmoji = (pos.percentPnl || 0) >= 0 ? '📈' : '📉';
                const pnlPercent = ((pos.percentPnl || 0) * 100).toFixed(1);
                positionsList += `${idx + 1}. ${pos.title?.slice(0, 30) || 'Unknown'}...\n`;
                positionsList += `   ${pos.outcome || 'N/A'} | $${(pos.currentValue || 0).toFixed(2)} ${pnlEmoji} ${pnlPercent}%\n\n`;
            });

            const pnlEmoji = totalPnL >= 0 ? '📈' : '📉';
            const message = `
📊 *Your Positions* (${positions.length} total)

*Total Value:* $${totalValue.toFixed(2)}
*Total P&L:* ${pnlEmoji} $${totalPnL.toFixed(2)}

*Top 10 by Value:*
${positionsList}
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error fetching positions: ${error}`);
        }
    });

    // /balance - Check balance
    bot.onText(/\/balance/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const walletAddress = await getUserWalletAddress(chatId);
            if (!walletAddress) {
                await bot.sendMessage(chatId, '❌ No wallet configured. Use /start to create one.');
                return;
            }

            const usdcBalance = await getMyBalance(walletAddress);

            const message = `
💰 *Wallet Balance*

*USDC:* $${usdcBalance.toFixed(2)}
*Wallet:* \`${walletAddress}\`

_Note: POL/MATIC for gas is checked separately on the blockchain._
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error fetching balance: ${error}`);
        }
    });

    // ============================================================
    // CONTROL COMMANDS
    // ============================================================

    // /stop - Pause trading (watch only)
    bot.onText(/\/stop/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        pausedUsers.add(chatId);
        await setUserWatchOnlyMode(chatId, true);
        await userRegistry.refresh();

        await bot.sendMessage(
            chatId,
            '⏸️ *Trade copying PAUSED*\n\nNew trades will be monitored but NOT copied.\nUse /resume to start copying again.',
            { parse_mode: 'Markdown' }
        );
    });

    // /resume - Resume trading
    bot.onText(/\/resume/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        pausedUsers.delete(chatId);
        await setUserWatchOnlyMode(chatId, false);
        await userRegistry.refresh();

        await bot.sendMessage(
            chatId,
            '✅ *Trade copying RESUMED*\n\nBot will now copy new trades from your tracked traders.',
            { parse_mode: 'Markdown' }
        );
    });

    // /watch - Toggle watch only mode
    bot.onText(/\/watch/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const user = await getUserByChatId(chatId);
            const currentMode = user?.watchOnlyMode || false;
            const newMode = !currentMode;

            await setUserWatchOnlyMode(chatId, newMode);
            await userRegistry.refresh();

            if (newMode) {
                await bot.sendMessage(
                    chatId,
                    `👁️ *Watch Only Mode ENABLED*

The bot will now:
• Monitor all your tracked traders
• Send notifications when they trade
• NOT execute any trades on your behalf

Use /watch again to disable and start copying trades.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await bot.sendMessage(
                    chatId,
                    `✅ *Watch Only Mode DISABLED*

The bot will now copy trades from your tracked traders.`,
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error toggling watch mode: ${error}`);
        }
    });

    // ============================================================
    // WALLET COMMANDS (mostly unchanged, but use per-user DB)
    // ============================================================

    // /wallets - List all user wallets
    bot.onText(/\/wallets/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const wallets = await getUserWallets(chatId);

            if (wallets.length === 0) {
                await bot.sendMessage(
                    chatId,
                    '❌ No wallets found. Use /start to create your first wallet.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            let walletList = '';
            for (let i = 0; i < wallets.length; i++) {
                const w = wallets[i];
                const shortAddr = `${w.address.slice(0, 8)}...${w.address.slice(-6)}`;
                const activeIcon = w.isActive ? '✅' : '⚪';

                let balance = 0;
                try {
                    balance = await getMyBalance(w.address);
                } catch {
                    // Ignore balance errors
                }

                walletList += `${activeIcon} *${w.name}*\n`;
                walletList += `   \`${shortAddr}\`\n`;
                walletList += `   💰 $${balance.toFixed(2)} USDC\n\n`;
            }

            const message = `
💼 *Your Wallets* (${wallets.length})

${walletList}
✅ = Active wallet (used for trading)

*Management:*
/settings - Manage wallets
/addwallet - Create new wallet
/importwallet - Import existing wallet
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error fetching wallets: ${error}`);
        }
    });

    // /settings - Wallet management menu
    bot.onText(/\/settings/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const wallets = await getUserWallets(chatId);

            if (wallets.length === 0) {
                await bot.sendMessage(
                    chatId,
                    '❌ No wallets found. Use /start to create your first wallet.'
                );
                return;
            }

            const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

            for (const w of wallets) {
                const shortAddr = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
                const activeIcon = w.isActive ? '✅ ' : '';
                keyboard.push([
                    {
                        text: `${activeIcon}${w.name} (${shortAddr})`,
                        callback_data: `wallet_select_${w.address}`,
                    },
                ]);
            }

            keyboard.push([
                { text: '➕ Add New Wallet', callback_data: 'wallet_add' },
                { text: '📥 Import Wallet', callback_data: 'wallet_import' },
            ]);

            await bot.sendMessage(chatId, '⚙️ *Wallet Settings*\n\nSelect a wallet to manage:', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard },
            });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error: ${error}`);
        }
    });

    // /addwallet - Create a new wallet
    bot.onText(/\/addwallet(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);
        const walletName = match?.[1]?.trim() || '';

        try {
            const existingUser = await getUserByChatId(chatId);

            if (!existingUser) {
                await bot.sendMessage(chatId, '❌ Please run /start first to set up your account.');
                return;
            }

            const newWallet = await addWalletToUser(chatId, walletName || `Wallet ${existingUser.wallets.length + 1}`);

            if (!newWallet) {
                await bot.sendMessage(chatId, '❌ Failed to create wallet. Please try again.');
                return;
            }

            // Invalidate CLOB client cache since wallet changed
            userRegistry.invalidateClobClient(chatId);

            const message = `
✅ *New Wallet Created!*

*Address:*
\`${newWallet.address}\`

⚠️ *Private Key (SAVE THIS!):*
||${newWallet.privateKey}||

_Tap to reveal. Store securely!_

Use /wallets to see all your wallets.
Use /settings to switch active wallet.
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error creating wallet: ${error}`);
        }
    });

    // /importwallet - Start import process
    bot.onText(/\/importwallet/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        const message = `
📥 *Import Existing Wallet*

To import a wallet, send your private key in this format:

\`/import YOUR_PRIVATE_KEY WalletName\`

Example:
\`/import 0x123abc... Trading Wallet\`

⚠️ *Security Warning:*
• Only import wallets you control
• Never share your private key publicly
• Delete the message after import
        `;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /import - Actually import the wallet
    bot.onText(/\/import\s+(\S+)(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            await bot.deleteMessage(chatId, msg.message_id);
        } catch {
            // Can't delete in some cases
        }

        const privateKey = match?.[1];
        const walletName = match?.[2]?.trim() || 'Imported Wallet';

        if (!privateKey) {
            await bot.sendMessage(chatId, '❌ Please provide a private key.');
            return;
        }

        try {
            const result = await importWalletToUser(chatId, privateKey, walletName);

            if (result.success) {
                userRegistry.invalidateClobClient(chatId);
                await bot.sendMessage(
                    chatId,
                    `✅ *Wallet Imported Successfully!*\n\nAddress: \`${result.address}\`\n\n_Your message with the private key has been deleted for security._`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await bot.sendMessage(chatId, `❌ Import failed: ${result.error}`);
            }
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error importing wallet: ${error}`);
        }
    });

    // /export - Export active wallet details
    bot.onText(/\/export/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const activeWallet = await getActiveWallet(chatId);

            if (!activeWallet) {
                await bot.sendMessage(chatId, '❌ No wallet found. Use /start to create one.');
                return;
            }

            let balance = 0;
            try {
                balance = await getMyBalance(activeWallet.address);
            } catch {
                // Ignore
            }

            const exportMessage = `
📤 *Export Wallet: ${activeWallet.name}*

*Address:*
\`${activeWallet.address}\`

*Private Key:*
||${activeWallet.privateKey}||

*Balance:* $${balance.toFixed(2)} USDC

⚠️ *Security:*
• This message will auto\\-delete in 60 seconds
• Never share your private key
• Save it in a secure password manager

💡 *Import to MetaMask:*
1\\. Open MetaMask → Settings → Security
2\\. Select "Import Account"
3\\. Paste your private key
            `;

            const exportMsg = await bot.sendMessage(chatId, exportMessage, {
                parse_mode: 'MarkdownV2',
            });

            setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, exportMsg.message_id);
                    await bot.sendMessage(chatId, '🗑️ Export message deleted for security.', {
                        parse_mode: 'Markdown',
                    });
                } catch {
                    // Message may already be deleted
                }
            }, 60000);
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error exporting wallet: ${error}`);
        }
    });

    // /close - Close resolved positions
    bot.onText(/\/close/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const walletAddress = await getUserWalletAddress(chatId);
            if (!walletAddress) {
                await bot.sendMessage(chatId, '❌ No wallet configured. Use /start to create one.');
                return;
            }

            const positions = await fetchData(
                `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
            );

            if (!Array.isArray(positions) || positions.length === 0) {
                await bot.sendMessage(chatId, '📊 No positions to close.');
                return;
            }

            const resolved = positions.filter(
                (pos: any) => pos.curPrice >= 0.99 || pos.curPrice <= 0.01
            );

            if (resolved.length === 0) {
                await bot.sendMessage(chatId, '✅ No resolved positions found. All positions are still active.');
                return;
            }

            let resolvedList = '';
            let totalValue = 0;
            resolved.forEach((pos: any, idx: number) => {
                const status = pos.curPrice >= 0.99 ? '🎉 WIN' : '❌ LOSS';
                resolvedList += `${idx + 1}. ${status} ${pos.title?.slice(0, 25) || 'Unknown'}...\n`;
                resolvedList += `   ${pos.outcome || 'N/A'} | $${(pos.currentValue || 0).toFixed(2)}\n\n`;
                totalValue += pos.currentValue || 0;
            });

            const message = `
🔄 *Resolved Positions* (${resolved.length})

${resolvedList}
*Total Value:* $${totalValue.toFixed(2)}

⚠️ _To close these positions, run on server:_
\`npm run close-resolved\`
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error: ${error}`);
        }
    });

    // /redeem - Show redeemable positions
    bot.onText(/\/redeem/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);

        try {
            const walletAddress = await getUserWalletAddress(chatId);
            if (!walletAddress) {
                await bot.sendMessage(chatId, '❌ No wallet configured. Use /start to create one.');
                return;
            }

            const positions = await fetchData(
                `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
            );

            if (!Array.isArray(positions) || positions.length === 0) {
                await bot.sendMessage(chatId, '📊 No positions found.');
                return;
            }

            const redeemable = positions.filter(
                (pos: any) =>
                    pos.redeemable === true &&
                    (pos.curPrice >= 0.99 || pos.curPrice <= 0.01)
            );

            if (redeemable.length === 0) {
                await bot.sendMessage(chatId, '✅ No redeemable positions found.');
                return;
            }

            let redeemList = '';
            let totalValue = 0;
            redeemable.forEach((pos: any, idx: number) => {
                const status = pos.curPrice >= 0.99 ? '🎉' : '❌';
                redeemList += `${idx + 1}. ${status} ${pos.title?.slice(0, 25) || 'Unknown'}...\n`;
                redeemList += `   $${(pos.currentValue || 0).toFixed(2)}\n\n`;
                totalValue += pos.currentValue || 0;
            });

            const message = `
💎 *Redeemable Positions* (${redeemable.length})

${redeemList}
*Total Value:* $${totalValue.toFixed(2)}

⚠️ _To redeem, run on server:_
\`npm run redeem-resolved\`
            `;

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            await bot.sendMessage(chatId, `❌ Error: ${error}`);
        }
    });

    // /daily - Force daily summary
    bot.onText(/\/daily/, async (msg) => {
        const chatId = msg.chat.id;
        subscribedUsers.add(chatId);
        await sendDailySummary(chatId);
    });

    // Handle callback queries for wallet settings
    bot.on('callback_query', async (query) => {
        if (!query.data || !query.message) return;

        const chatId = query.message.chat.id;
        const data = query.data;

        try {
            if (data.startsWith('wallet_select_')) {
                const address = data.replace('wallet_select_', '');
                const wallets = await getUserWallets(chatId);
                const wallet = wallets.find((w) => w.address === address);

                if (!wallet) {
                    await bot.answerCallbackQuery(query.id, { text: 'Wallet not found' });
                    return;
                }

                const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
                let balance = 0;
                try {
                    balance = await getMyBalance(address);
                } catch {
                    // Ignore
                }

                const keyboard: TelegramBot.InlineKeyboardButton[][] = [
                    [
                        { text: '✅ Set as Active', callback_data: `wallet_activate_${address}` },
                        { text: '✏️ Rename', callback_data: `wallet_rename_${address}` },
                    ],
                    [
                        { text: '🔑 Show Private Key', callback_data: `wallet_showkey_${address}` },
                    ],
                    [
                        { text: '🗑️ Remove', callback_data: `wallet_remove_${address}` },
                    ],
                    [{ text: '« Back', callback_data: 'settings_back' }],
                ];

                await bot.editMessageText(
                    `💼 *${wallet.name}*\n\nAddress: \`${shortAddr}\`\nFull: \`${address}\`\nBalance: $${balance.toFixed(2)} USDC\nActive: ${wallet.isActive ? 'Yes ✅' : 'No'}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: keyboard },
                    }
                );
            } else if (data.startsWith('wallet_activate_')) {
                const address = data.replace('wallet_activate_', '');
                const success = await setActiveWallet(chatId, address);

                if (success) {
                    userRegistry.invalidateClobClient(chatId);
                    await userRegistry.refresh();
                    await bot.answerCallbackQuery(query.id, { text: '✅ Wallet activated!' });
                    await bot.deleteMessage(chatId, query.message.message_id);

                    const wallets = await getUserWallets(chatId);
                    const keyboard: TelegramBot.InlineKeyboardButton[][] = wallets.map((w) => [
                        {
                            text: `${w.isActive ? '✅ ' : ''}${w.name} (${w.address.slice(0, 6)}...${w.address.slice(-4)})`,
                            callback_data: `wallet_select_${w.address}`,
                        },
                    ]);
                    keyboard.push([
                        { text: '➕ Add New Wallet', callback_data: 'wallet_add' },
                        { text: '📥 Import Wallet', callback_data: 'wallet_import' },
                    ]);
                    await bot.sendMessage(chatId, '⚙️ *Wallet Settings*\n\nSelect a wallet to manage:', {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: keyboard },
                    });
                } else {
                    await bot.answerCallbackQuery(query.id, { text: '❌ Failed to activate' });
                }
            } else if (data.startsWith('wallet_showkey_')) {
                const address = data.replace('wallet_showkey_', '');
                const wallets = await getUserWallets(chatId);
                const wallet = wallets.find((w) => w.address === address);

                if (wallet) {
                    const keyMsg = await bot.sendMessage(
                        chatId,
                        `🔐 *Private Key for ${wallet.name}*\n\n\`${wallet.privateKey}\`\n\n_This message will be deleted in 30 seconds._`,
                        { parse_mode: 'Markdown' }
                    );

                    setTimeout(async () => {
                        try {
                            await bot.deleteMessage(chatId, keyMsg.message_id);
                        } catch {
                            // Message may already be deleted
                        }
                    }, 30000);

                    await bot.answerCallbackQuery(query.id, { text: 'Key shown (auto-deletes in 30s)' });
                }
            } else if (data.startsWith('wallet_remove_')) {
                const address = data.replace('wallet_remove_', '');
                const wallets = await getUserWallets(chatId);

                if (wallets.length <= 1) {
                    await bot.answerCallbackQuery(query.id, {
                        text: "❌ Can't remove your only wallet!",
                        show_alert: true,
                    });
                    return;
                }

                const success = await removeWallet(chatId, address);

                if (success) {
                    userRegistry.invalidateClobClient(chatId);
                    await bot.answerCallbackQuery(query.id, { text: '✅ Wallet removed' });
                    await bot.deleteMessage(chatId, query.message.message_id);
                    await bot.sendMessage(chatId, '✅ Wallet has been removed.\n\nUse /wallets to see your remaining wallets.');
                } else {
                    await bot.answerCallbackQuery(query.id, { text: '❌ Failed to remove' });
                }
            } else if (data === 'wallet_add') {
                await bot.answerCallbackQuery(query.id);
                await bot.sendMessage(
                    chatId,
                    'To create a new wallet, use:\n\n`/addwallet Wallet Name`\n\nExample: `/addwallet Trading Bot 2`',
                    { parse_mode: 'Markdown' }
                );
            } else if (data === 'wallet_import') {
                await bot.answerCallbackQuery(query.id);
                await bot.sendMessage(
                    chatId,
                    '📥 To import a wallet, use:\n\n`/import PRIVATE_KEY Wallet Name`\n\nExample:\n`/import 0x123abc... My Imported Wallet`',
                    { parse_mode: 'Markdown' }
                );
            } else if (data === 'settings_back') {
                const wallets = await getUserWallets(chatId);
                const keyboard: TelegramBot.InlineKeyboardButton[][] = wallets.map((w) => [
                    {
                        text: `${w.isActive ? '✅ ' : ''}${w.name} (${w.address.slice(0, 6)}...${w.address.slice(-4)})`,
                        callback_data: `wallet_select_${w.address}`,
                    },
                ]);
                keyboard.push([
                    { text: '➕ Add New Wallet', callback_data: 'wallet_add' },
                    { text: '📥 Import Wallet', callback_data: 'wallet_import' },
                ]);

                await bot.editMessageText('⚙️ *Wallet Settings*\n\nSelect a wallet to manage:', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard },
                });
            } else if (data.startsWith('wallet_rename_')) {
                const address = data.replace('wallet_rename_', '');
                await bot.answerCallbackQuery(query.id);
                pendingRenames.set(chatId, address);
                await bot.sendMessage(chatId, '✏️ *Rename Wallet*\n\nSend the new name for this wallet:', {
                    parse_mode: 'Markdown',
                });
            }
        } catch (error) {
            Logger.error(`Callback query error: ${error}`);
            await bot.answerCallbackQuery(query.id, { text: 'An error occurred' });
        }
    });

    // Handle text messages for rename flow
    bot.on('message', async (msg) => {
        if (!msg.text || msg.text.startsWith('/')) return;

        const chatId = msg.chat.id;
        const pendingAddress = pendingRenames.get(chatId);

        if (pendingAddress) {
            const newName = msg.text.trim();
            const success = await renameWallet(chatId, pendingAddress, newName);
            pendingRenames.delete(chatId);

            if (success) {
                await bot.sendMessage(chatId, `✅ Wallet renamed to "${newName}"\n\nUse /wallets to see your wallets.`);
            } else {
                await bot.sendMessage(chatId, '❌ Failed to rename wallet.');
            }
        }
    });
};

/**
 * Schedule daily P&L summary at 8:00 AM
 */
const scheduleDailySummary = (): void => {
    dailySummaryJob = schedule.scheduleJob('0 8 * * *', async () => {
        Logger.info('Sending scheduled daily summary...');
        for (const chatId of subscribedUsers) {
            await sendDailySummary(chatId);
        }
    });
};

/**
 * Send daily P&L summary to a specific chat (using per-user wallet)
 */
const sendDailySummary = async (chatId: number): Promise<void> => {
    if (!bot) return;

    try {
        const walletAddress = await getUserWalletAddress(chatId);
        if (!walletAddress) return;

        const positions = await fetchData(
            `https://data-api.polymarket.com/positions?user=${walletAddress}&sizeThreshold=0.1&limit=100&sortBy=TOKENS&sortDirection=DESC`
        );
        const balance = await getMyBalance(walletAddress);
        const traders = await getTrackedTraders(chatId);

        let totalValue = 0;
        let totalPnL = 0;
        let totalRealizedPnL = 0;
        let winCount = 0;
        let lossCount = 0;

        if (Array.isArray(positions)) {
            positions.forEach((pos: any) => {
                totalValue += pos.currentValue || 0;
                totalPnL += pos.cashPnl || 0;
                totalRealizedPnL += pos.realizedPnl || 0;

                if ((pos.percentPnl || 0) > 0) winCount++;
                else if ((pos.percentPnl || 0) < 0) lossCount++;
            });
        }

        const positionCount = Array.isArray(positions) ? positions.length : 0;
        const pnlEmoji = totalPnL >= 0 ? '📈' : '📉';
        const winRate = positionCount > 0 ? ((winCount / positionCount) * 100).toFixed(1) : '0';

        const message = `
📊 *Daily P&L Summary*
${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

💰 *USDC Balance:* $${balance.toFixed(2)}
📦 *Open Positions:* ${positionCount}
💎 *Position Value:* $${totalValue.toFixed(2)}

${pnlEmoji} *Unrealized P&L:* $${totalPnL.toFixed(2)}
💵 *Realized P&L:* $${totalRealizedPnL.toFixed(2)}

📊 *Win Rate:* ${winRate}% (${winCount}W / ${lossCount}L)

_Tracking ${traders.length} trader(s)_
        `;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        if (bot) {
            await bot.sendMessage(chatId, `❌ Error generating daily summary: ${error}`);
        }
    }
};

/**
 * Send a notification to all subscribed users
 */
export const sendNotification = async (message: string, parseMode: 'Markdown' | 'HTML' = 'Markdown'): Promise<void> => {
    if (!bot) return;

    for (const chatId of subscribedUsers) {
        try {
            await bot.sendMessage(chatId, message, { parse_mode: parseMode });
        } catch (error) {
            Logger.warning(`Failed to send notification to ${chatId}: ${error}`);
        }
    }
};

/**
 * Send a notification to a SPECIFIC user by chatId.
 * Use this for per-user trade notifications (not broadcast).
 */
export const sendNotificationToUser = async (
    chatId: number,
    message: string,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<void> => {
    if (!bot) return;

    try {
        await bot.sendMessage(chatId, message, { parse_mode: parseMode });
    } catch (error) {
        Logger.warning(`Failed to send notification to user ${chatId}: ${error}`);
    }
};

/**
 * Send trade notification
 */
export const sendTradeNotification = async (
    traderAddress: string,
    side: 'BUY' | 'SELL',
    details: {
        title?: string;
        outcome?: string;
        amount: number;
        price: number;
        success: boolean;
        errorMessage?: string;
    }
): Promise<void> => {
    if (!bot || subscribedUsers.size === 0) return;

    const shortAddr = `${traderAddress.slice(0, 6)}...${traderAddress.slice(-4)}`;
    const sideEmoji = side === 'BUY' ? '🟢' : '🔴';
    const statusEmoji = details.success ? '✅' : '❌';

    let message: string;

    if (details.success) {
        message = `
${sideEmoji} *Trade Copied*

*Side:* ${side}
*Market:* ${details.title?.slice(0, 40) || 'Unknown'}
*Outcome:* ${details.outcome || 'N/A'}
*Amount:* $${details.amount.toFixed(2)}
*Price:* $${details.price.toFixed(4)}

👤 Copied from: \`${shortAddr}\`
        `;
    } else {
        message = `
${statusEmoji} *Trade Failed*

*Side:* ${side}
*Market:* ${details.title?.slice(0, 40) || 'Unknown'}
*Error:* ${details.errorMessage || 'Unknown error'}

👤 Trader: \`${shortAddr}\`
        `;
    }

    await sendNotification(message);
};

/**
 * Send error notification
 */
export const sendErrorNotification = async (error: string, context?: string): Promise<void> => {
    if (!bot || subscribedUsers.size === 0) return;

    const message = `
⚠️ *Bot Error*

${context ? `*Context:* ${context}\n` : ''}*Error:* ${error}

_Check bot logs for details._
    `;

    await sendNotification(message);
};

/**
 * Stop the Telegram bot
 */
export const stopTelegramBot = (): void => {
    if (dailySummaryJob) {
        dailySummaryJob.cancel();
        dailySummaryJob = null;
    }

    if (bot) {
        bot.stopPolling();
        bot = null;
        Logger.info('Telegram bot stopped');
    }
};

export default {
    initTelegramBot,
    getTelegramBot,
    sendNotification,
    sendTradeNotification,
    sendErrorNotification,
    stopTelegramBot,
    isTradingPausedByTelegram,
};
