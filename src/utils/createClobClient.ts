import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        // Using ethers v5 syntax
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const code = await provider.getCode(address);
        // If code is not "0x", then it's a contract (likely Gnosis Safe)
        return code !== '0x';
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

const createClobClient = async (privateKey?: string, proxyWallet?: string): Promise<ClobClient | undefined> => {
    // Use provided credentials or fall back to ENV
    const actualPrivateKey = privateKey || PRIVATE_KEY;
    const actualProxyWallet = proxyWallet || PROXY_WALLET;

    // Return undefined if no credentials are provided (Telegram mode with no wallet yet)
    if (!actualPrivateKey || actualPrivateKey.length === 0) {
        Logger.warning('No private key provided - CLOB client not initialized');
        return undefined;
    }

    if (!actualProxyWallet || actualProxyWallet.length === 0) {
        Logger.warning('No proxy wallet provided - CLOB client not initialized');
        return undefined;
    }

    const chainId = 137;
    const host = CLOB_HTTP_URL as string;
    const wallet = new ethers.Wallet(actualPrivateKey as string);

    // Detect if the proxy wallet is a Gnosis Safe or EOA
    const isProxySafe = await isGnosisSafe(actualProxyWallet as string);
    const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;

    Logger.info(
        `Wallet type detected: ${isProxySafe ? 'Gnosis Safe' : 'EOA (Externally Owned Account)'}`
    );

    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        signatureType,
        isProxySafe ? (actualProxyWallet as string) : undefined
    );

    // Suppress console output during API key creation
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    let creds = await clobClient.createApiKey();
    if (!creds.key) {
        creds = await clobClient.deriveApiKey();
    }

    // Build BuilderConfig if Builder API keys are provided (for relayer access & order attribution)
    let builderConfig: BuilderConfig | undefined;
    const builderKey = ENV.BUILDER_API_KEY;
    const builderSecret = ENV.BUILDER_API_SECRET;
    const builderPassphrase = ENV.BUILDER_API_PASSPHRASE;

    if (builderKey && builderSecret && builderPassphrase) {
        builderConfig = new BuilderConfig({
            localBuilderCreds: {
                key: builderKey,
                secret: builderSecret,
                passphrase: builderPassphrase,
            },
        });
        Logger.info('Builder API keys configured for CLOB order attribution');
    }

    clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        creds,
        signatureType,
        isProxySafe ? (actualProxyWallet as string) : undefined,
        undefined, // geoBlockToken
        undefined, // useServerTime
        builderConfig
    );

    // Restore console functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

export default createClobClient;
