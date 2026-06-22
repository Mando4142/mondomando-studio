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

// Datenbank laden
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
const ADMIN_PASSWORD = "MONDO_STUDIO_CHEF_2026";

function getTotalTimeSeconds() {
    let total = 0;
    dbData.songQueue.forEach(song => {
        total += (parseInt(song.duration) || 0) + FEEDBACK_BUFFER_SECONDS;
    });
    return total;
}

function checkAdminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader === ADMIN_PASSWORD) {
        next();
    } else {
        res.status(401).json({ error: "Unbefugter Zugriff!" });
    }
}

// API Endpunkte
app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const baseMaxSeconds = BASE_LIMIT_MINUTES * 60;
    const extensionMaxSeconds = (BASE_LIMIT_MINUTES + EXTENSION_LIMIT_MINUTES) * 60;
    
    let phase = !dbData.extensionActive ? (totalSeconds < baseMaxSeconds ? 'base' : 'base_full') : (totalSeconds < extensionMaxSeconds ? 'extension' : 'extension_full');
    let currentMaxSeconds = dbData.extensionActive ? extensionMaxSeconds : baseMaxSeconds;
    const remainingSecondsTotal = Math.max(0, currentMaxSeconds - totalSeconds);
    
    res.json({
        queue: dbData.songQueue.map(s => ({...s, platform: /spotify\.com/i.test(s.songLink) ? 'spotify' : (/youtube\.com|youtu\.be/i.test(s.songLink) ? 'youtube' : 'other')})),
        remainingMinutes: Math.floor(remainingSecondsTotal / 60),
        remainingSeconds: remainingSecondsTotal % 60,
        submissionsOpen: (!dbData.extensionActive && totalSeconds < baseMaxSeconds) || (dbData.extensionActive && totalSeconds < extensionMaxSeconds),
        phase: phase,
        extensionActive: dbData.extensionActive,
        votingActive: dbData.votingActive,
        votes: dbData.votes,
        hallOfFame: dbData.hallOfFame,
        historicalHits: dbData.historicalHits,
        systemOnline: dbData.systemOnline !== false
    });
});

app.post('/api/submit', (req, res) => {
    if (dbData.systemOnline === false) return res.status(400).json({ error: "System offline!" });
    const { artist, title, duration, genre, songLink } = req.body;
    
    if (!/spotify\.com/i.test(songLink) && !/youtube\.com|youtu\.be/i.test(songLink)) return res.status(400).json({ error: "Nur Spotify/YouTube Links!" });
    if (dbData.songQueue.some(s => s.songLink.trim().toLowerCase() === songLink.trim().toLowerCase())) return res.status(400).json({ error: "Song schon in Liste!" });
    if (["Schlager", "Hardstyle", "Hardcore", "Metal"].includes(genre)) return res.status(400).json({ error: "Dieses Genre verletzt Mondos Ohren!" });
    
    const cleanArtist = artist.trim().toLowerCase();
    if (cleanArtist !== "mondo mando" && cleanArtist !== "mondo" && dbData.songQueue.some(s => s.artist.trim().toLowerCase() === cleanArtist)) return res.status(400).json({ error: "Nur 1 Song pro Künstler erlaubt!" });

    const totalSeconds = getTotalTimeSeconds();
    if ((!dbData.extensionActive && totalSeconds >= BASE_LIMIT_MINUTES * 60) || (dbData.extensionActive && totalSeconds >= (BASE_LIMIT_MINUTES + EXTENSION_LIMIT_MINUTES) * 60)) return res.status(400).json({ error: "Zeit-Limit erreicht!" });

    dbData.songQueue.push({ artist, title, duration: parseInt(duration) || 0, genre, songLink, isHit: false, isDone: false, timestamp: Date.now() });
    saveToDB(); res.json({ success: true });
});

// Admin-Endpunkte
app.post('/api/admin/auth', (req, res) => { if (req.body.password === ADMIN_PASSWORD) res.json({ success: true }); else res.status(401).json({ error: "Falsch!" }); });
app.post('/api/admin/set-system-status', checkAdminAuth, (req, res) => { dbData.systemOnline = !!req.body.online; saveToDB(); res.json({ success: true }); });
app.post('/api/admin/toggle-extension', checkAdminAuth, (req, res) => { dbData.extensionActive = !dbData.extensionActive; saveToDB(); res.json({ extensionActive: dbData.extensionActive }); });
app.post('/api/admin/reorder-active', checkAdminAuth, (req, res) => {
    let active = dbData.songQueue.filter(s => !s.isDone); let done = dbData.songQueue.filter(s => s.isDone);
    const [moved] = active.splice(req.body.oldIndex, 1); active.splice(req.body.newIndex, 0, moved);
    dbData.songQueue = [...done, ...active]; saveToDB(); res.json({ success: true });
});
app.post('/api/queue/:index/hit', checkAdminAuth, (req, res) => {
    dbData.songQueue[parseInt(req.params.index)].isHit = !dbData.songQueue[parseInt(req.params.index)].isHit;
    saveToDB(); res.json({ success: true });
});
app.post('/api/queue/:index/done', checkAdminAuth, (req, res) => { dbData.songQueue[parseInt(req.params.index)].isDone = !dbData.songQueue[parseInt(req.params.index)].isDone; saveToDB(); res.json({ success: true }); });
app.delete('/api/queue/:index', checkAdminAuth, (req, res) => { dbData.songQueue.splice(parseInt(req.params.index), 1); saveToDB(); res.json({ success: true }); });
app.post('/api/admin/overtime', checkAdminAuth, (req, res) => { dbData.extraTimeMinutes += (parseFloat(req.body.minutes) || 0); saveToDB(); res.json({ success: true }); });
app.post('/api/queue/reset', checkAdminAuth, (req, res) => { dbData.songQueue = []; dbData.extensionActive = false; saveToDB(); res.json({ success: true }); });

app.listen(PORT, () => { console.log(`🚀 Server läuft auf ${PORT}`); });
