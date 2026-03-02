import * as dotenv from 'dotenv';
import { CopyStrategy, CopyStrategyConfig, parseTieredMultipliers } from './copyStrategy';
dotenv.config();

/**
 * Validate Ethereum address format
 */
const isValidEthereumAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Validate required environment variables
 * Note: PROXY_WALLET, PRIVATE_KEY, and USER_ADDRESSES are now optional
 * as they can be managed per-user via Telegram bot
 */
const validateRequiredEnv = (): void => {
    // Core infrastructure requirements only
    const required = [
        'CLOB_HTTP_URL',
        'CLOB_WS_URL',
        'MONGO_URI',
        'RPC_URL',
        'USDC_CONTRACT_ADDRESS',
    ];

    // Telegram is required for the wallet management system
    const telegramRequired = ['TELEGRAM_BOT_TOKEN'];

    const missing: string[] = [];
    for (const key of required) {
        if (!process.env[key]) {
            missing.push(key);
        }
    }

    // Check Telegram if enabled or if no legacy wallet config
    const hasLegacyWallet = process.env.PROXY_WALLET && process.env.PRIVATE_KEY;
    if (!hasLegacyWallet) {
        for (const key of telegramRequired) {
            if (!process.env[key]) {
                missing.push(key);
            }
        }
    }

    if (missing.length > 0) {
        console.error('\n❌ Configuration Error: Missing required environment variables\n');
        console.error(`Missing variables: ${missing.join(', ')}\n`);
        console.error('🔧 Quick fix:');
        console.error('   1. Run the setup wizard: npm run setup');
        console.error('   2. Or manually create .env file with all required variables\n');
        console.error('📖 See docs/QUICK_START.md for detailed instructions\n');
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`
        );
    }

    // Info message about wallet management
    if (!hasLegacyWallet) {
        console.log('\n💡 Wallet Management Mode: Telegram');
        console.log('   Users will create wallets via /start command\n');
    }
};

/**
 * Validate Ethereum addresses (only if provided)
 */
const validateAddresses = (): void => {
    // PROXY_WALLET is now optional - validated only if provided
    if (process.env.PROXY_WALLET && process.env.PROXY_WALLET.length > 0 && !isValidEthereumAddress(process.env.PROXY_WALLET)) {
        console.error('\n❌ Invalid Wallet Address\n');
        console.error(`Your PROXY_WALLET: ${process.env.PROXY_WALLET}`);
        console.error('Expected format:    0x followed by 40 hexadecimal characters\n');
        console.error('Example: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0\n');
        console.error('💡 Tips:');
        console.error('   • Copy your wallet address from MetaMask');
        console.error('   • Make sure it starts with 0x');
        console.error('   • Should be exactly 42 characters long\n');
        throw new Error(
            `Invalid PROXY_WALLET address format: ${process.env.PROXY_WALLET}`
        );
    }

    if (
        process.env.USDC_CONTRACT_ADDRESS &&
        !isValidEthereumAddress(process.env.USDC_CONTRACT_ADDRESS)
    ) {
        console.error('\n❌ Invalid USDC Contract Address\n');
        console.error(`Current value: ${process.env.USDC_CONTRACT_ADDRESS}`);
        console.error('Default value: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174\n');
        console.error('⚠️  Unless you know what you\'re doing, use the default value!\n');
        throw new Error(
            `Invalid USDC_CONTRACT_ADDRESS format: ${process.env.USDC_CONTRACT_ADDRESS}`
        );
    }
};

/**
 * Validate numeric configuration values
 */
const validateNumericConfig = (): void => {
    const fetchInterval = parseInt(process.env.FETCH_INTERVAL || '1', 10);
    if (isNaN(fetchInterval) || fetchInterval <= 0) {
        throw new Error(
            `Invalid FETCH_INTERVAL: ${process.env.FETCH_INTERVAL}. Must be a positive integer.`
        );
    }

    const retryLimit = parseInt(process.env.RETRY_LIMIT || '3', 10);
    if (isNaN(retryLimit) || retryLimit < 1 || retryLimit > 10) {
        throw new Error(
            `Invalid RETRY_LIMIT: ${process.env.RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }

    const tooOldTimestamp = parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10);
    if (isNaN(tooOldTimestamp) || tooOldTimestamp < 1) {
        throw new Error(
            `Invalid TOO_OLD_TIMESTAMP: ${process.env.TOO_OLD_TIMESTAMP}. Must be a positive integer (hours).`
        );
    }

    const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
    if (isNaN(requestTimeout) || requestTimeout < 1000) {
        throw new Error(
            `Invalid REQUEST_TIMEOUT_MS: ${process.env.REQUEST_TIMEOUT_MS}. Must be at least 1000ms.`
        );
    }

    const networkRetryLimit = parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10);
    if (isNaN(networkRetryLimit) || networkRetryLimit < 1 || networkRetryLimit > 10) {
        throw new Error(
            `Invalid NETWORK_RETRY_LIMIT: ${process.env.NETWORK_RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }
};

/**
 * Validate URL formats
 */
const validateUrls = (): void => {
    if (process.env.CLOB_HTTP_URL && !process.env.CLOB_HTTP_URL.startsWith('http')) {
        console.error('\n❌ Invalid CLOB_HTTP_URL\n');
        console.error(`Current value: ${process.env.CLOB_HTTP_URL}`);
        console.error('Default value: https://clob.polymarket.com/\n');
        console.error('⚠️  Use the default value unless you have a specific reason to change it!\n');
        throw new Error(
            `Invalid CLOB_HTTP_URL: ${process.env.CLOB_HTTP_URL}. Must be a valid HTTP/HTTPS URL.`
        );
    }

    if (process.env.CLOB_WS_URL && !process.env.CLOB_WS_URL.startsWith('ws')) {
        console.error('\n❌ Invalid CLOB_WS_URL\n');
        console.error(`Current value: ${process.env.CLOB_WS_URL}`);
        console.error('Default value: wss://ws-subscriptions-clob.polymarket.com/ws\n');
        console.error('⚠️  Use the default value unless you have a specific reason to change it!\n');
        throw new Error(
            `Invalid CLOB_WS_URL: ${process.env.CLOB_WS_URL}. Must be a valid WebSocket URL (ws:// or wss://).`
        );
    }

    if (process.env.RPC_URL && !process.env.RPC_URL.startsWith('http')) {
        console.error('\n❌ Invalid RPC_URL\n');
        console.error(`Current value: ${process.env.RPC_URL}`);
        console.error('Must start with: http:// or https://\n');
        console.error('💡 Get a free RPC endpoint from:');
        console.error('   • Infura:  https://infura.io');
        console.error('   • Alchemy: https://www.alchemy.com');
        console.error('   • Ankr:    https://www.ankr.com\n');
        console.error('Example: https://polygon-mainnet.infura.io/v3/YOUR_PROJECT_ID\n');
        throw new Error(`Invalid RPC_URL: ${process.env.RPC_URL}. Must be a valid HTTP/HTTPS URL.`);
    }

    if (process.env.MONGO_URI && !process.env.MONGO_URI.startsWith('mongodb')) {
        console.error('\n❌ Invalid MONGO_URI\n');
        console.error(`Current value: ${process.env.MONGO_URI}`);
        console.error('Must start with: mongodb:// or mongodb+srv://\n');
        console.error('💡 Setup MongoDB Atlas (free):');
        console.error('   1. Visit https://www.mongodb.com/cloud/atlas/register');
        console.error('   2. Create a free cluster');
        console.error('   3. Create database user with password');
        console.error('   4. Whitelist IP: 0.0.0.0/0 (or your IP)');
        console.error('   5. Get connection string from "Connect" button\n');
        console.error('Example: mongodb+srv://username:password@cluster.mongodb.net/database\n');
        throw new Error(
            `Invalid MONGO_URI: ${process.env.MONGO_URI}. Must be a valid MongoDB connection string.`
        );
    }
};

// Run all validations
validateRequiredEnv();
validateAddresses();
validateNumericConfig();
validateUrls();

// Parse USER_ADDRESSES: supports both comma-separated string and JSON array
// Returns empty array if not provided (addresses managed per-user via Telegram)
const parseUserAddresses = (input: string | undefined): string[] => {
    if (!input || input.trim().length === 0) {
        return []; // Empty is valid - users manage their own traders via Telegram
    }
    const trimmed = input.trim();
    // Check if it's JSON array format
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                const addresses = parsed
                    .map((addr) => addr.toLowerCase().trim())
                    .filter((addr) => addr.length > 0);
                // Validate each address
                for (const addr of addresses) {
                    if (!isValidEthereumAddress(addr)) {
                        console.error('\n❌ Invalid Trader Address in USER_ADDRESSES\n');
                        console.error(`Invalid address: ${addr}`);
                        console.error('Expected format: 0x followed by 40 hexadecimal characters\n');
                        console.error('💡 Where to find trader addresses:');
                        console.error('   • Polymarket Leaderboard: https://polymarket.com/leaderboard');
                        console.error('   • Predictfolio: https://predictfolio.com\n');
                        console.error('Example: USER_ADDRESSES=\'0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b\'\n');
                        throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${addr}`);
                    }
                }
                return addresses;
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('Invalid Ethereum address')) {
                throw e;
            }
            throw new Error(
                `Invalid JSON format for USER_ADDRESSES: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
    // Otherwise treat as comma-separated
    const addresses = trimmed
        .split(',')
        .map((addr) => addr.toLowerCase().trim())
        .filter((addr) => addr.length > 0);
    // Validate each address
    for (const addr of addresses) {
        if (!isValidEthereumAddress(addr)) {
            console.error('\n❌ Invalid Trader Address in USER_ADDRESSES\n');
            console.error(`Invalid address: ${addr}`);
            console.error('Expected format: 0x followed by 40 hexadecimal characters\n');
            console.error('💡 Where to find trader addresses:');
            console.error('   • Polymarket Leaderboard: https://polymarket.com/leaderboard');
            console.error('   • Predictfolio: https://predictfolio.com\n');
            console.error('Example: USER_ADDRESSES=\'0x7c3db723f1d4d8cb9c550095203b686cb11e5c6b\'\n');
            throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${addr}`);
        }
    }
    return addresses;
};

// Parse copy strategy configuration
const parseCopyStrategy = (): CopyStrategyConfig => {
    // Support legacy COPY_PERCENTAGE + TRADE_MULTIPLIER for backward compatibility
    const hasLegacyConfig = process.env.COPY_PERCENTAGE && !process.env.COPY_STRATEGY;

    if (hasLegacyConfig) {
        console.warn(
            '⚠️  Using legacy COPY_PERCENTAGE configuration. Consider migrating to COPY_STRATEGY.'
        );
        const copyPercentage = parseFloat(process.env.COPY_PERCENTAGE || '10.0');
        const tradeMultiplier = parseFloat(process.env.TRADE_MULTIPLIER || '1.0');
        const effectivePercentage = copyPercentage * tradeMultiplier;

        const config: CopyStrategyConfig = {
            strategy: CopyStrategy.PERCENTAGE,
            copySize: effectivePercentage,
            maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
            minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
            maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
                ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
                : undefined,
            maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
                ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
                : undefined,
        };

        // Parse tiered multipliers if configured (even for legacy mode)
        if (process.env.TIERED_MULTIPLIERS) {
            try {
                config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
                console.log(`✓ Loaded ${config.tieredMultipliers.length} tiered multipliers`);
            } catch (error) {
                throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (tradeMultiplier !== 1.0) {
            // If using legacy single multiplier, store it
            config.tradeMultiplier = tradeMultiplier;
        }

        return config;
    }

    // Parse new copy strategy configuration
    const strategyStr = (process.env.COPY_STRATEGY || 'PERCENTAGE').toUpperCase();
    const strategy =
        CopyStrategy[strategyStr as keyof typeof CopyStrategy] || CopyStrategy.PERCENTAGE;

    const config: CopyStrategyConfig = {
        strategy,
        copySize: parseFloat(process.env.COPY_SIZE || '10.0'),
        maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
        minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
        maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
            ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
            : undefined,
        maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
            ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
            : undefined,
    };

    // Add adaptive strategy parameters if applicable
    if (strategy === CopyStrategy.ADAPTIVE) {
        config.adaptiveMinPercent = parseFloat(
            process.env.ADAPTIVE_MIN_PERCENT || config.copySize.toString()
        );
        config.adaptiveMaxPercent = parseFloat(
            process.env.ADAPTIVE_MAX_PERCENT || config.copySize.toString()
        );
        config.adaptiveThreshold = parseFloat(process.env.ADAPTIVE_THRESHOLD_USD || '500.0');
    }

    // Parse tiered multipliers if configured
    if (process.env.TIERED_MULTIPLIERS) {
        try {
            config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
            console.log(`✓ Loaded ${config.tieredMultipliers.length} tiered multipliers`);
        } catch (error) {
            throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else if (process.env.TRADE_MULTIPLIER) {
        // Fall back to single multiplier if no tiers configured
        const singleMultiplier = parseFloat(process.env.TRADE_MULTIPLIER);
        if (singleMultiplier !== 1.0) {
            config.tradeMultiplier = singleMultiplier;
            console.log(`✓ Using single trade multiplier: ${singleMultiplier}x`);
        }
    }

    return config;
};

// Validate Telegram token format if provided
const validateTelegramConfig = (): void => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const enabled = process.env.TELEGRAM_ENABLED === 'true';

    if (enabled && !token) {
        console.warn('\n⚠️  TELEGRAM_ENABLED is true but TELEGRAM_BOT_TOKEN is not set');
        console.warn('   Telegram bot will be disabled.\n');
        console.warn('💡 To enable Telegram notifications:');
        console.warn('   1. Create a bot via @BotFather on Telegram');
        console.warn('   2. Copy the bot token');
        console.warn('   3. Add to .env: TELEGRAM_BOT_TOKEN=your_token_here\n');
    }

    if (token && !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        console.warn('\n⚠️  TELEGRAM_BOT_TOKEN format looks invalid');
        console.warn('   Expected format: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz\n');
    }
};

// Run Telegram validation (non-blocking)
validateTelegramConfig();

export const ENV = {
    // Optional: Can be empty when using Telegram wallet management
    USER_ADDRESSES: parseUserAddresses(process.env.USER_ADDRESSES),
    PROXY_WALLET: process.env.PROXY_WALLET || '', // Optional - users create via Telegram
    PRIVATE_KEY: process.env.PRIVATE_KEY || '', // Optional - users create via Telegram
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL as string,
    CLOB_WS_URL: process.env.CLOB_WS_URL as string,
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    // Legacy parameters (kept for backward compatibility)
    TRADE_MULTIPLIER: parseFloat(process.env.TRADE_MULTIPLIER || '1.0'),
    COPY_PERCENTAGE: parseFloat(process.env.COPY_PERCENTAGE || '10.0'),
    // New copy strategy configuration
    COPY_STRATEGY_CONFIG: parseCopyStrategy(),
    // Network settings
    REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
    NETWORK_RETRY_LIMIT: parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10),
    // Trade aggregation settings
    TRADE_AGGREGATION_ENABLED: process.env.TRADE_AGGREGATION_ENABLED === 'true',
    TRADE_AGGREGATION_WINDOW_SECONDS: parseInt(
        process.env.TRADE_AGGREGATION_WINDOW_SECONDS || '300',
        10
    ), // 5 minutes default
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL: process.env.RPC_URL as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
    // Telegram bot settings - enabled by default when token is provided
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_ENABLED: process.env.TELEGRAM_ENABLED !== 'false' && !!process.env.TELEGRAM_BOT_TOKEN,
    // Watch only mode - monitor trades without executing
    WATCH_ONLY_MODE: process.env.WATCH_ONLY_MODE === 'true',
    // Auto-resolve settings
    AUTO_RESOLVE_ENABLED: process.env.AUTO_RESOLVE_ENABLED === 'true',
    AUTO_RESOLVE_INTERVAL_MINUTES: parseInt(process.env.AUTO_RESOLVE_INTERVAL_MINUTES || '60', 10),
    AUTO_RESOLVE_MIN_VALUE: parseFloat(process.env.AUTO_RESOLVE_MIN_VALUE || '1.0'),
    AUTO_RESOLVE_SELL_LOSSES: process.env.AUTO_RESOLVE_SELL_LOSSES === 'true',
    // Wallet encryption key for storing private keys
    WALLET_ENCRYPTION_KEY: process.env.WALLET_ENCRYPTION_KEY || '',
    // Builder API Keys (for relayer access & CLOB order attribution)
    BUILDER_API_KEY: process.env.BUILDER_API_KEY || '',
    BUILDER_API_SECRET: process.env.BUILDER_API_SECRET || '',
    BUILDER_API_PASSPHRASE: process.env.BUILDER_API_PASSPHRASE || '',
};
