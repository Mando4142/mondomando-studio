require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const Stripe = require('stripe');
const PORT = process.env.PORT || 3000;

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
app.use(express.static(path.join(__dirname)));

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
    bonusAnnouncements: []
};

let votingTimeout = null;

function generateVoteCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
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
    pickedSong.diceSelectedAt = Date.now();
    pickedSong.diceBuyerEmail = cleanBuyerEmail(buyerEmail);
    pickedSong.bonusNotes.push('🎲💎 Vom Song-Würfel zufällig ausgewählt');
    addBonusAnnouncement(`🎲💎 SONG-WÜRFEL: ${pickedSong.artist} - ${pickedSong.title} wurde zufällig aus der Warteliste ausgewählt.`);
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
        paidExtrasSummary,
        recentPaidExtras,
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
    const voterSong = dbData.songQueue.find(s => s.voteCode === codeUpper);
    
    if (!voterSong) return res.status(400).json({ error: "Ungültiger Voting-Code!" });
    if (dbData.usedCodes[codeUpper]) return res.status(400).json({ error: "Dieser Voting-Code wurde bereits eingelöst!" });
    if (vote1 === voterSong.id || vote2 === voterSong.id) return res.status(400).json({ error: "Du darfst nicht für deinen eigenen Song abstimmen!" });

    const song1 = dbData.songQueue.find(s => s.id === vote1 && s.isHit);
    const song2 = dbData.songQueue.find(s => s.id === vote2 && s.isHit);

    if (!song1 || !song2) return res.status(400).json({ error: "Ungültige Auswahl oder Song ist kein Hit." });

    dbData.votes[vote1] = (dbData.votes[vote1] || 0) + 1;
    dbData.votes[vote2] = (dbData.votes[vote2] || 0) + 1;
    dbData.usedCodes[codeUpper] = true;

    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/voting/start', checkAdminAuth, (req, res) => {
    dbData.votingPhase = 'active'; 
    dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = [];
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

app.listen(PORT, () => { console.log(`🚀 MONDO MANDO RECORDS RUNNING ON PORT ${PORT}`); });
