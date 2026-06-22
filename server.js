const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const DB_FILE = path.join(__dirname, 'database.json');
let dbData = {
    songQueue: [],
    extraTimeMinutes: 0,
    votingActive: false,
    votes: {}, 
    hallOfFame: [],
    historicalHits: {}, 
    systemOnline: true,
    extensionActive: false 
};

if (fs.existsSync(DB_FILE)) {
    try { 
        const loadedData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        dbData = { ...dbData, ...loadedData };
        if (!dbData.historicalHits) dbData.historicalHits = {}; 
    } catch (e) { console.log("DB initialisiert."); }
}

function saveToDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
}

const BASE_LIMIT_MINUTES = 90;
const EXTENSION_LIMIT_MINUTES = 30;
const FEEDBACK_BUFFER_SECONDS = 120;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Sutter1998!";

function getTotalTimeSeconds() {
    let total = 0;
    dbData.songQueue.forEach(song => {
        total += (parseInt(song.duration) || 0) + FEEDBACK_BUFFER_SECONDS;
    });
    return total;
}

function checkAdminAuth(req, res, next) {
    if (req.headers['authorization'] === ADMIN_PASSWORD) next();
    else res.status(401).json({ error: "Unbefugter Zugriff!" });
}

// API Endpoints
app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const baseMax = BASE_LIMIT_MINUTES * 60;
    const extMax = (BASE_LIMIT_MINUTES + EXTENSION_LIMIT_MINUTES) * 60;
    
    let phase = !dbData.extensionActive ? 'base' : 'extension';
    let currentMax = !dbData.extensionActive ? baseMax : extMax;
    if (totalSeconds >= currentMax) phase += '_full';

    const processedQueue = dbData.songQueue.map((song, i) => ({
        ...song,
        platform: /spotify\.com/i.test(song.songLink) ? 'spotify' : (/youtube\.com|youtu\.be/i.test(song.songLink) ? 'youtube' : 'other')
    }));

    res.json({
        queue: processedQueue,
        phase: phase,
        extensionActive: dbData.extensionActive,
        votingActive: dbData.votingActive,
        votes: dbData.votes,
        hallOfFame: dbData.hallOfFame,
        historicalHits: dbData.historicalHits,
        systemOnline: dbData.systemOnline,
        spentFormatted: `${Math.floor(totalSeconds / 60)} Min. ${totalSeconds % 60} Sek.`
    });
});

app.post('/api/vote', (req, res) => {
    if (!dbData.votingActive) return res.status(400).json({ error: "Voting geschlossen!" });
    
    const { songIndex, voterId } = req.body;
    if (!voterId) return res.status(400).json({ error: "Keine Identifikation möglich!" });
    if (!dbData.votes[songIndex]) dbData.votes[songIndex] = [];

    if (dbData.votes[songIndex].includes(voterId)) 
        return res.status(400).json({ error: "Du hast für diesen Song bereits abgestimmt!" });

    let totalVotesByUser = 0;
    Object.values(dbData.votes).forEach(list => { if (list.includes(voterId)) totalVotesByUser++; });

    if (totalVotesByUser >= 2) 
        return res.status(400).json({ error: "Du hast dein Maximum von 2 Stimmen erreicht!" });

    dbData.votes[songIndex].push(voterId);
    saveToDB();
    res.json({ success: true, count: dbData.votes[songIndex].length });
});

app.post('/api/submit', (req, res) => {
    if (!dbData.systemOnline) return res.status(400).json({ error: "System ist offline!" });
    dbData.songQueue.push({ ...req.body, isDone: false, isHit: false });
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/auth', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true });
    else res.status(401).json({ error: "Falsches Passwort!" });
});

app.post('/api/admin/reorder-active', checkAdminAuth, (req, res) => {
    const { oldIndex, newIndex } = req.body;
    const element = dbData.songQueue.splice(oldIndex, 1)[0];
    dbData.songQueue.splice(newIndex, 0, element);
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/toggle-extension', checkAdminAuth, (req, res) => {
    dbData.extensionActive = !dbData.extensionActive;
    saveToDB();
    res.json({ extensionActive: dbData.extensionActive });
});

app.post('/api/admin/set-system-status', checkAdminAuth, (req, res) => {
    dbData.systemOnline = req.body.online;
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/overtime', checkAdminAuth, (req, res) => {
    dbData.extraTimeMinutes += (req.body.minutes || 0);
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/toggle-voting', checkAdminAuth, (req, res) => {
    dbData.votingActive = !dbData.votingActive;
    if (!dbData.votingActive) dbData.votes = {}; 
    saveToDB();
    res.json({ success: true });
});

app.post('/api/queue/:index/hit', checkAdminAuth, (req, res) => {
    dbData.songQueue[req.params.index].isHit = !dbData.songQueue[req.params.index].isHit;
    saveToDB();
    res.json({ success: true });
});

app.post('/api/queue/:index/done', checkAdminAuth, (req, res) => {
    dbData.songQueue[req.params.index].isDone = !dbData.songQueue[req.params.index].isDone;
    saveToDB();
    res.json({ success: true });
});

app.delete('/api/queue/:index', checkAdminAuth, (req, res) => {
    dbData.songQueue.splice(req.params.index, 1);
    saveToDB();
    res.json({ success: true });
});

app.post('/api/queue/reset', checkAdminAuth, (req, res) => {
    dbData.songQueue = [];
    dbData.votes = {};
    saveToDB();
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`🚀 MONDO MANDO RECORDS RUNNING ON PORT ${PORT}`); });
