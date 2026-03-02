/**
 * User Wallet Model
 *
 * Stores wallet information and tracked traders for Telegram users.
 * Each user can have multiple wallets and track multiple traders.
 */

import mongoose, { Schema, Document } from 'mongoose';
import { ethers } from 'ethers';

// Tracked trader interface
export interface ITrackedTrader {
    address: string;
    addedAt: Date;
}

// Wallet interface
export interface IWallet {
    address: string;
    encryptedPrivateKey: string; // Encrypted for security
    name: string;
    isActive: boolean;
    createdAt: Date;
}

// User document interface
export interface IUserWallet extends Document {
    telegramChatId: number;
    telegramUsername?: string;
    wallets: IWallet[];
    trackedTraders: ITrackedTrader[];
    watchOnlyMode: boolean;
    createdAt: Date;
    updatedAt: Date;
}

// Tracked trader sub-schema
const trackedTraderSchema = new Schema<ITrackedTrader>({
    address: { type: String, required: true },
    addedAt: { type: Date, default: Date.now },
});

// Wallet sub-schema
const walletSchema = new Schema<IWallet>({
    address: { type: String, required: true },
    encryptedPrivateKey: { type: String, required: true },
    name: { type: String, default: 'Main Wallet' },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
});

// User wallet schema
const userWalletSchema = new Schema<IUserWallet>(
    {
        telegramChatId: { type: Number, required: true, unique: true, index: true },
        telegramUsername: { type: String, required: false },
        wallets: [walletSchema],
        trackedTraders: { type: [trackedTraderSchema], default: [] },
        watchOnlyMode: { type: Boolean, default: false },
    },
    {
        timestamps: true,
    }
);

// Simple encryption key (in production, use a proper secret management)
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || 'polymarket-bot-default-key-change-me';

/**
 * Simple encryption for private keys (XOR-based with base64)
 * Note: For production, use a proper encryption library like crypto-js or node's crypto
 */
const encryptPrivateKey = (privateKey: string): string => {
    const keyBuffer = Buffer.from(ENCRYPTION_KEY);
    const dataBuffer = Buffer.from(privateKey);
    const encrypted = Buffer.alloc(dataBuffer.length);

    for (let i = 0; i < dataBuffer.length; i++) {
        encrypted[i] = dataBuffer[i] ^ keyBuffer[i % keyBuffer.length];
    }

    return encrypted.toString('base64');
};

/**
 * Decrypt private key
 */
const decryptPrivateKey = (encryptedKey: string): string => {
    const keyBuffer = Buffer.from(ENCRYPTION_KEY);
    const dataBuffer = Buffer.from(encryptedKey, 'base64');
    const decrypted = Buffer.alloc(dataBuffer.length);

    for (let i = 0; i < dataBuffer.length; i++) {
        decrypted[i] = dataBuffer[i] ^ keyBuffer[i % keyBuffer.length];
    }

    return decrypted.toString();
};

// Create the model
const UserWallet = mongoose.model<IUserWallet>('UserWallet', userWalletSchema);

/**
 * Generate a new Ethereum wallet
 */
export const generateWallet = (): { address: string; privateKey: string } => {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privateKey: wallet.privateKey,
    };
};

/**
 * Get user by Telegram chat ID
 */
export const getUserByChatId = async (chatId: number): Promise<IUserWallet | null> => {
    return await UserWallet.findOne({ telegramChatId: chatId });
};

/**
 * Create a new user with a wallet
 */
export const createUserWithWallet = async (
    chatId: number,
    username?: string
): Promise<{ user: IUserWallet; wallet: { address: string; privateKey: string } }> => {
    // Generate new wallet
    const newWallet = generateWallet();

    // Create user with encrypted private key
    const user = new UserWallet({
        telegramChatId: chatId,
        telegramUsername: username,
        wallets: [
            {
                address: newWallet.address,
                encryptedPrivateKey: encryptPrivateKey(newWallet.privateKey),
                name: 'Main Wallet',
                isActive: true,
            },
        ],
        trackedTraders: [],
        watchOnlyMode: false,
    });

    await user.save();

    return {
        user,
        wallet: newWallet,
    };
};

/**
 * Add a new wallet to existing user
 */
export const addWalletToUser = async (
    chatId: number,
    walletName: string = 'Wallet'
): Promise<{ address: string; privateKey: string } | null> => {
    const user = await getUserByChatId(chatId);
    if (!user) return null;

    const newWallet = generateWallet();
    const walletCount = user.wallets.length + 1;

    user.wallets.push({
        address: newWallet.address,
        encryptedPrivateKey: encryptPrivateKey(newWallet.privateKey),
        name: walletName || `Wallet ${walletCount}`,
        isActive: true,
        createdAt: new Date(),
    });

    await user.save();

    return newWallet;
};

/**
 * Import an existing wallet
 */
export const importWalletToUser = async (
    chatId: number,
    privateKey: string,
    walletName: string = 'Imported Wallet'
): Promise<{ success: boolean; address?: string; error?: string }> => {
    try {
        const user = await getUserByChatId(chatId);
        if (!user) return { success: false, error: 'User not found' };

        // Validate private key by creating wallet from it
        const wallet = new ethers.Wallet(privateKey);

        // Check if wallet already exists
        const exists = user.wallets.some(
            (w) => w.address.toLowerCase() === wallet.address.toLowerCase()
        );
        if (exists) {
            return { success: false, error: 'Wallet already exists' };
        }

        user.wallets.push({
            address: wallet.address,
            encryptedPrivateKey: encryptPrivateKey(privateKey),
            name: walletName,
            isActive: true,
            createdAt: new Date(),
        });

        await user.save();

        return { success: true, address: wallet.address };
    } catch (error: any) {
        return { success: false, error: error.message || 'Invalid private key' };
    }
};

/**
 * Get all wallets for a user (with decrypted private keys)
 */
export const getUserWallets = async (
    chatId: number
): Promise<Array<{ address: string; privateKey: string; name: string; isActive: boolean }>> => {
    const user = await getUserByChatId(chatId);
    if (!user) return [];

    return user.wallets.map((w) => ({
        address: w.address,
        privateKey: decryptPrivateKey(w.encryptedPrivateKey),
        name: w.name,
        isActive: w.isActive,
    }));
};

/**
 * Get active wallet for a user
 */
export const getActiveWallet = async (
    chatId: number
): Promise<{ address: string; privateKey: string; name: string } | null> => {
    const user = await getUserByChatId(chatId);
    if (!user || user.wallets.length === 0) return null;

    const activeWallet = user.wallets.find((w) => w.isActive) || user.wallets[0];

    return {
        address: activeWallet.address,
        privateKey: decryptPrivateKey(activeWallet.encryptedPrivateKey),
        name: activeWallet.name,
    };
};

/**
 * Set active wallet by address
 */
export const setActiveWallet = async (
    chatId: number,
    walletAddress: string
): Promise<boolean> => {
    const user = await getUserByChatId(chatId);
    if (!user) return false;

    // Set all wallets inactive, then activate the specified one
    let found = false;
    user.wallets.forEach((w) => {
        if (w.address.toLowerCase() === walletAddress.toLowerCase()) {
            w.isActive = true;
            found = true;
        } else {
            w.isActive = false;
        }
    });

    if (found) {
        await user.save();
    }

    return found;
};

/**
 * Remove a wallet from user
 */
export const removeWallet = async (
    chatId: number,
    walletAddress: string
): Promise<boolean> => {
    const user = await getUserByChatId(chatId);
    if (!user) return false;

    const initialLength = user.wallets.length;
    user.wallets = user.wallets.filter(
        (w) => w.address.toLowerCase() !== walletAddress.toLowerCase()
    ) as mongoose.Types.DocumentArray<IWallet>;

    if (user.wallets.length < initialLength) {
        // If we removed the active wallet, set the first one as active
        if (user.wallets.length > 0 && !user.wallets.some((w) => w.isActive)) {
            user.wallets[0].isActive = true;
        }
        await user.save();
        return true;
    }

    return false;
};

/**
 * Rename a wallet
 */
export const renameWallet = async (
    chatId: number,
    walletAddress: string,
    newName: string
): Promise<boolean> => {
    const user = await getUserByChatId(chatId);
    if (!user) return false;

    const wallet = user.wallets.find(
        (w) => w.address.toLowerCase() === walletAddress.toLowerCase()
    );

    if (wallet) {
        wallet.name = newName;
        await user.save();
        return true;
    }

    return false;
};

// ============================================================
// Tracked Trader Management
// ============================================================

/**
 * Add a trader address for a user to copy
 */
export const addTrackedTrader = async (
    chatId: number,
    traderAddress: string
): Promise<{ success: boolean; error?: string }> => {
    const user = await getUserByChatId(chatId);
    if (!user) return { success: false, error: 'User not found. Run /start first.' };

    const normalized = traderAddress.toLowerCase().trim();

    // Validate Ethereum address
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
        return { success: false, error: 'Invalid Ethereum address format.' };
    }

    // Check if already tracking
    const alreadyTracking = user.trackedTraders.some(
        (t) => t.address.toLowerCase() === normalized
    );
    if (alreadyTracking) {
        return { success: false, error: 'Already tracking this trader.' };
    }

    user.trackedTraders.push({
        address: normalized,
        addedAt: new Date(),
    });

    await user.save();
    return { success: true };
};

/**
 * Remove a tracked trader for a user
 */
export const removeTrackedTrader = async (
    chatId: number,
    traderAddress: string
): Promise<boolean> => {
    const user = await getUserByChatId(chatId);
    if (!user) return false;

    const normalized = traderAddress.toLowerCase().trim();
    const initialLength = user.trackedTraders.length;

    user.trackedTraders = user.trackedTraders.filter(
        (t) => t.address.toLowerCase() !== normalized
    ) as mongoose.Types.DocumentArray<ITrackedTrader>;

    if (user.trackedTraders.length < initialLength) {
        await user.save();
        return true;
    }

    return false;
};

/**
 * Get tracked traders for a specific user
 */
export const getTrackedTraders = async (chatId: number): Promise<ITrackedTrader[]> => {
    const user = await getUserByChatId(chatId);
    if (!user) return [];
    return user.trackedTraders;
};

/**
 * Get ALL users that have an active wallet and at least one tracked trader.
 * Used by the trading pipeline to know which users to process.
 */
export const getAllActiveUsers = async (): Promise<IUserWallet[]> => {
    return await UserWallet.find({
        'wallets.0': { $exists: true }, // Has at least one wallet
        'trackedTraders.0': { $exists: true }, // Has at least one tracked trader
    });
};

/**
 * Get all unique trader addresses across all users
 */
export const getAllUniqueTrackedTraders = async (): Promise<string[]> => {
    const users = await getAllActiveUsers();
    const traderSet = new Set<string>();
    for (const user of users) {
        for (const trader of user.trackedTraders) {
            traderSet.add(trader.address.toLowerCase());
        }
    }
    return Array.from(traderSet);
};

/**
 * Set watch-only mode for a user
 */
export const setUserWatchOnlyMode = async (
    chatId: number,
    enabled: boolean
): Promise<boolean> => {
    const user = await getUserByChatId(chatId);
    if (!user) return false;
    user.watchOnlyMode = enabled;
    await user.save();
    return true;
};

/**
 * Decrypt a private key (exported for use by UserRegistry)
 */
export const decryptKey = decryptPrivateKey;

export default UserWallet;
