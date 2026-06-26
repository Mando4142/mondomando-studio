require('dotenv').config();
const express = require('express');
const http = require('http');
const app = express();
const path = require('path');
const fs = require('fs');
let WebSocket = null;
try { WebSocket = require('ws'); } catch (err) { console.log('[MMR] Paket ws fehlt. Bitte npm install ausführen, damit TikFinity verbunden wird.'); }
const Stripe = require('stripe');
const PORT = process.env.PORT || 3000;
const TIKFINITY_WS_URL = process.env.TIKFINITY_WS_URL || 'ws://localhost:21213/';
const TIKFINITY_EVENT_API_ENABLED = String(process.env.TIKFINITY_EVENT_API_ENABLED || 'true').toLowerCase() !== 'false';
const MMR_BRIDGE_SECRET = process.env.MMR_BRIDGE_SECRET || 'mondo-mando-bridge';
const MMR_BRIDGE_PATH = process.env.MMR_BRIDGE_PATH || '/mmr-bridge';
const MMR_REMOTE_BRIDGE_URL = process.env.MMR_REMOTE_BRIDGE_URL || '';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const STRIPE_PRICE_IDS = {
    priority_boost: process.env.STRIPE_PRICE_PRIORITY_BOOST || 'price_1Tlc7pDROsW7ADLLN8z4ktIx',
    after_hours: process.env.STRIPE_PRICE_AFTER_HOURS || 'price_1Tlc7xDROsW7ADLLF06uyho7',
    song_dice: process.env.STRIPE_PRICE_SONG_DICE || 'price_1Tlc8KDROsW7ADLL8JjKlnW7'
};

const MAX_EXTRAS_PER_BUYER = 2;
const PENDING_BONUS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// Stripe braucht den rohen Body für die Webhook-Signatur. Diese Route muss VOR express.json stehen.
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    let event;

    try {
        if (STRIPE_WEBHOOK_SECRET && req.headers['stripe-signature'] && stripe) {
            event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
        } else {
            event = JSON.parse(req.body.toString('utf8'));
        }
    } catch (err) {
        console.error('[STRIPE] Webhook Fehler:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        applyStripeBonus(session);
    }

    res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname), {
    setHeaders: (res, filePath) => {
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        }
    }
}));

const DB_FILE = path.join(__dirname, 'database.json');
let dbData = {
    songQueue: [],
    extraTimeMinutes: 0,
    votingPhase: 'inactive', 
    votes: {},
    usedCodes: {},
    tiedSongs: [],
    hallOfFame: [],
    historicalHits: {}, 
    systemOnline: true,
    extensionActive: false,
    votingEndsAt: null,
    bonusUsage: {},
    buyerBonusUsage: {},
    afterHoursPasses: {},
    processedStripeSessions: {},
    bonusAnnouncements: [],
    viewerVoteCodes: {},
    viewerDeviceCodes: {},
    mmrSupporters: {},
    mmrEvents: [],
    mmrRedemptions: []
};

let votingTimeout = null;

function generateVoteCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createUniqueVotingCode() {
    let code = generateVoteCode();
    let safety = 0;
    while (
        safety < 60 &&
        (
            (dbData.viewerVoteCodes && dbData.viewerVoteCodes[code]) ||
            dbData.songQueue.some(song => song.voteCode === code)
        )
    ) {
        code = generateVoteCode();
        safety++;
    }
    return code;
}

function getViewerCodeStats() {
    const codes = Object.values(dbData.viewerVoteCodes || {});
    const used = codes.filter(c => c.used).length;
    return {
        total: codes.length,
        used,
        open: Math.max(0, codes.length - used)
    };
}

if (fs.existsSync(DB_FILE)) {
    try { 
        const loadedData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        dbData = { ...dbData, ...loadedData };
        if (!dbData.historicalHits) dbData.historicalHits = {}; 
        if (!dbData.usedCodes) dbData.usedCodes = {};
        if (!dbData.votingPhase) dbData.votingPhase = 'inactive';
        if (!dbData.bonusUsage) dbData.bonusUsage = {};
        if (!dbData.buyerBonusUsage) dbData.buyerBonusUsage = {};
        if (!dbData.afterHoursPasses) dbData.afterHoursPasses = {};
        if (!dbData.processedStripeSessions) dbData.processedStripeSessions = {};
        if (!dbData.bonusAnnouncements) dbData.bonusAnnouncements = [];
        if (!dbData.viewerVoteCodes) dbData.viewerVoteCodes = {};
        if (!dbData.viewerDeviceCodes) dbData.viewerDeviceCodes = {};
        if (!dbData.mmrSupporters) dbData.mmrSupporters = {};
        if (!dbData.mmrEvents) dbData.mmrEvents = [];
        if (!dbData.mmrRedemptions) dbData.mmrRedemptions = [];
        
        dbData.songQueue = dbData.songQueue.map(song => {
            if (!song.id) song.id = "S-" + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
            if (!song.voteCode) song.voteCode = generateVoteCode();
            if (song.isDice === undefined) song.isDice = false;
            if (song.isBoosted === undefined) song.isBoosted = false;
            if (song.isAfterHours === undefined) song.isAfterHours = false;
            if (song.bonusNotes === undefined) song.bonusNotes = [];
            if (song.priorityBoostBuyerEmail === undefined) song.priorityBoostBuyerEmail = null;
            if (song.afterHoursBuyerEmail === undefined) song.afterHoursBuyerEmail = null;
            if (song.diceBuyerEmail === undefined) song.diceBuyerEmail = null;
            return song;
        });
    } catch (e) { console.log("DB initialisiert."); }
}

function saveToDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
}

const BASE_LIMIT_MINUTES = 90;
const EXTENSION_LIMIT_MINUTES = 30;
const FEEDBACK_BUFFER_SECONDS = 120;
const ADMIN_PASSWORD = "Sutter1998!";

function getTotalTimeSeconds() {
    let total = 0;
    dbData.songQueue.forEach(song => {
        total += (parseInt(song.duration) || 0) + FEEDBACK_BUFFER_SECONDS;
    });
    return total;
}

function checkAdminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader === ADMIN_PASSWORD) next(); else res.status(401).json({ error: "Unbefugter Zugriff!" });
}

// ==========================================
// MMR POINTS / TIKFINITY SUPPORTER CLUB
// ==========================================
const MMR_RULES = {
    follow: 10,
    share: 5,
    likeBlock: 30,         // pro 1000 Likes/Taps
    likeBlockSize: 1000,
    chat: 1,               // maximal alle 5 Minuten pro User
    chatCooldownMs: 5 * 60 * 1000,
    subscribe: 50,         // einmaliger VIP-Bonus
    giftPointPerCoin: 1,
    subscriberMultiplier: 1.20
};

const MMR_REWARDS = {
    shoutout: { label: '📣 Shoutout im Stream', cost: 150 },
    extra_vote: { label: '🗳️ Extra Stimme', cost: 400 },
    song_dice: { label: '🎲 Songwürfel', cost: 750 },
    supporter_wall: { label: '🌍 Supporter-Wall', cost: 1200 },
    vip: { label: '👑 VIP Supporter des Monats', cost: 2500 },
    after_hours: { label: '🌙 After Hours Pass', cost: 3500 },
    legend: { label: '🏆 Mondo Legende', cost: 5000 },
    priority_boost: { label: '🚀 Song auf Platz 1 pushen', cost: 10000 }
};

let tikfinityStatus = {
    enabled: TIKFINITY_EVENT_API_ENABLED,
    connected: false,
    bridgeConnected: false,
    bridgeMode: MMR_REMOTE_BRIDGE_URL ? 'local-forwarder' : 'render-receiver',
    url: TIKFINITY_WS_URL,
    remoteBridgeUrl: MMR_REMOTE_BRIDGE_URL || null,
    bridgePath: MMR_BRIDGE_PATH,
    lastEvent: null,
    lastError: null,
    bridgeLastEvent: null,
    reconnects: 0
};

let mmrRemoteBridgeSocket = null;
let mmrBridgeClients = new Set();

function normalizeMmrUser(value) {
    return String(value || '').trim().replace(/^@+/, '').toLowerCase().slice(0, 80);
}

function getMmrUsername(data) {
    return String(
        data?.uniqueId ||
        data?.user?.uniqueId ||
        data?.userId ||
        data?.username ||
        data?.nickname ||
        data?.user?.nickname ||
        data?.displayName ||
        ''
    ).trim().replace(/^@+/, '').slice(0, 80);
}

function getMmrDisplayName(data, fallback) {
    return String(
        data?.nickname ||
        data?.user?.nickname ||
        data?.displayName ||
        data?.uniqueId ||
        fallback ||
        'Unbekannt'
    ).trim().slice(0, 80);
}

function getMmrRank(points) {
    if (points >= 1000) return '👑 Mondo Legende';
    if (points >= 600) return '💎 Gold Supporter';
    if (points >= 300) return '⭐ Label Insider';
    if (points >= 150) return '🔥 Street Team';
    if (points >= 50) return '🎧 Supporter';
    return '🌍 Listener';
}

function getOrCreateMmrSupporter(username, data = {}) {
    const key = normalizeMmrUser(username);
    if (!key) return null;
    if (!dbData.mmrSupporters) dbData.mmrSupporters = {};
    if (!dbData.mmrSupporters[key]) {
        dbData.mmrSupporters[key] = {
            username: key,
            displayName: getMmrDisplayName(data, username),
            points: 0,
            lifetimePoints: 0,
            follows: 0,
            shares: 0,
            likes: 0,
            gifts: 0,
            giftCoins: 0,
            chats: 0,
            isSubscriber: false,
            extraVotes: 0,
            redeemed: [],
            lastChatPointAt: 0,
            lastEventAt: Date.now(),
            createdAt: Date.now()
        };
    }
    const supporter = dbData.mmrSupporters[key];
    supporter.displayName = getMmrDisplayName(data, supporter.displayName || username);
    if (!supporter.redeemed) supporter.redeemed = [];
    if (typeof supporter.extraVotes !== 'number') supporter.extraVotes = 0;
    if (typeof supporter.lifetimePoints !== 'number') supporter.lifetimePoints = supporter.points || 0;
    if (typeof supporter.points !== 'number') supporter.points = 0;
    if (typeof supporter.likes !== 'number') supporter.likes = 0;
    if (typeof supporter.giftCoins !== 'number') supporter.giftCoins = 0;
    supporter.lastEventAt = Date.now();
    return supporter;
}

function mmrMultiplierFor(supporter) {
    return supporter && supporter.isSubscriber ? MMR_RULES.subscriberMultiplier : 1;
}

function addMmrEvent(username, type, points, note) {
    if (!dbData.mmrEvents) dbData.mmrEvents = [];
    dbData.mmrEvents.unshift({ username, type, points, note, timestamp: Date.now() });
    dbData.mmrEvents = dbData.mmrEvents.slice(0, 80);
}

function awardMmrPoints(username, rawPoints, type, data = {}, note = '') {
    const supporter = getOrCreateMmrSupporter(username, data);
    if (!supporter) return null;
    const multiplier = mmrMultiplierFor(supporter);
    const points = Math.max(0, Math.round((Number(rawPoints) || 0) * multiplier));
    if (points <= 0) return supporter;
    supporter.points += points;
    supporter.lifetimePoints += points;
    supporter.lastEventAt = Date.now();
    addMmrEvent(supporter.username, type, points, note || type);
    saveToDB();
    return supporter;
}

function getMmrTop(limit = 10) {
    const supporters = Object.values(dbData.mmrSupporters || {});
    return supporters
        .sort((a, b) => (b.points || 0) - (a.points || 0))
        .slice(0, limit)
        .map((s, index) => ({
            position: index + 1,
            username: s.username,
            displayName: s.displayName || s.username,
            points: s.points || 0,
            lifetimePoints: s.lifetimePoints || 0,
            rank: getMmrRank(s.points || 0),
            isSubscriber: s.isSubscriber === true,
            extraVotes: s.extraVotes || 0,
            shares: s.shares || 0,
            likes: s.likes || 0,
            giftCoins: s.giftCoins || 0,
            redeemed: s.redeemed || []
        }));
}

function getMmrSummary() {
    const supporters = Object.values(dbData.mmrSupporters || {});
    return {
        top: getMmrTop(10),
        totalSupporters: supporters.length,
        totalPoints: supporters.reduce((sum, s) => sum + (s.points || 0), 0),
        recentEvents: (dbData.mmrEvents || []).slice(0, 12),
        recentRedemptions: (dbData.mmrRedemptions || []).slice(0, 12),
        rewards: MMR_REWARDS,
        tikfinityStatus: {
            ...tikfinityStatus,
            connected: tikfinityStatus.connected || tikfinityStatus.bridgeConnected
        }
    };
}

function redeemMmrReward(username, rewardKey, options = {}) {
    const supporter = getOrCreateMmrSupporter(username);
    const reward = MMR_REWARDS[rewardKey];
    if (!supporter || !reward) return { ok: false, error: 'Supporter oder Belohnung nicht gefunden.' };
    if ((supporter.points || 0) < reward.cost) return { ok: false, error: `Nicht genug MMR Points. Benötigt: ${reward.cost}` };

    let extraResult = null;
    let note = reward.label;

    if (rewardKey === 'extra_vote') {
        supporter.extraVotes = (supporter.extraVotes || 0) + 1;
    }

    if (rewardKey === 'song_dice') {
        extraResult = markRandomSongDice(`mmr:${supporter.username}`);
        if (!extraResult.ok) return { ok: false, error: extraResult.error || 'Songwürfel konnte nicht eingelöst werden.' };
        note = '🎲 MMR Songwürfel eingelöst';
    }

    if (rewardKey === 'priority_boost') {
        const target = String(options.targetSongId || options.targetVoteCode || '').trim();
        if (!target) return { ok: false, error: 'Für Platz 1 Push muss ein Song ausgewählt werden.' };
        const song = dbData.songQueue.find(s => !s.isDone && !s.isAfterHours && (s.id === target || String(s.voteCode || '').toUpperCase() === target.toUpperCase()));
        if (!song) return { ok: false, error: 'Song für Platz 1 Push nicht gefunden.' };
        extraResult = markSongPriorityBoost(song.id, `mmr:${supporter.username}`);
        if (!extraResult.ok) return { ok: false, error: extraResult.error || 'Platz 1 Push konnte nicht eingelöst werden.' };
        note = `🚀 MMR Platz 1 Push eingelöst für ${song.artist} - ${song.title}`;
    }

    if (rewardKey === 'after_hours') {
        const passId = `MMR-AH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        extraResult = createAfterHoursPass(passId, `mmr:${supporter.username}`);
        if (!extraResult.ok) return { ok: false, error: extraResult.error || 'After-Hours-Pass konnte nicht erstellt werden.' };
        note = `🌙 MMR After-Hours-Pass erstellt: ${passId}`;
        options.afterHoursPassId = passId;
    }

    supporter.points -= reward.cost;
    const redemption = {
        username: supporter.username,
        displayName: supporter.displayName,
        rewardKey,
        rewardLabel: reward.label,
        cost: reward.cost,
        timestamp: Date.now(),
        targetSongId: options.targetSongId || null,
        targetVoteCode: options.targetVoteCode || null,
        afterHoursPassId: options.afterHoursPassId || null,
        result: extraResult || null
    };
    supporter.redeemed.unshift(redemption);
    supporter.redeemed = supporter.redeemed.slice(0, 20);
    if (!dbData.mmrRedemptions) dbData.mmrRedemptions = [];
    dbData.mmrRedemptions.unshift(redemption);
    dbData.mmrRedemptions = dbData.mmrRedemptions.slice(0, 60);
    addMmrEvent(supporter.username, 'reward', -reward.cost, note);
    saveToDB();
    return { ok: true, supporter, redemption };
}

function forwardMmrBridgePacket(packet) {
    if (!MMR_REMOTE_BRIDGE_URL || !mmrRemoteBridgeSocket || mmrRemoteBridgeSocket.readyState !== WebSocket.OPEN) return;
    try {
        mmrRemoteBridgeSocket.send(JSON.stringify({ type: 'tikfinity_event', packet, at: Date.now() }));
    } catch (err) {
        tikfinityStatus.lastError = 'Bridge senden fehlgeschlagen: ' + err.message;
    }
}

function handleTikFinityEvent(packet, options = {}) {
    if (!packet || typeof packet !== 'object') return;
    if (!options.fromBridge) forwardMmrBridgePacket(packet);
    const eventName = String(packet.event || packet.type || '').toLowerCase();
    const data = packet.data || packet;
    const username = getMmrUsername(data);
    tikfinityStatus.lastEvent = { event: eventName, at: Date.now(), user: username || null };
    if (!username) return;

    const supporter = getOrCreateMmrSupporter(username, data);
    if (!supporter) return;

    if (eventName === 'follow') {
        if (!supporter.followed) {
            supporter.followed = true;
            supporter.follows = (supporter.follows || 0) + 1;
            awardMmrPoints(username, MMR_RULES.follow, 'follow', data, 'Follow Bonus');
        }
        return;
    }

    if (eventName === 'share') {
        supporter.shares = (supporter.shares || 0) + 1;
        awardMmrPoints(username, MMR_RULES.share, 'share', data, 'Stream geteilt');
        return;
    }

    if (eventName === 'chat') {
        supporter.chats = (supporter.chats || 0) + 1;
        if (!supporter.lastChatPointAt || Date.now() - supporter.lastChatPointAt >= MMR_RULES.chatCooldownMs) {
            supporter.lastChatPointAt = Date.now();
            awardMmrPoints(username, MMR_RULES.chat, 'chat', data, 'Chat-Aktivität');
        } else {
            saveToDB();
        }
        return;
    }

    if (eventName === 'like') {
        const likeCount = Math.max(1, parseInt(data.likeCount || data.count || data.likes || 1, 10) || 1);
        supporter.likes = (supporter.likes || 0) + likeCount;
        const earnedBlocks = Math.floor((supporter.likes || 0) / MMR_RULES.likeBlockSize);
        const alreadyBlocks = supporter.likeBlocksAwarded || 0;
        const newBlocks = earnedBlocks - alreadyBlocks;
        if (newBlocks > 0) {
            supporter.likeBlocksAwarded = earnedBlocks;
            awardMmrPoints(username, newBlocks * MMR_RULES.likeBlock, 'like', data, `${newBlocks * MMR_RULES.likeBlockSize} Likes erreicht`);
        } else {
            saveToDB();
        }
        return;
    }

    if (eventName === 'gift') {
        // Bei Combo-Gifts nur am Ende zählen, damit keine doppelten Punkte entstehen.
        if (data.giftType === 1 && data.repeatEnd === false) return;
        const repeatCount = Math.max(1, parseInt(data.repeatCount || data.repeat || 1, 10) || 1);
        const coinValue = Math.max(1, parseInt(data.diamondCount || data.coins || data.coin || data.gift?.diamondCount || 1, 10) || 1);
        const coins = coinValue * repeatCount;
        supporter.gifts = (supporter.gifts || 0) + 1;
        supporter.giftCoins = (supporter.giftCoins || 0) + coins;
        awardMmrPoints(username, coins * MMR_RULES.giftPointPerCoin, 'gift', data, `Geschenk: ${data.giftName || data.gift?.name || coins + ' Coins'}`);
        return;
    }

    if (eventName === 'subscribe' || eventName === 'sub' || eventName === 'superfan') {
        const wasSubscriber = supporter.isSubscriber === true;
        supporter.isSubscriber = true;
        supporter.subscribedAt = supporter.subscribedAt || Date.now();
        if (!wasSubscriber) awardMmrPoints(username, MMR_RULES.subscribe, 'subscribe', data, 'VIP Supporter Bonus');
        else saveToDB();
        return;
    }

    saveToDB();
}


function buildBridgeUrl() {
    if (!MMR_REMOTE_BRIDGE_URL) return '';
    try {
        const url = new URL(MMR_REMOTE_BRIDGE_URL);
        if (!url.searchParams.get('secret')) url.searchParams.set('secret', MMR_BRIDGE_SECRET);
        return url.toString();
    } catch (err) {
        return MMR_REMOTE_BRIDGE_URL;
    }
}

function startMmrRemoteBridgeClient() {
    if (!MMR_REMOTE_BRIDGE_URL || !WebSocket) return;
    const connect = () => {
        try {
            const bridgeUrl = buildBridgeUrl();
            mmrRemoteBridgeSocket = new WebSocket(bridgeUrl);
            mmrRemoteBridgeSocket.on('open', () => {
                tikfinityStatus.bridgeConnected = true;
                tikfinityStatus.lastError = null;
                console.log(`[MMR] ✅ Render-Bridge verbunden: ${bridgeUrl}`);
            });
            mmrRemoteBridgeSocket.on('close', () => {
                tikfinityStatus.bridgeConnected = false;
                setTimeout(connect, 5000);
            });
            mmrRemoteBridgeSocket.on('error', (err) => {
                tikfinityStatus.bridgeConnected = false;
                tikfinityStatus.lastError = 'Render-Bridge Fehler: ' + err.message;
            });
        } catch (err) {
            tikfinityStatus.bridgeConnected = false;
            tikfinityStatus.lastError = 'Render-Bridge Startfehler: ' + err.message;
            setTimeout(connect, 5000);
        }
    };
    connect();
}

function startMmrBridgeServer(httpServer) {
    if (!WebSocket) return;
    const wss = new WebSocket.Server({ server: httpServer, path: MMR_BRIDGE_PATH });
    wss.on('connection', (socket, req) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const secret = url.searchParams.get('secret') || '';
            if (secret !== MMR_BRIDGE_SECRET) {
                socket.close(1008, 'Bridge Secret falsch');
                return;
            }
        } catch (err) {
            socket.close(1008, 'Bridge Prüfung fehlgeschlagen');
            return;
        }

        mmrBridgeClients.add(socket);
        tikfinityStatus.bridgeConnected = true;
        tikfinityStatus.lastError = null;
        console.log('[MMR] ✅ Lokaler TikFinity-Bridge-Client verbunden.');

        socket.on('message', (message) => {
            try {
                const payload = JSON.parse(message.toString());
                if (payload && payload.type === 'tikfinity_event' && payload.packet) {
                    tikfinityStatus.bridgeLastEvent = { at: Date.now(), type: payload.packet.event || payload.packet.type || null };
                    handleTikFinityEvent(payload.packet, { fromBridge: true });
                }
            } catch (err) {
                tikfinityStatus.lastError = 'Bridge Event konnte nicht gelesen werden: ' + err.message;
            }
        });

        socket.on('close', () => {
            mmrBridgeClients.delete(socket);
            tikfinityStatus.bridgeConnected = mmrBridgeClients.size > 0;
            console.log('[MMR] Render-Bridge-Client getrennt.');
        });

        socket.on('error', (err) => {
            tikfinityStatus.lastError = 'Bridge Socket Fehler: ' + err.message;
        });
    });
    console.log(`[MMR] Bridge Server bereit auf ${MMR_BRIDGE_PATH}`);
}


function startTikFinityBridge() {
    if (!TIKFINITY_EVENT_API_ENABLED) {
        console.log('[MMR] TikFinity Event API ist deaktiviert.');
        return;
    }
    if (!WebSocket) {
        tikfinityStatus.lastError = 'Paket ws fehlt. Bitte npm install ausführen.';
        return;
    }

    let ws;
    const connect = () => {
        try {
            ws = new WebSocket(TIKFINITY_WS_URL);
            ws.on('open', () => {
                tikfinityStatus.connected = true;
                tikfinityStatus.lastError = null;
                console.log(`[MMR] ✅ TikFinity verbunden: ${TIKFINITY_WS_URL}`);
            });
            ws.on('message', (message) => {
                try {
                    const packet = JSON.parse(message.toString());
                    handleTikFinityEvent(packet);
                } catch (err) {
                    console.log('[MMR] TikFinity Event konnte nicht gelesen werden:', err.message);
                }
            });
            ws.on('close', () => {
                tikfinityStatus.connected = false;
                tikfinityStatus.reconnects += 1;
                setTimeout(connect, 5000);
            });
            ws.on('error', (err) => {
                tikfinityStatus.connected = false;
                tikfinityStatus.lastError = err.message;
            });
        } catch (err) {
            tikfinityStatus.connected = false;
            tikfinityStatus.lastError = err.message;
            setTimeout(connect, 5000);
        }
    };
    connect();
}

function getSwissDateString(d) {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
}

function cleanArtistName(name) {
    return String(name || '').trim().toLowerCase();
}

function cleanBuyerEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function cleanupPendingBonusUsage() {
    if (!dbData.buyerBonusUsage) dbData.buyerBonusUsage = {};
    const now = Date.now();
    Object.values(dbData.buyerBonusUsage).forEach(usage => {
        if (!usage.pending) usage.pending = {};
        Object.keys(usage.pending).forEach(sessionId => {
            if (now - (usage.pending[sessionId].createdAt || 0) > PENDING_BONUS_TIMEOUT_MS) {
                delete usage.pending[sessionId];
            }
        });
    });
}

function getBuyerUsage(email) {
    const key = cleanBuyerEmail(email);
    if (!dbData.buyerBonusUsage) dbData.buyerBonusUsage = {};
    if (!dbData.buyerBonusUsage[key]) {
        dbData.buyerBonusUsage[key] = {
            completed: 0,
            pending: {},
            features: { priority_boost: 0, after_hours: 0, song_dice: 0 },
            sessions: []
        };
    }
    const usage = dbData.buyerBonusUsage[key];
    if (!usage.pending) usage.pending = {};
    if (!usage.features) usage.features = { priority_boost: 0, after_hours: 0, song_dice: 0 };
    if (!usage.sessions) usage.sessions = [];
    if (typeof usage.completed !== 'number') usage.completed = usage.sessions.length;
    return usage;
}

function activePendingCount(usage) {
    cleanupPendingBonusUsage();
    return Object.keys(usage.pending || {}).length;
}

function canBuyerStartCheckout(email) {
    if (!isValidEmail(email)) {
        return { ok: false, error: 'Bitte gib eine gültige E-Mail ein. So schützen wir das Limit: max. 2 Extras pro Nutzer und Stream.' };
    }
    const usage = getBuyerUsage(email);
    if ((usage.completed || 0) + activePendingCount(usage) >= MAX_EXTRAS_PER_BUYER) {
        return { ok: false, error: 'Limit erreicht: Pro Nutzer sind maximal 2 Stream-Extras pro Stream erlaubt.' };
    }
    return { ok: true };
}

function registerPendingCheckout(email, sessionId, feature) {
    const usage = getBuyerUsage(email);
    usage.pending[sessionId] = { feature, createdAt: Date.now() };
    saveToDB();
}

function completeBuyerCheckout(email, sessionId, feature) {
    const usage = getBuyerUsage(email);
    if (usage.sessions.includes(sessionId)) return { ok: true, duplicate: true };
    delete usage.pending[sessionId];
    if ((usage.completed || 0) >= MAX_EXTRAS_PER_BUYER) {
        return { ok: false, error: 'Limit erreicht: Pro Nutzer sind maximal 2 Stream-Extras pro Stream erlaubt.' };
    }
    usage.completed = (usage.completed || 0) + 1;
    usage.features[feature] = (usage.features[feature] || 0) + 1;
    usage.sessions.push(sessionId);
    return { ok: true };
}

function addBonusAnnouncement(text) {
    if (!dbData.bonusAnnouncements) dbData.bonusAnnouncements = [];
    dbData.bonusAnnouncements.unshift({ text, timestamp: Date.now() });
    dbData.bonusAnnouncements = dbData.bonusAnnouncements.slice(0, 8);
}

function moveSongToTop(songId) {
    const index = dbData.songQueue.findIndex(s => s.id === songId);
    if (index < 0) return null;
    if (index === 0) return dbData.songQueue[index];
    const [song] = dbData.songQueue.splice(index, 1);
    dbData.songQueue.unshift(song);
    return song;
}

function markSongPriorityBoost(songId, buyerEmail) {
    const targetSong = dbData.songQueue.find(s => s.id === songId && !s.isDone && !s.isAfterHours);
    if (!targetSong) return { ok: false, error: 'Song nicht gefunden oder nicht mehr in der Warteliste.' };
    if (!targetSong.bonusNotes) targetSong.bonusNotes = [];
    targetSong.isBoosted = true;
    targetSong.boostPaidAt = Date.now();
    targetSong.priorityBoostBuyerEmail = cleanBuyerEmail(buyerEmail);
    targetSong.bonusNotes.push('🚀💎 Platz-1-Push gekauft');
    moveSongToTop(targetSong.id);
    addBonusAnnouncement(`🚀💎 ${targetSong.artist} - ${targetSong.title} wurde per Platz-1-Push automatisch auf Platz 1 gesetzt.`);
    return { ok: true };
}

function markRandomSongDice(buyerEmail) {
    const candidates = dbData.songQueue.filter(s => !s.isDone && !s.isAfterHours);
    if (candidates.length === 0) return { ok: false, error: 'Keine Songs in der Warteliste.' };
    const pickedSong = candidates[Math.floor(Math.random() * candidates.length)];
    if (!pickedSong.bonusNotes) pickedSong.bonusNotes = [];
    pickedSong.isDice = true;
    pickedSong.isBoosted = true;
    pickedSong.diceSelectedAt = Date.now();
    pickedSong.diceBuyerEmail = cleanBuyerEmail(buyerEmail);
    pickedSong.bonusNotes.push('🎲💎 Song-Würfel: zufällig ausgewählt und direkt auf Platz 1 gepusht');
    moveSongToTop(pickedSong.id);
    addBonusAnnouncement(`🎲💎 SONG-WÜRFEL: ${pickedSong.artist} - ${pickedSong.title} wurde zufällig ausgewählt und direkt auf Platz 1 gepusht.`);
    return { ok: true, songId: pickedSong.id };
}

function createAfterHoursPass(sessionId, buyerEmail) {
    if (!dbData.afterHoursPasses) dbData.afterHoursPasses = {};
    dbData.afterHoursPasses[sessionId] = {
        sessionId,
        buyerEmail: cleanBuyerEmail(buyerEmail),
        used: false,
        createdAt: Date.now(),
        usedAt: null,
        songId: null
    };
    dbData.extensionActive = true;
    addBonusAnnouncement('🌙💎 After Hours Pass gekauft: Ein Nutzer kann nach den freien 90 Minuten einmalig einen Song in der Verlängerung einreichen.');
    return { ok: true };
}

function applyPaidBonus(feature, songId, buyerEmail, stripeSessionId = null) {
    let result = { ok: false, error: 'Unbekanntes Extra.' };

    if (feature === 'priority_boost') {
        result = markSongPriorityBoost(songId, buyerEmail);
    } else if (feature === 'after_hours') {
        result = createAfterHoursPass(stripeSessionId, buyerEmail);
    } else if (feature === 'song_dice') {
        result = markRandomSongDice(buyerEmail);
    }

    if (stripeSessionId) {
        if (!dbData.processedStripeSessions) dbData.processedStripeSessions = {};
        dbData.processedStripeSessions[stripeSessionId] = { feature, songId: songId || null, buyerEmail: cleanBuyerEmail(buyerEmail), result, timestamp: Date.now() };
    }

    saveToDB();
    return result;
}

function applyStripeBonus(session) {
    if (!session || !session.id) return;
    if (!dbData.processedStripeSessions) dbData.processedStripeSessions = {};
    if (dbData.processedStripeSessions[session.id]) return;

    const feature = session.metadata && session.metadata.feature;
    const songId = session.metadata && session.metadata.songId;
    const buyerEmail = (session.metadata && session.metadata.buyerEmail) || (session.customer_details && session.customer_details.email) || session.customer_email || '';
    if (!feature || !buyerEmail) {
        console.log('[STRIPE] Checkout ohne Extra-Metadaten:', session.id);
        return;
    }

    const buyerCheck = completeBuyerCheckout(buyerEmail, session.id, feature);
    if (!buyerCheck.ok) {
        dbData.processedStripeSessions[session.id] = { feature, songId: songId || null, buyerEmail: cleanBuyerEmail(buyerEmail), error: buyerCheck.error, timestamp: Date.now() };
        addBonusAnnouncement(`⚠️ Stream-Extra nicht angewendet: ${buyerCheck.error}`);
        saveToDB();
        return;
    }

    const result = applyPaidBonus(feature, songId, buyerEmail, session.id);
    if (!result.ok) {
        dbData.processedStripeSessions[session.id] = { feature, songId: songId || null, buyerEmail: cleanBuyerEmail(buyerEmail), error: result.error, timestamp: Date.now() };
        saveToDB();
    }
}

function redeemAfterHoursPass(sessionId, song) {
    if (!sessionId || !dbData.afterHoursPasses || !dbData.afterHoursPasses[sessionId]) {
        return { ok: false, error: 'Kein gültiger After-Hours-Pass gefunden.' };
    }
    const pass = dbData.afterHoursPasses[sessionId];
    if (pass.used) return { ok: false, error: 'Dieser After-Hours-Pass wurde bereits benutzt.' };
    pass.used = true;
    pass.usedAt = Date.now();
    pass.songId = song.id;
    song.isAfterHours = true;
    song.afterHoursPaidAt = Date.now();
    song.afterHoursPassId = sessionId;
    song.afterHoursBuyerEmail = pass.buyerEmail;
    if (!song.bonusNotes) song.bonusNotes = [];
    song.bonusNotes.push('🌙💎 After Hours Pass eingelöst');
    addBonusAnnouncement(`🌙💎 ${song.artist} - ${song.title} wurde mit After-Hours-Pass in die Verlängerung eingereicht.`);
    return { ok: true };
}

// AUTOMATISCHE VOTING-AUSWERTUNG
function processVotingResult() {
    const hits = dbData.songQueue.filter(s => s.isHit);
    if (hits.length === 0) {
        dbData.votingPhase = 'inactive'; dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = []; dbData.votingEndsAt = null; saveToDB();
        return;
    }

    let maxVotes = -1; let tiedSongs = [];
    hits.forEach(song => {
        const v = dbData.votes[song.id] || 0;
        if (v > maxVotes) { maxVotes = v; tiedSongs = [song]; } else if (v === maxVotes) { tiedSongs.push(song); }
    });

    if (tiedSongs.length > 1) {
        dbData.votingPhase = 'tiebreak'; dbData.tiedSongs = tiedSongs.map(s => s.id);
    } else if (tiedSongs.length === 1) {
        finalizeWinner(tiedSongs[0].id); return; 
    } else {
        dbData.votingPhase = 'inactive'; dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = [];
    }
    dbData.votingEndsAt = null;
    saveToDB();
}

// ==========================================
// LEMON SQUEEZY WEBHOOK (Zahlungen empfangen)
// ==========================================
app.post('/api/webhook/lemonsqueezy', (req, res) => {
    const data = req.body;

    if (data.meta && data.meta.event_name === 'order_created') {
        const orderData = data.data.attributes;
        const variantId = orderData.first_order_item.variant_id.toString();
        const customerEmail = orderData.user_email;
        
        const customData = data.meta.custom_data || {};
        const targetVoteCode = customData.voteCode; 

        switch (variantId) {
            case "1827662":
                // 🚀 FEATURE 1: PLATZ 1 BOOST
                console.log(`[LS] PLATZ 1 BOOST von ${customerEmail} für Code: ${targetVoteCode}`);
                if (targetVoteCode) {
                    const songIndex = dbData.songQueue.findIndex(s => s.voteCode === targetVoteCode && !s.isDone);
                    if (songIndex > -1) {
                        dbData.songQueue[songIndex].isBoosted = true; // Markierung setzen
                        const [boostedSong] = dbData.songQueue.splice(songIndex, 1);
                        dbData.songQueue.unshift(boostedSong); // An Index 0 schieben
                        saveToDB();
                        console.log(`[LS] Song "${boostedSong.title}" ist jetzt auf Platz 1!`);
                    }
                }
                break;

            case "1827685":
                // 🌙 FEATURE 2: AFTER HOURS PASS
                console.log(`[LS] AFTER HOURS PASS von ${customerEmail} für Code: ${targetVoteCode}`);
                dbData.extensionActive = true; // Verlängerung global aktivieren
                if (targetVoteCode) {
                    const ahSong = dbData.songQueue.find(s => s.voteCode === targetVoteCode);
                    if (ahSong) {
                        ahSong.isAfterHours = true; // Song-Markierung setzen
                    }
                }
                saveToDB();
                break;

            case "1827686":
                // 🎲 FEATURE 3: SONGWÜRFEL
                console.log(`[LS] SONGWÜRFEL von ${customerEmail} für Code: ${targetVoteCode}`);
                if (targetVoteCode) {
                    const diceSong = dbData.songQueue.find(s => s.voteCode === targetVoteCode);
                    if (diceSong) {
                        diceSong.isDice = true; // Würfel-Markierung setzen
                        saveToDB();
                    }
                }
                break;

            default:
                console.log(`[LS] Unbekannte Variant ID: ${variantId}`);
                break;
        }
    }

    res.status(200).send('OK');
});
// ==========================================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/regeln', (req, res) => res.sendFile(path.join(__dirname, 'regeln.html')));

app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const baseMaxSeconds = (BASE_LIMIT_MINUTES + dbData.extraTimeMinutes) * 60;
    const extensionMaxSeconds = (BASE_LIMIT_MINUTES + dbData.extraTimeMinutes + EXTENSION_LIMIT_MINUTES) * 60;
    
    let phase = 'base';
    let submissionsOpen = false;
    let currentMaxSeconds = baseMaxSeconds;

    if (!dbData.extensionActive) {
        if (totalSeconds < baseMaxSeconds) { phase = 'base'; submissionsOpen = true; currentMaxSeconds = baseMaxSeconds; } 
        else { phase = 'base_full'; submissionsOpen = false; currentMaxSeconds = baseMaxSeconds; }
    } else {
        if (totalSeconds < extensionMaxSeconds) { phase = 'extension'; submissionsOpen = true; currentMaxSeconds = extensionMaxSeconds; } 
        else { phase = 'extension_full'; submissionsOpen = false; currentMaxSeconds = extensionMaxSeconds; }
    }

    const remainingSecondsTotal = Math.max(0, currentMaxSeconds - totalSeconds);
    const minSpent = Math.floor(totalSeconds / 60);
    const secSpent = totalSeconds % 60;
    const spentFormatted = `${minSpent} Min. ${secSpent < 10 ? '0'+secSpent : secSpent} Sek.`;
    
    let votingRemainingSeconds = 0;
    if (dbData.votingPhase === 'active' && dbData.votingEndsAt) {
        votingRemainingSeconds = Math.max(0, Math.floor((dbData.votingEndsAt - Date.now()) / 1000));
    }
    
    const processedQueue = dbData.songQueue.map(song => {
        let platform = 'other';
        if (/spotify\.com/i.test(song.songLink)) platform = 'spotify';
        else if (/youtube\.com|youtu\.be/i.test(song.songLink)) platform = 'youtube';
        return { 
            id: song.id, artist: song.artist, title: song.title, 
            duration: song.duration, genre: song.genre, songLink: song.songLink, 
            isHit: song.isHit, isDone: song.isDone, platform,
            isDice: song.isDice || false,
            isBoosted: song.isBoosted || false,
            isAfterHours: song.isAfterHours || false,
            dicePickedBy: song.dicePickedBy || null,
            diceSelectedAt: song.diceSelectedAt || null,
            priorityBoostBuyerEmail: song.priorityBoostBuyerEmail || null,
            afterHoursBuyerEmail: song.afterHoursBuyerEmail || null,
            diceBuyerEmail: song.diceBuyerEmail || null,
            bonusNotes: song.bonusNotes || []
        };
    });

    let tiedSongsDetails = [];
    if (dbData.votingPhase === 'tiebreak' && dbData.tiedSongs) {
        tiedSongsDetails = dbData.tiedSongs.map(id => dbData.songQueue.find(s => s.id === id)).filter(Boolean);
    }

    const processedHallOfFame = (dbData.hallOfFame || []).map(champ => {
        let platform = 'other';
        if (/spotify\.com/i.test(champ.songLink || '')) platform = 'spotify';
        else if (/youtube\.com|youtu\.be/i.test(champ.songLink || '')) platform = 'youtube';
        return { ...champ, platform };
    });

    const paidExtrasSessions = Object.values(dbData.processedStripeSessions || {})
        .filter(entry => entry && !entry.error && entry.result && entry.result.ok)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const paidExtrasSummary = {
        total: paidExtrasSessions.length,
        priorityBoost: paidExtrasSessions.filter(entry => entry.feature === 'priority_boost').length,
        afterHours: paidExtrasSessions.filter(entry => entry.feature === 'after_hours').length,
        songDice: paidExtrasSessions.filter(entry => entry.feature === 'song_dice').length,
        openAfterHoursPasses: Object.values(dbData.afterHoursPasses || {}).filter(p => !p.used).length,
        usedAfterHoursPasses: Object.values(dbData.afterHoursPasses || {}).filter(p => p.used).length
    };

    const recentPaidExtras = paidExtrasSessions.slice(0, 12).map(entry => ({
        feature: entry.feature,
        songId: entry.songId || null,
        buyerEmail: entry.buyerEmail || null,
        timestamp: entry.timestamp || null,
        result: entry.result || null
    }));

    res.json({
        queue: processedQueue,
        remainingMinutes: Math.floor(remainingSecondsTotal / 60),
        remainingSeconds: remainingSecondsTotal % 60,
        remainingSecondsTotal: remainingSecondsTotal,
        spentFormatted: spentFormatted,
        submissionsOpen: submissionsOpen,
        phase: phase,
        extensionActive: dbData.extensionActive === true,
        votingPhase: dbData.votingPhase,
        votingRemainingSeconds: votingRemainingSeconds,
        votes: dbData.votes,
        tiedSongs: tiedSongsDetails,
        hallOfFame: processedHallOfFame,
        historicalHits: dbData.historicalHits,
        systemOnline: dbData.systemOnline !== false,
        bonusAnnouncements: dbData.bonusAnnouncements || [],
        viewerCodeStats: getViewerCodeStats(),
        paidExtrasSummary,
        recentPaidExtras,
        mmr: getMmrSummary(),
        afterHoursPasses: Object.values(dbData.afterHoursPasses || {}).map(p => ({
            sessionId: p.sessionId,
            buyerEmail: p.buyerEmail,
            used: p.used,
            createdAt: p.createdAt,
            usedAt: p.usedAt,
            songId: p.songId
        }))
    });
});

app.post('/api/submit', (req, res) => {
    if (dbData.systemOnline === false) return res.status(400).json({ error: "Das Einreicheformular ist aktuell offline!" });

    const { artist, title, duration, genre, songLink, afterHoursSessionId } = req.body;
    const isSpotify = /spotify\.com/i.test(songLink);
    const isYouTube = /youtube\.com|youtu\.be/i.test(songLink);
    if (!isSpotify && !isYouTube) return res.status(400).json({ error: "Nur Links von Spotify oder YouTube erlaubt!" });

    const hasDuplicateLink = dbData.songQueue.some(song => song.songLink.trim().toLowerCase() === songLink.trim().toLowerCase());
    if (hasDuplicateLink) return res.status(400).json({ error: "Song-Link ist bereits in der Liste!" });

    if (["Schlager", "Hardstyle", "Hardcore", "Metal"].includes(genre)) return res.status(400).json({ error: "Dieses Genre wird blockiert!" });

    const cleanArtist = artist.trim().toLowerCase();
    if (cleanArtist !== "mondo mando" && cleanArtist !== "mondo") {
        const hasSubmitted = dbData.songQueue.some(song => song.artist.trim().toLowerCase() === cleanArtist);
        if (hasSubmitted) return res.status(400).json({ error: "Nur 1 Song pro Künstler erlaubt." });
    }

    const totalSeconds = getTotalTimeSeconds();
    const baseMaxSeconds = (BASE_LIMIT_MINUTES + dbData.extraTimeMinutes) * 60;
    const extensionMaxSeconds = (BASE_LIMIT_MINUTES + dbData.extraTimeMinutes + EXTENSION_LIMIT_MINUTES) * 60;

    const wantsAfterHours = Boolean(afterHoursSessionId);
    if (wantsAfterHours) {
        if (totalSeconds < baseMaxSeconds) return res.status(400).json({ error: "Dein After-Hours-Pass ist für nach den freien 90 Minuten. Aktuell kannst du noch normal einreichen." });
        if (totalSeconds >= extensionMaxSeconds) return res.status(400).json({ error: "Verlängerung komplett voll!" });
        if (!dbData.afterHoursPasses || !dbData.afterHoursPasses[afterHoursSessionId] || dbData.afterHoursPasses[afterHoursSessionId].used) {
            return res.status(400).json({ error: "After-Hours-Pass ungültig oder bereits benutzt." });
        }
        dbData.extensionActive = true;
    } else {
        if (!dbData.extensionActive && totalSeconds >= baseMaxSeconds) return res.status(400).json({ error: "Hauptzeit voll! Für die Verlängerung brauchst du einen After-Hours-Pass." });
        if (dbData.extensionActive && totalSeconds >= extensionMaxSeconds) return res.status(400).json({ error: "Verlängerung komplett voll!" });
    }

    const newCode = generateVoteCode();
    const newSong = {
        id: "S-" + Date.now().toString(36) + Math.random().toString(36).substring(2, 5),
        voteCode: newCode,
        artist, title, duration: parseInt(duration) || 0, genre, songLink,
        isHit: false, isDone: false, isDice: false, isBoosted: false, isAfterHours: false, bonusNotes: [], timestamp: Date.now()
    };

    if (wantsAfterHours) {
        const redeem = redeemAfterHoursPass(afterHoursSessionId, newSong);
        if (!redeem.ok) return res.status(400).json({ error: redeem.error });
    }

    dbData.songQueue.push(newSong);
    saveToDB();
    res.json({ success: true, voteCode: newCode, songId: newSong.id, afterHoursPassUsed: wantsAfterHours });
});


app.post('/api/voting-code', (req, res) => {
    if (!dbData.viewerVoteCodes) dbData.viewerVoteCodes = {};
    if (!dbData.viewerDeviceCodes) dbData.viewerDeviceCodes = {};

    const deviceId = String(req.body.deviceId || '').trim().slice(0, 80);
    const tiktokName = String(req.body.tiktokName || '').trim().slice(0, 40);

    if (!deviceId || deviceId.length < 8) {
        return res.status(400).json({ error: 'Dein Gerät konnte nicht erkannt werden. Bitte lade die Seite neu und versuche es nochmal.' });
    }

    const existingCode = dbData.viewerDeviceCodes[deviceId];
    if (existingCode && dbData.viewerVoteCodes[existingCode]) {
        const existing = dbData.viewerVoteCodes[existingCode];
        if (tiktokName && !existing.tiktokName) existing.tiktokName = tiktokName;
        saveToDB();
        return res.json({ success: true, code: existingCode, reused: true });
    }

    const ip = getClientIp(req);
    const ipCodeCount = Object.values(dbData.viewerVoteCodes).filter(c => c.ip === ip).length;
    if (ipCodeCount >= 5) {
        return res.status(429).json({ error: 'Zu viele Voting-Codes über dieselbe Verbindung. Bitte nicht mehrfach Codes holen.' });
    }

    const code = createUniqueVotingCode();
    dbData.viewerVoteCodes[code] = {
        code,
        deviceId,
        tiktokName,
        ip,
        createdAt: Date.now(),
        used: false,
        usedAt: null
    };
    dbData.viewerDeviceCodes[deviceId] = code;
    saveToDB();

    res.json({ success: true, code, reused: false });
});


app.get('/api/mmr', (req, res) => {
    res.json(getMmrSummary());
});

app.post('/api/admin/mmr/manual-add', checkAdminAuth, (req, res) => {
    const username = String(req.body.username || '').trim();
    const points = parseInt(req.body.points, 10) || 0;
    const reason = String(req.body.reason || 'Manuell im Admin vergeben').slice(0, 120);
    if (!username) return res.status(400).json({ error: 'TikTok-Name fehlt.' });
    if (points === 0) return res.status(400).json({ error: 'Punkte dürfen nicht 0 sein.' });
    const supporter = awardMmrPoints(username, points, 'manual', { uniqueId: username }, reason);
    res.json({ success: true, supporter });
});

app.post('/api/admin/mmr/redeem', checkAdminAuth, (req, res) => {
    const username = String(req.body.username || '').trim();
    const rewardKey = String(req.body.rewardKey || '').trim();
    const options = {
        targetSongId: String(req.body.targetSongId || '').trim(),
        targetVoteCode: String(req.body.targetVoteCode || '').trim()
    };
    const result = redeemMmrReward(username, rewardKey, options);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success: true, redemption: result.redemption, supporter: result.supporter });
});

app.post('/api/admin/mmr/reset-events', checkAdminAuth, (req, res) => {
    dbData.mmrEvents = [];
    dbData.mmrRedemptions = [];
    saveToDB();
    res.json({ success: true });
});

app.post('/api/create-bonus-checkout', async (req, res) => {
    if (!stripe) return res.status(500).json({ error: 'Stripe ist noch nicht konfiguriert. STRIPE_SECRET_KEY fehlt in den Umgebungsvariablen.' });

    const { feature, songId, buyerEmail } = req.body;
    if (!STRIPE_PRICE_IDS[feature]) return res.status(400).json({ error: 'Unbekanntes Stream-Extra.' });

    const buyerCheck = canBuyerStartCheckout(buyerEmail);
    if (!buyerCheck.ok) return res.status(400).json({ error: buyerCheck.error });

    let song = null;
    if (feature === 'priority_boost') {
        song = dbData.songQueue.find(s => s.id === songId && !s.isDone && !s.isAfterHours);
        if (!song) return res.status(400).json({ error: 'Wähle zuerst einen Song aus der Warteliste aus.' });
    }

    try {
        const origin = `${req.protocol}://${req.get('host')}`;
        const successUrl = feature === 'after_hours'
            ? `${origin}/?after_hours_paid={CHECKOUT_SESSION_ID}`
            : `${origin}/?bonus=success`;

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price: STRIPE_PRICE_IDS[feature], quantity: 1 }],
            customer_email: cleanBuyerEmail(buyerEmail),
            metadata: {
                feature,
                songId: song ? song.id : '',
                buyerEmail: cleanBuyerEmail(buyerEmail),
                artist: song ? song.artist : '',
                title: song ? song.title : '',
                system: 'mondo_mando_stream_extras'
            },
            success_url: successUrl,
            cancel_url: `${origin}/?bonus=cancel`,
            submit_type: 'pay'
        });

        registerPendingCheckout(buyerEmail, session.id, feature);
        res.json({ url: session.url });
    } catch (err) {
        console.error('[STRIPE] Checkout konnte nicht erstellt werden:', err.message);
        res.status(500).json({ error: 'Stripe Checkout konnte nicht erstellt werden.' });
    }
});

app.post('/api/vote', (req, res) => {
    if (dbData.votingPhase !== 'active') return res.status(400).json({ error: "Voting ist aktuell geschlossen!" });

    const { voteCode, vote1, vote2 } = req.body;
    if (!voteCode || !vote1 || !vote2) return res.status(400).json({ error: "Fehlende Daten. Du brauchst 2 Stimmen und deinen Code!" });
    if (vote1 === vote2) return res.status(400).json({ error: "Du darfst nicht zweimal für denselben Song abstimmen!" });

    const codeUpper = voteCode.trim().toUpperCase();
    const viewerCode = dbData.viewerVoteCodes && dbData.viewerVoteCodes[codeUpper];
    const voterSong = dbData.songQueue.find(s => s.voteCode === codeUpper);

    if (!viewerCode && !voterSong) return res.status(400).json({ error: "Ungültiger Voting-Code!" });
    if (dbData.usedCodes[codeUpper]) return res.status(400).json({ error: "Dieser Voting-Code wurde bereits eingelöst!" });
    if (viewerCode && viewerCode.used) return res.status(400).json({ error: "Dieser Voting-Code wurde bereits eingelöst!" });

    // Nur Künstler mit eigenem Song-Code dürfen nicht für den eigenen Song stimmen.
    // Zuschauer-Codes aus dem TikTok-Chat haben keinen eigenen Song und dürfen normal abstimmen.
    if (voterSong && (vote1 === voterSong.id || vote2 === voterSong.id)) {
        return res.status(400).json({ error: "Du darfst nicht für deinen eigenen Song abstimmen!" });
    }

    const song1 = dbData.songQueue.find(s => s.id === vote1 && s.isHit);
    const song2 = dbData.songQueue.find(s => s.id === vote2 && s.isHit);

    if (!song1 || !song2) return res.status(400).json({ error: "Ungültige Auswahl oder Song ist kein Hit." });

    dbData.votes[vote1] = (dbData.votes[vote1] || 0) + 1;
    dbData.votes[vote2] = (dbData.votes[vote2] || 0) + 1;
    dbData.usedCodes[codeUpper] = true;

    let extraVoteUsed = false;
    if (viewerCode) {
        viewerCode.used = true;
        viewerCode.usedAt = Date.now();
        viewerCode.vote1 = vote1;
        viewerCode.vote2 = vote2;

        const mmrKey = normalizeMmrUser(viewerCode.tiktokName || '');
        const mmrSupporter = mmrKey && dbData.mmrSupporters ? dbData.mmrSupporters[mmrKey] : null;
        if (mmrSupporter && (mmrSupporter.extraVotes || 0) > 0) {
            dbData.votes[vote1] = (dbData.votes[vote1] || 0) + 1;
            mmrSupporter.extraVotes -= 1;
            extraVoteUsed = true;
            addMmrEvent(mmrSupporter.username, 'extra_vote_used', 0, 'Extra Stimme im Voting eingelöst');
        }
    }

    saveToDB();
    res.json({ success: true, extraVoteUsed });
});

app.post('/api/admin/voting/start', checkAdminAuth, (req, res) => {
    dbData.votingPhase = 'active'; 
    dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = [];
    Object.values(dbData.viewerVoteCodes || {}).forEach(code => {
        code.used = false;
        code.usedAt = null;
        delete code.vote1;
        delete code.vote2;
    });
    dbData.votingEndsAt = Date.now() + 4 * 60 * 1000; // 4 Minuten ab jetzt
    
    if(votingTimeout) clearTimeout(votingTimeout);
    votingTimeout = setTimeout(() => {
        if (dbData.votingPhase === 'active') processVotingResult();
    }, 4 * 60 * 1000);

    saveToDB(); res.json({ success: true });
});

app.post('/api/admin/voting/resolve', checkAdminAuth, (req, res) => {
    if(votingTimeout) { clearTimeout(votingTimeout); votingTimeout = null; }
    
    const { forceWinnerId } = req.body;
    if (forceWinnerId) { finalizeWinner(forceWinnerId); return res.json({ success: true }); }

    processVotingResult();
    
    if (dbData.votingPhase === 'tiebreak') {
        res.json({ tiebreak: true });
    } else {
        res.json({ success: true });
    }
});

app.post('/api/admin/voting/reset-timer', checkAdminAuth, (req, res) => {
    if (dbData.votingPhase !== 'active') return res.status(400).json({error: "Voting nicht aktiv"});
    
    dbData.votingEndsAt = Date.now() + 4 * 60 * 1000;
    if(votingTimeout) clearTimeout(votingTimeout);
    votingTimeout = setTimeout(() => {
        if (dbData.votingPhase === 'active') processVotingResult();
    }, 4 * 60 * 1000);
    
    saveToDB();
    res.json({ success: true });
});

function finalizeWinner(songId) {
    const winner = dbData.songQueue.find(s => s.id === songId);
    if (winner) {
        const votes = dbData.votes[songId] || 0;
        dbData.hallOfFame.push({
            artist: winner.artist,
            title: winner.title,
            votes: votes,
            date: getSwissDateString(new Date()),
            songLink: winner.songLink,
            genre: winner.genre,
            timestamp: Date.now()
        });
    }
    dbData.votingPhase = 'inactive'; dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = []; dbData.votingEndsAt = null;
    saveToDB();
}


app.post('/api/admin/voting/reset-viewer-codes', checkAdminAuth, (req, res) => {
    dbData.viewerVoteCodes = {};
    dbData.viewerDeviceCodes = {};
    dbData.usedCodes = {};
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/auth', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) res.json({ success: true }); else res.status(401).json({ error: "Falsches Passwort!" });
});

app.post('/api/admin/set-system-status', checkAdminAuth, (req, res) => {
    const { online } = req.body; dbData.systemOnline = !!online; saveToDB(); res.json({ success: true });
});

app.post('/api/admin/toggle-extension', checkAdminAuth, (req, res) => {
    dbData.extensionActive = !dbData.extensionActive; saveToDB(); res.json({ success: true, extensionActive: dbData.extensionActive });
});

app.post('/api/admin/reorder-active', checkAdminAuth, (req, res) => {
    const { oldIndex, newIndex } = req.body;
    let activeSongs = []; let doneSongs = [];
    dbData.songQueue.forEach(song => { if (song.isDone) doneSongs.push(song); else activeSongs.push(song); });
    if (oldIndex >= 0 && oldIndex < activeSongs.length && newIndex >= 0 && newIndex < activeSongs.length) {
        const [movedSong] = activeSongs.splice(oldIndex, 1);
        activeSongs.splice(newIndex, 0, movedSong);
        dbData.songQueue = [...doneSongs, ...activeSongs];
        saveToDB(); res.json({ success: true });
    } else res.status(400).json({ error: "Fehler beim Verschieben" });
});

app.post('/api/queue/:index/hit', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) {
        const song = dbData.songQueue[index]; song.isHit = !song.isHit;
        const dateStr = getSwissDateString(new Date());
        if (!dbData.historicalHits[dateStr]) dbData.historicalHits[dateStr] = [];
        if (song.isHit) {
            const exists = dbData.historicalHits[dateStr].find(s => s.artist === song.artist && s.title === song.title);
            if (!exists) dbData.historicalHits[dateStr].push({ artist: song.artist, title: song.title, genre: song.genre, songLink: song.songLink });
        } else {
            dbData.historicalHits[dateStr] = dbData.historicalHits[dateStr].filter(s => !(s.artist === song.artist && s.title === song.title));
            if (dbData.historicalHits[dateStr].length === 0) delete dbData.historicalHits[dateStr];
        }
        saveToDB(); res.json({ success: true });
    } else res.status(400).json({ error: "Index Fehler" });
});

app.post('/api/queue/:index/done', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) { dbData.songQueue[index].isDone = !dbData.songQueue[index].isDone; saveToDB(); res.json({ success: true }); }
});

app.delete('/api/queue/:index', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) { dbData.songQueue.splice(index, 1); saveToDB(); res.json({ success: true }); }
});

app.post('/api/admin/overtime', checkAdminAuth, (req, res) => {
    const { minutes } = req.body;
    dbData.extraTimeMinutes = (dbData.extraTimeMinutes || 0) + (parseFloat(minutes) || 0); saveToDB(); res.json({ success: true });
});

app.delete('/api/admin/halloffame/:index', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.hallOfFame && dbData.hallOfFame[index]) { dbData.hallOfFame.splice(index, 1); saveToDB(); res.json({ success: true }); } 
});

app.post('/api/queue/reset', checkAdminAuth, (req, res) => {
    dbData.songQueue = []; dbData.votingPhase = 'inactive'; dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = []; dbData.extensionActive = false; dbData.extraTimeMinutes = 0; dbData.votingEndsAt = null; dbData.bonusUsage = {}; dbData.buyerBonusUsage = {}; dbData.afterHoursPasses = {}; dbData.processedStripeSessions = {}; dbData.bonusAnnouncements = [];
    if(votingTimeout) { clearTimeout(votingTimeout); votingTimeout = null; }
    saveToDB(); res.json({ success: true });
});

const httpServer = http.createServer(app);
startMmrBridgeServer(httpServer);

httpServer.listen(PORT, () => {
    console.log(`🚀 MONDO MANDO RECORDS RUNNING ON PORT ${PORT}`);
    startTikFinityBridge();
    startMmrRemoteBridgeClient();
});
