import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { BluGlo } from "../bot.js";

type RawChatKind = "dm" | "party";
type SignedMessageType = "Persistent" | "Party";

interface FnbrSessionLike {
    accessToken?: string;
    token?: string;
}

interface RegisteredKeyData {
    jwt: string;
    [key: string]: unknown;
}

interface DMConversationResponse {
    conversationId: string;
    isReportable?: boolean;
}

interface RawChatCache {
    privateKey?: CryptoKeyLike;
    publicKeyBase64?: string;
    registeredKey?: RegisteredKeyData;
    dmConversationIds: Map<string, string>;
    dmReportable: Map<string, boolean>;
}

interface CryptoKeyLike {
    // Minimal shape for node:crypto sign()
}

const EOS_CHAT_BASE = "https://api.epicgames.dev";
const PUBLIC_KEY_BASE = "https://publickey-service-live.ecosec.on.epicgames.com";

const RAW_CHAT_CACHE_SYMBOL = Symbol.for("bluglo.rawChatCache");

/**
 * Returns or creates the per-client raw chat cache.
 */
function getRawChatCache(bot: BluGlo): RawChatCache {
    if (!bot.client) {
        throw new Error("Client is not initialized");
    }

    const target = bot.client as unknown as {
        [RAW_CHAT_CACHE_SYMBOL]?: RawChatCache;
    };

    const existing = target[RAW_CHAT_CACHE_SYMBOL];
    if (existing) return existing;

    const created: RawChatCache = {
        dmConversationIds: new Map(),
        dmReportable: new Map(),
    };

    target[RAW_CHAT_CACHE_SYMBOL] = created;
    return created;
}

/**
 * Small sleep helper for retries / pacing.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits long messages into smaller chunks.
 */
function chunkMessage(text: string, maxLength = 240): string[] {
    const clean = text.replace(/\r/g, "").trim();
    if (!clean) return [];

    const lines = clean.split("\n");
    const chunks: string[] = [];
    let current = "";

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) {
            if (current && !current.endsWith("\n")) current += "\n";
            continue;
        }

        if (trimmed.length > maxLength) {
            if (current) {
                chunks.push(current.trim());
                current = "";
            }

            const words = trimmed.split(" ");
            let partial = "";

            for (const word of words) {
                const test = partial ? `${partial} ${word}` : word;

                if (test.length <= maxLength) {
                    partial = test;
                } else {
                    if (partial) chunks.push(partial.trim());

                    if (word.length > maxLength) {
                        for (let i = 0; i < word.length; i += maxLength) {
                            chunks.push(word.slice(i, i + maxLength));
                        }
                        partial = "";
                    } else {
                        partial = word;
                    }
                }
            }

            if (partial) chunks.push(partial.trim());
            continue;
        }

        const test = current ? `${current}\n${trimmed}` : trimmed;

        if (test.length <= maxLength) {
            current = test;
        } else {
            if (current) chunks.push(current.trim());
            current = trimmed;
        }
    }

    if (current) chunks.push(current.trim());

    return chunks.filter(Boolean);
}

/**
 * Gets the logged-in account id from fnbr's client.
 */
function getSelfAccountId(bot: BluGlo): string {
    const selfId =
        (bot.client as any)?.user?.self?.id ??
        (bot.client as any)?.user?.id ??
        bot.accountId;

    if (!selfId) {
        throw new Error("Missing self account id");
    }

    return selfId;
}

/**
 * Gets the EOS deployment id from the logged-in fnbr client.
 */
function getDeploymentId(bot: BluGlo): string {
    const deploymentId = (bot.client as any)?.config?.eosDeploymentId;
    if (!deploymentId) {
        throw new Error("Missing EOS deployment id");
    }
    return deploymentId;
}

/**
 * Extracts a token from fnbr auth sessions.
 *
 * fnbr internally stores sessions by keys like "fortnite" and "fortniteEOS".
 * We reuse those sessions instead of logging in again.
 */
function getSessionAccessToken(bot: BluGlo, key: "fortnite" | "fortniteEOS"): string {
    const sessions = (bot.client as any)?.auth?.sessions as Map<string, FnbrSessionLike> | undefined;
    const session = sessions?.get(key);

    const token = session?.accessToken ?? session?.token;
    if (!token) {
        throw new Error(`Missing access token for session "${key}"`);
    }

    return token;
}

/**
 * Generates and stores an ed25519 keypair in memory.
 */
function ensureKeypair(bot: BluGlo): void {
    const cache = getRawChatCache(bot);
    if (cache.privateKey && cache.publicKeyBase64) return;

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const rawPublicKey = spkiDer.subarray(spkiDer.length - 32);

    cache.privateKey = privateKey as unknown as CryptoKeyLike;
    cache.publicKeyBase64 = rawPublicKey.toString("base64");
}

/**
 * Registers the public key on Epic's public key service if needed.
 */
async function ensureRegisteredPublicKey(bot: BluGlo): Promise<RegisteredKeyData> {
    const cache = getRawChatCache(bot);
    if (cache.registeredKey?.jwt) {
        return cache.registeredKey;
    }

    ensureKeypair(bot);

    const fortniteToken = getSessionAccessToken(bot, "fortnite");

    const response = await fetch(`${PUBLIC_KEY_BASE}/publickey/v2/publickey/`, {
        method: "POST",
        headers: {
            Authorization: `bearer ${fortniteToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            key: cache.publicKeyBase64,
            algorithm: "ed25519",
        }),
    });

    if (!response.ok) {
        throw new Error(`Public key registration failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as RegisteredKeyData;
    if (!json?.jwt) {
        throw new Error("Public key registration succeeded but jwt is missing");
    }

    cache.registeredKey = json;
    return json;
}

/**
 * Creates a signed EOS chat body exactly in the style used by rebootpy/fnbr:
 * body = base64(JSON(messageInfo))
 * signature = ed25519-sign(body + \\0)
 */
async function createSignedMessage(
    bot: BluGlo,
    conversationId: string,
    content: string,
    kind: RawChatKind,
): Promise<{ body: string; signature: string }> {
    ensureKeypair(bot);

    const selfId = getSelfAccountId(bot);
    const cache = getRawChatCache(bot);

    const messageInfo = {
        mid: randomUUID(),
        sid: selfId,
        rid: conversationId,
        msg: content,
        tst: Date.now(),
        seq: 1,
        rec: false,
        mts: [],
        cty: (kind === "party" ? "Party" : "Persistent") as SignedMessageType,
    };

    const body = Buffer.from(JSON.stringify(messageInfo), "utf8").toString("base64");
    const messageToSign = Buffer.concat([Buffer.from(body, "utf8"), Buffer.from([0])]);

    const signature = sign(null, messageToSign, cache.privateKey as any).toString("base64");

    return { body, signature };
}

/**
 * Creates or reuses a DM conversation id for a target user.
 */
async function getOrCreateDMConversation(
    bot: BluGlo,
    targetAccountId: string,
): Promise<{ conversationId: string; isReportable: boolean }> {
    const cache = getRawChatCache(bot);

    const cachedConversationId = cache.dmConversationIds.get(targetAccountId);
    const cachedReportable = cache.dmReportable.get(targetAccountId);

    if (cachedConversationId && typeof cachedReportable === "boolean") {
        return {
            conversationId: cachedConversationId,
            isReportable: cachedReportable,
        };
    }

    const selfId = getSelfAccountId(bot);
    const eosToken = getSessionAccessToken(bot, "fortniteEOS");

    const response = await fetch(
        `${EOS_CHAT_BASE}/epic/chat/v1/public/_/conversations?createIfExists=false`,
        {
            method: "POST",
            headers: {
                Authorization: `bearer ${eosToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                title: "",
                type: "dm",
                members: [selfId, targetAccountId],
            }),
        },
    );

    if (!response.ok) {
        throw new Error(`DM conversation lookup failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as DMConversationResponse;

    if (!json?.conversationId) {
        throw new Error("DM conversation response missing conversationId");
    }

    const isReportable = Boolean(json.isReportable);

    cache.dmConversationIds.set(targetAccountId, json.conversationId);
    cache.dmReportable.set(targetAccountId, isReportable);

    return {
        conversationId: json.conversationId,
        isReportable,
    };
}

/**
 * Low-level EOS chat sender.
 */
async function postChatMessage(
    bot: BluGlo,
    args: {
        conversationId: string;
        kind: RawChatKind;
        text: string;
        allowedRecipients: string[];
        isReportable: boolean;
    },
): Promise<void> {
    const eosToken = getSessionAccessToken(bot, "fortniteEOS");
    const selfId = getSelfAccountId(bot);
    const deploymentId = getDeploymentId(bot);
    const keyData = await ensureRegisteredPublicKey(bot);
    const { body, signature } = await createSignedMessage(
        bot,
        args.conversationId,
        args.text,
        args.kind,
    );

    const namespace = args.kind === "dm" ? "_" : deploymentId;
    const url = `${EOS_CHAT_BASE}/epic/chat/v1/public/${namespace}/conversations/${args.conversationId}/messages?fromAccountId=${selfId}`;

    const platform = (bot.client as any)?.config?.platform ?? "WIN";

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `bearer ${eosToken}`,
            "Content-Type": "application/json",
            "X-Epic-Correlation-ID": `EOS-${Date.now()}-${randomUUID()}`,
        },
        body: JSON.stringify({
            allowedRecipients: args.allowedRecipients,
            message: { body },
            isReportable: args.isReportable,
            metadata: {
                TmV: "2",
                Pub: keyData.jwt,
                Sig: signature,
                NPM: args.kind === "party" ? "1" : undefined,
                PlfNm: platform,
                PlfId: selfId,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Chat send failed: ${response.status} ${await response.text()}`);
    }
}

/**
 * Sends a whisper/DM using pure HTTP requests, but reusing fnbr's live auth sessions.
 */
export async function sendWhisperRaw(
    bot: BluGlo,
    targetAccountId: string,
    text: string,
    options?: {
        delayMs?: number;
        chunkLength?: number;
        betweenChunksMs?: number;
    },
): Promise<boolean> {
    try {
        if (!targetAccountId) {
            return false;
        }

        if (targetAccountId === getSelfAccountId(bot)) {
            return false;
        }

        if (options?.delayMs) {
            await sleep(options.delayMs);
        }

        const chunks = chunkMessage(text, options?.chunkLength ?? 240);
        if (chunks.length === 0) {
            return false;
        }

        const selfId = getSelfAccountId(bot);
        const dm = await getOrCreateDMConversation(bot, targetAccountId);

        for (let i = 0; i < chunks.length; i++) {
            await postChatMessage(bot, {
                conversationId: dm.conversationId,
                kind: "dm",
                text: chunks[i]!,
                allowedRecipients: [targetAccountId, selfId],
                isReportable: dm.isReportable,
            });

            if (i < chunks.length - 1 && (options?.betweenChunksMs ?? 500) > 0) {
                await sleep(options?.betweenChunksMs ?? 500);
            }
        }

        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Sends a party chat message using pure HTTP requests, but reusing fnbr's live auth sessions.
 */
export async function sendPartyMessageRaw(
    bot: BluGlo,
    text: string,
    options?: {
        delayMs?: number;
        chunkLength?: number;
        betweenChunksMs?: number;
    },
): Promise<boolean> {
    try {
        if (options?.delayMs) {
            await sleep(options.delayMs);
        }

        const party = bot.client?.party;
        if (!party?.id) {
            return false;
        }

        const members = [...(party.members ?? [])];
        const selfId = getSelfAccountId(bot);

        const recipients = members
            .map((member: any) => member.id)
            .filter((id: string) => id && id !== selfId);

        if (recipients.length === 0) {
            return false;
        }

        const chunks = chunkMessage(text, options?.chunkLength ?? 240);
        if (chunks.length === 0) {
            return false;
        }

        const conversationId = `p-${party.id}`;

        for (let i = 0; i < chunks.length; i++) {
            await postChatMessage(bot, {
                conversationId,
                kind: "party",
                text: chunks[i]!,
                allowedRecipients: recipients,
                isReportable: false,
            });

            if (i < chunks.length - 1 && (options?.betweenChunksMs ?? 450) > 0) {
                await sleep(options?.betweenChunksMs ?? 450);
            }
        }

        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Convenience helper.
 */
export async function sendRawChat(
    bot: BluGlo,
    payload:
        | {
            type: "party";
            text: string;
            delayMs?: number;
            chunkLength?: number;
            betweenChunksMs?: number;
        }
        | {
            type: "whisper";
            userId: string;
            text: string;
            delayMs?: number;
            chunkLength?: number;
            betweenChunksMs?: number;
        },
): Promise<boolean> {
    if (payload.type === "party") {
        return sendPartyMessageRaw(bot, payload.text, {
            delayMs: payload.delayMs,
            chunkLength: payload.chunkLength,
            betweenChunksMs: payload.betweenChunksMs,
        });
    }

    return sendWhisperRaw(bot, payload.userId, payload.text, {
        delayMs: payload.delayMs,
        chunkLength: payload.chunkLength,
        betweenChunksMs: payload.betweenChunksMs,
    });
}