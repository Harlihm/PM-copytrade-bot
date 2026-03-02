import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import { initTelegramBot, stopTelegramBot, sendNotification } from './services/telegramBot';
import { initAutoResolver, stopAutoResolver } from './services/autoResolver';
import userRegistry from './services/userRegistry';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();
        stopAutoResolver();
        stopTelegramBot();
        userRegistry.stop();

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
        };

        console.log(`\n${colors.yellow}💡 Multi-user Telegram Copy Trading Bot${colors.reset}`);
        console.log(`   Users create wallets and add traders via Telegram.`);
        console.log(`   Run health check: ${colors.cyan}npm run health-check${colors.reset}\n`);

        // Connect to MongoDB
        await connectDB();

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        // Initialize User Registry (loads users + tracked traders from DB)
        Logger.info('Initializing User Registry...');
        await userRegistry.init();

        const userCount = userRegistry.getUserCount();
        const traderCount = userRegistry.getTraderCount();
        Logger.success(
            `User Registry ready: ${userCount} active user(s), ${traderCount} unique trader(s)`
        );

        // Initialize Telegram bot (this is how users interact)
        if (ENV.TELEGRAM_ENABLED) {
            Logger.info('Initializing Telegram bot...');
            const telegramBot = initTelegramBot();
            if (telegramBot) {
                Logger.success('Telegram bot ready - send /start to your bot');
                sendNotification(
                    '🚀 *Bot Started*\n\nPolymarket copy trading bot is now running.\n\nUse /addtrader to start copying a trader.'
                ).catch(() => {});
            }
        } else {
            Logger.warning('Telegram bot disabled (set TELEGRAM_ENABLED=true to enable)');
        }

        Logger.separator();

        // Start trade monitor (fetches data for all tracked traders)
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        // Start trade executor (multi-user: processes trades per user)
        Logger.info('Starting trade executor...');
        tradeExecutor();

        // Initialize auto-resolver
        initAutoResolver(undefined);

    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
