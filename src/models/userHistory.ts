import mongoose, { Schema, Document } from 'mongoose';

// ============================================================
// Per-user processed trade tracking (multi-user support)
// ============================================================
export interface IProcessedTrade extends Document {
    chatId: number; // Telegram user ID
    transactionHash: string;
    traderAddress: string;
    side: string;
    createdAt: Date;
}

const processedTradeSchema = new Schema<IProcessedTrade>({
    chatId: { type: Number, required: true, index: true },
    transactionHash: { type: String, required: true },
    traderAddress: { type: String, required: true },
    side: { type: String, required: false },
    createdAt: { type: Date, default: Date.now, expires: 172800 }, // TTL: auto-delete after 48h
});

// Compound unique index: each user processes each trade at most once
processedTradeSchema.index({ chatId: 1, transactionHash: 1 }, { unique: true });

export const ProcessedTrade = mongoose.model<IProcessedTrade>(
    'ProcessedTrade',
    processedTradeSchema,
    'processed_trades'
);

/**
 * Check if a trade has been processed for a specific user
 */
export const isTradeProcessedForUser = async (
    chatId: number,
    transactionHash: string
): Promise<boolean> => {
    const exists = await ProcessedTrade.exists({ chatId, transactionHash });
    return !!exists;
};

/**
 * Mark a trade as processed for a specific user
 */
export const markTradeProcessedForUser = async (
    chatId: number,
    transactionHash: string,
    traderAddress: string,
    side?: string
): Promise<void> => {
    try {
        await ProcessedTrade.create({ chatId, transactionHash, traderAddress, side });
    } catch (error: any) {
        // Ignore duplicate key errors (already processed)
        if (error.code !== 11000) throw error;
    }
};

/**
 * Get all unprocessed trade hashes for a user from a list of trades
 */
export const filterUnprocessedTrades = async (
    chatId: number,
    transactionHashes: string[]
): Promise<Set<string>> => {
    if (transactionHashes.length === 0) return new Set(transactionHashes);

    const processed = await ProcessedTrade.find({
        chatId,
        transactionHash: { $in: transactionHashes },
    }).select('transactionHash').lean();

    const processedSet = new Set(processed.map((p) => p.transactionHash));
    return new Set(transactionHashes.filter((h) => !processedSet.has(h)));
};

// ============================================================
// Existing position and activity schemas
// ============================================================

const positionSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    proxyWallet: { type: String, required: false },
    asset: { type: String, required: false },
    conditionId: { type: String, required: false },
    size: { type: Number, required: false },
    avgPrice: { type: Number, required: false },
    initialValue: { type: Number, required: false },
    currentValue: { type: Number, required: false },
    cashPnl: { type: Number, required: false },
    percentPnl: { type: Number, required: false },
    totalBought: { type: Number, required: false },
    realizedPnl: { type: Number, required: false },
    percentRealizedPnl: { type: Number, required: false },
    curPrice: { type: Number, required: false },
    redeemable: { type: Boolean, required: false },
    mergeable: { type: Boolean, required: false },
    title: { type: String, required: false },
    slug: { type: String, required: false },
    icon: { type: String, required: false },
    eventSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    oppositeOutcome: { type: String, required: false },
    oppositeAsset: { type: String, required: false },
    endDate: { type: String, required: false },
    negativeRisk: { type: Boolean, required: false },
});

const activitySchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        required: true,
        auto: true,
    },
    proxyWallet: { type: String, required: false },
    timestamp: { type: Number, required: false },
    conditionId: { type: String, required: false },
    type: { type: String, required: false },
    size: { type: Number, required: false },
    usdcSize: { type: Number, required: false },
    transactionHash: { type: String, required: false },
    price: { type: Number, required: false },
    asset: { type: String, required: false },
    side: { type: String, required: false },
    outcomeIndex: { type: Number, required: false },
    title: { type: String, required: false },
    slug: { type: String, required: false },
    icon: { type: String, required: false },
    eventSlug: { type: String, required: false },
    outcome: { type: String, required: false },
    name: { type: String, required: false },
    pseudonym: { type: String, required: false },
    bio: { type: String, required: false },
    profileImage: { type: String, required: false },
    profileImageOptimized: { type: String, required: false },
    bot: { type: Boolean, required: false },
    botExcutedTime: { type: Number, required: false },
    myBoughtSize: { type: Number, required: false }, // Tracks actual tokens we bought
});

const getUserPositionModel = (walletAddress: string) => {
    const collectionName = `user_positions_${walletAddress}`;
    // CRITICAL: Must check if model already exists before creating.
    // mongoose.model(name, schema) throws OverwriteModelError on repeated calls.
    // This function is called every loop iteration in the monitor and executor.
    return mongoose.models[collectionName]
        || mongoose.model(collectionName, positionSchema, collectionName);
};

const getUserActivityModel = (walletAddress: string) => {
    const collectionName = `user_activities_${walletAddress}`;
    // CRITICAL: Must check if model already exists before creating.
    return mongoose.models[collectionName]
        || mongoose.model(collectionName, activitySchema, collectionName);
};

export { getUserActivityModel, getUserPositionModel };
