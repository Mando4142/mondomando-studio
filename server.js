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
    votingPhase: 'inactive', // 'inactive', 'active', 'tiebreak'
    votes: {},
    usedCodes: {},
    tiedSongs: [],
    hallOfFame: [],
    historicalHits: {}, 
    systemOnline: true,
    extensionActive: false
};

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
        
        // MIGRATION: Allen alten Songs IDs und Voting-Codes geben
        dbData.songQueue = dbData.songQueue.map(song => {
            if (!song.id) song.id = "S-" + Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
            if (!song.voteCode) song.voteCode = generateVoteCode();
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

function getSwissDateString(d) {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/regeln', (req, res) => res.sendFile(path.join(__dirname, 'regeln.html')));

app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const baseMaxSeconds = BASE_LIMIT_MINUTES * 60;
    const extensionMaxSeconds = (BASE_LIMIT_MINUTES + EXTENSION_LIMIT_MINUTES) * 60;
    
    let phase = 'base';
    let submissionsOpen = false;
    let currentMaxSeconds = baseMaxSeconds;

    if (!dbData.extensionActive) {
        if (totalSeconds < baseMaxSeconds) {
            phase = 'base'; submissionsOpen = true; currentMaxSeconds = baseMaxSeconds;
        } else {
            phase = 'base_full'; submissionsOpen = false; currentMaxSeconds = baseMaxSeconds;
        }
    } else {
        if (totalSeconds < extensionMaxSeconds) {
            phase = 'extension'; submissionsOpen = true; currentMaxSeconds = extensionMaxSeconds;
        } else {
            phase = 'extension_full'; submissionsOpen = false; currentMaxSeconds = extensionMaxSeconds;
        }
    }

    const remainingSecondsTotal = Math.max(0, currentMaxSeconds - totalSeconds);
    
    // Sende die Queue OHNE die geheimen Vote-Codes ans öffentliche Frontend!
    const processedQueue = dbData.songQueue.map(song => {
        let platform = 'other';
        if (/spotify\.com/i.test(song.songLink)) platform = 'spotify';
        else if (/youtube\.com|youtu\.be/i.test(song.songLink)) platform = 'youtube';
        
        return { 
            id: song.id, artist: song.artist, title: song.title, 
            duration: song.duration, genre: song.genre, songLink: song.songLink, 
            isHit: song.isHit, isDone: song.isDone, platform 
        };
    });

    let tiedSongsDetails = [];
    if (dbData.votingPhase === 'tiebreak' && dbData.tiedSongs) {
        tiedSongsDetails = dbData.tiedSongs.map(id => dbData.songQueue.find(s => s.id === id)).filter(Boolean);
    }

    res.json({
        queue: processedQueue,
        remainingMinutes: Math.floor(remainingSecondsTotal / 60),
        remainingSeconds: remainingSecondsTotal % 60,
        remainingSecondsTotal: remainingSecondsTotal,
        submissionsOpen: submissionsOpen,
        phase: phase,
        extensionActive: dbData.extensionActive === true,
        votingPhase: dbData.votingPhase,
        votes: dbData.votes,
        tiedSongs: tiedSongsDetails,
        hallOfFame: dbData.hallOfFame,
        historicalHits: dbData.historicalHits,
        systemOnline: dbData.systemOnline !== false
    });
});

app.post('/api/submit', (req, res) => {
    if (dbData.systemOnline === false) {
        return res.status(400).json({ error: "Das Einreicheformular ist aktuell offline!" });
    }

    const { artist, title, duration, genre, songLink } = req.body;
    
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
    const baseMaxSeconds = BASE_LIMIT_MINUTES * 60;
    const extensionMaxSeconds = (BASE_LIMIT_MINUTES + EXTENSION_LIMIT_MINUTES) * 60;

    if (!dbData.extensionActive && totalSeconds >= baseMaxSeconds) return res.status(400).json({ error: "Hauptzeit voll!" });
    if (dbData.extensionActive && totalSeconds >= extensionMaxSeconds) return res.status(400).json({ error: "Verlängerung komplett voll!" });

    const newCode = generateVoteCode();
    const newSong = {
        id: "S-" + Date.now().toString(36) + Math.random().toString(36).substring(2, 5),
        voteCode: newCode,
        artist, title, duration: parseInt(duration) || 0, genre, songLink,
        isHit: false, isDone: false, timestamp: Date.now()
    };

    dbData.songQueue.push(newSong);
    saveToDB();
    res.json({ success: true, voteCode: newCode }); // Gib den Code an den Client zurück
});

// --- NEUES VOTING SYSTEM ---

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
    dbData.votes = {};
    dbData.usedCodes = {};
    dbData.tiedSongs = [];
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/voting/resolve', checkAdminAuth, (req, res) => {
    const { forceWinnerId } = req.body;

    if (forceWinnerId) {
        finalizeWinner(forceWinnerId);
        return res.json({ success: true });
    }

    const hits = dbData.songQueue.filter(s => s.isHit);
    if (hits.length === 0) return res.status(400).json({ error: "Keine Hits für Auswertung!" });

    let maxVotes = -1;
    let tiedSongs = [];

    hits.forEach(song => {
        const v = dbData.votes[song.id] || 0;
        if (v > maxVotes) {
            maxVotes = v; tiedSongs = [song];
        } else if (v === maxVotes) {
            tiedSongs.push(song);
        }
    });

    if (tiedSongs.length > 1) {
        dbData.votingPhase = 'tiebreak';
        dbData.tiedSongs = tiedSongs.map(s => s.id);
        saveToDB();
        return res.json({ tiebreak: true });
    } else if (tiedSongs.length === 1) {
        finalizeWinner(tiedSongs[0].id);
        return res.json({ success: true });
    } else {
        return res.status(400).json({ error: "Fehler bei der Auswertung." });
    }
});

function finalizeWinner(songId) {
    const winner = dbData.songQueue.find(s => s.id === songId);
    if (winner) {
        const votes = dbData.votes[songId] || 0;
        dbData.hallOfFame.push({
            artist: winner.artist,
            title: winner.title,
            votes: votes,
            date: getSwissDateString(new Date())
        });
    }
    dbData.votingPhase = 'inactive';
    dbData.votes = {};
    dbData.usedCodes = {};
    dbData.tiedSongs = [];
    saveToDB();
}

// --- STANDARD ADMIN ROUTEN ---

app.post('/api/admin/auth', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) res.json({ success: true }); else res.status(401).json({ error: "Falsches Passwort!" });
});

app.post('/api/admin/set-system-status', checkAdminAuth, (req, res) => {
    const { online } = req.body;
    dbData.systemOnline = !!online; saveToDB(); res.json({ success: true });
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
            if (!exists) dbData.historicalHits[dateStr].push({ artist: song.artist, title: song.title, genre: song.genre });
        } else {
            dbData.historicalHits[dateStr] = dbData.historicalHits[dateStr].filter(s => !(s.artist === song.artist && s.title === song.title));
            if (dbData.historicalHits[dateStr].length === 0) delete dbData.historicalHits[dateStr];
        }
        saveToDB(); res.json({ success: true });
    } else res.status(400).json({ error: "Index Fehler" });
});

app.post('/api/queue/:index/done', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) {
        dbData.songQueue[index].isDone = !dbData.songQueue[index].isDone; saveToDB(); res.json({ success: true });
    } else res.status(400).json({ error: "Index Fehler" });
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
    if (dbData.hallOfFame && dbData.hallOfFame[index]) {
        dbData.hallOfFame.splice(index, 1); saveToDB(); res.json({ success: true });
    } else res.status(400).json({ error: "Champion nicht gefunden" });
});

app.post('/api/queue/reset', checkAdminAuth, (req, res) => {
    dbData.songQueue = []; dbData.votingPhase = 'inactive'; dbData.votes = {}; dbData.usedCodes = {}; dbData.tiedSongs = []; dbData.extensionActive = false;
    saveToDB(); res.json({ success: true });
});

app.listen(PORT, () => { console.log(`🚀 MONDO MANDO RECORDS RUNNING ON PORT ${PORT}`); });
