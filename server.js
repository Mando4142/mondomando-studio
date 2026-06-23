require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 3000;

// ==========================================
// STRIPE WEBHOOK (Muss vor express.json stehen!)
// ==========================================
app.post('/api/webhook', express.raw({type: 'application/json'}), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.metadata && session.metadata.action === 'priority_boost') {
            const idx = dbData.songQueue.findIndex(s => s.artist.toLowerCase() === session.metadata.artistLower && !s.isDone);
            if (idx > -1) {
                const song = dbData.songQueue.splice(idx, 1)[0];
                dbData.songQueue.unshift(song); // Verschiebt auf Platz 1
                saveToDB();
            }
        }
    }
    res.json({received: true});
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const DB_FILE = path.join(__dirname, 'database.json');
let dbData = { songQueue: [], extraTimeMinutes: 0, votingPhase: 'inactive', votes: {}, usedCodes: {}, tiedSongs: [], hallOfFame: [], historicalHits: {}, systemOnline: true, extensionActive: false, votingEndsAt: null };

let votingTimeout = null;
function generateVoteCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

if (fs.existsSync(DB_FILE)) {
    try { 
        const loadedData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        dbData = { ...dbData, ...loadedData };
        dbData.songQueue = dbData.songQueue.map(song => { if (!song.voteCode) song.voteCode = generateVoteCode(); return song; });
    } catch (e) { console.log("DB initialisiert."); }
}
function saveToDB() { fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8'); }

const BASE_LIMIT_MINUTES = 90;
const EXTENSION_LIMIT_MINUTES = 30;
const FEEDBACK_BUFFER_SECONDS = 120;
const ADMIN_PASSWORD = "MONDO_STUDIO_CHEF_2026";

function getTotalTimeSeconds() {
    let total = 0;
    dbData.songQueue.forEach(song => { total += (parseInt(song.duration) || 0) + FEEDBACK_BUFFER_SECONDS; });
    return total;
}

function checkAdminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader === ADMIN_PASSWORD) next(); else res.status(401).json({ error: "Unbefugter Zugriff!" });
}

function getSwissDateString(d) {
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function processVotingResult() {
    const hits = dbData.songQueue.filter(s => s.isHit);
    if (hits.length === 0) { dbData.votingPhase = 'inactive'; dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = []; dbData.votingEndsAt = null; saveToDB(); return; }
    let maxVotes = -1; let tiedSongs = [];
    hits.forEach(song => {
        const v = dbData.votes[song.id] || 0;
        if (v > maxVotes) { maxVotes = v; tiedSongs = [song]; } else if (v === maxVotes) { tiedSongs.push(song); }
    });
    if (tiedSongs.length > 1) { dbData.votingPhase = 'tiebreak'; dbData.tiedSongs = tiedSongs.map(s => s.id); } 
    else if (tiedSongs.length === 1) { finalizeWinner(tiedSongs[0].id); return; }
    else { dbData.votingPhase = 'inactive'; }
    dbData.votingEndsAt = null; saveToDB();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const baseMaxSeconds = (BASE_LIMIT_MINUTES + dbData.extraTimeMinutes) * 60;
    const extensionMaxSeconds = (BASE_LIMIT_MINUTES + dbData.extraTimeMinutes + EXTENSION_LIMIT_MINUTES) * 60;
    let phase = 'base';
    let currentMaxSeconds = baseMaxSeconds;

    if (!dbData.extensionActive) {
        if (totalSeconds < baseMaxSeconds) { phase = 'base'; currentMaxSeconds = baseMaxSeconds; } 
        else { phase = 'base_full'; currentMaxSeconds = baseMaxSeconds; }
    } else {
        if (totalSeconds < extensionMaxSeconds) { phase = 'extension'; currentMaxSeconds = extensionMaxSeconds; } 
        else { phase = 'extension_full'; currentMaxSeconds = extensionMaxSeconds; }
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
        return { id: song.id, artist: song.artist, title: song.title, duration: song.duration, genre: song.genre, songLink: song.songLink, isHit: song.isHit, isDone: song.isDone, platform };
    });

    res.json({
        queue: processedQueue,
        spentFormatted: spentFormatted,
        phase: phase,
        extensionActive: dbData.extensionActive === true,
        votingPhase: dbData.votingPhase,
        votingRemainingSeconds: votingRemainingSeconds,
        hallOfFame: dbData.hallOfFame,
        historicalHits: dbData.historicalHits,
        systemOnline: dbData.systemOnline !== false
    });
});

app.post('/api/submit', (req, res) => {
    const { artist, title, duration, genre, songLink } = req.body;
    const newCode = generateVoteCode();
    const newSong = { id: "S-" + Date.now().toString(36), voteCode: newCode, artist, title, duration: parseInt(duration) || 0, genre, songLink, isHit: false, isDone: false, timestamp: Date.now() };
    dbData.songQueue.push(newSong); saveToDB(); res.json({ success: true, voteCode: newCode });
});

app.post('/api/vote', (req, res) => {
    const { voteCode, vote1, vote2 } = req.body;
    const codeUpper = voteCode.trim().toUpperCase();
    const voterSong = dbData.songQueue.find(s => s.voteCode === codeUpper);
    if (!voterSong || dbData.usedCodes[codeUpper] || vote1 === vote2) return res.status(400).json({ error: "Fehler beim Voting!" });
    dbData.votes[vote1] = (dbData.votes[vote1] || 0) + 1;
    dbData.votes[vote2] = (dbData.votes[vote2] || 0) + 1;
    dbData.usedCodes[codeUpper] = true;
    saveToDB(); res.json({ success: true });
});

// STRIPE CHECKOUT ROUTE
app.post('/api/checkout/priority', async (req, res) => {
    const { artist } = req.body;
    const session = await stripe.checkout.sessions.create({
        line_items: [{ price_data: { currency: 'chf', product_data: { name: 'Priority Boost' }, unit_amount: 620 }, quantity: 1 }],
        mode: 'payment',
        success_url: `${req.headers.origin}/`,
        cancel_url: `${req.headers.origin}/`,
        metadata: { action: 'priority_boost', artistLower: artist.toLowerCase() }
    });
    res.json({ url: session.url });
});

// ... (Rest deiner Admin-Funktionen wie gehabt)
app.listen(PORT, () => { console.log(`🚀 RUNNING ON PORT ${PORT}`); });
