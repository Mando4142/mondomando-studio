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
    usedJokers: [],
    overtimeActive: false,
    extraTimeMinutes: 0,
    tripleSongUnlocked: false,
    votingActive: false,
    votes: {},
    hallOfFame: [],
    systemOnline: true // Master-Schalter Startwert
};

if (fs.existsSync(DB_FILE)) {
    try { 
        const loadedData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
        dbData = { ...dbData, ...loadedData };
    } catch (e) { console.log("DB initialisiert."); }
}

function saveToDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
}

const BASE_LIMIT_MINUTES = 90;
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/regeln', (req, res) => res.sendFile(path.join(__dirname, 'regeln.html')));

app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const allowedMinutes = BASE_LIMIT_MINUTES + dbData.extraTimeMinutes;
    const maxSeconds = allowedMinutes * 60;
    const remainingSecondsTotal = Math.max(0, maxSeconds - totalSeconds);
    
    const processedQueue = dbData.songQueue.map(song => {
        let platform = 'other';
        if (/spotify\.com/i.test(song.songLink)) platform = 'spotify';
        else if (/youtube\.com|youtu\.be/i.test(song.songLink)) platform = 'youtube';
        return { ...song, platform };
    });

    res.json({
        queue: processedQueue,
        remainingMinutes: Math.floor(remainingSecondsTotal / 60),
        remainingSeconds: remainingSecondsTotal % 60,
        remainingSecondsTotal: remainingSecondsTotal,
        submissionsOpen: totalSeconds < maxSeconds,
        overtimeActive: dbData.overtimeActive,
        maxMinutesAllowed: allowedMinutes,
        votingActive: dbData.votingActive,
        votes: dbData.votes,
        hallOfFame: dbData.hallOfFame,
        systemOnline: dbData.systemOnline !== false // Gibt Status an Frontends
    });
});

app.post('/api/submit', (req, res) => {
    // Sofort blockieren, wenn Offline
    if (dbData.systemOnline === false) {
        return res.status(400).json({ error: "Das Einreicheformular ist aktuell offline!" });
    }

    const { artist, title, duration, genre, songLink, isJoker } = req.body;
    
    if (["Schlager", "Hardstyle", "Hardcore", "Metal"].includes(genre)) {
        return res.status(400).json({ error: "Dieses Genre verletzt Mondos Ohren!" });
    }

    const totalSeconds = getTotalTimeSeconds();
    const allowedMinutes = BASE_LIMIT_MINUTES + dbData.extraTimeMinutes;
    const maxSeconds = allowedMinutes * 60;

    if (totalSeconds >= maxSeconds && !isJoker) {
        return res.status(400).json({ error: "Das Sendezeit-Limit dieser Show ist komplett erreicht!" });
    }

    let jokerApplied = false;
    if (isJoker) {
        const cleanUser = artist.trim().toLowerCase();
        if (dbData.usedJokers.includes(cleanUser)) {
            return res.status(400).json({ error: "Du hast deinen Stammzuschauer-Joker diesen Monat bereits eingelöst!" });
        }
        dbData.usedJokers.push(cleanUser);
        jokerApplied = true;
    }

    const newSong = {
        artist, title, duration: parseInt(duration) || 0, genre, songLink,
        isHit: false, isDone: false, isJoker: jokerApplied, timestamp: Date.now()
    };

    if (jokerApplied) {
        const currentActiveIndex = dbData.songQueue.findIndex(s => !s.isDone);
        if (currentActiveIndex === -1) {
            dbData.songQueue.push(newSong);
        } else {
            dbData.songQueue.splice(currentActiveIndex + 1, 0, newSong);
        }
    } else {
        dbData.songQueue.push(newSong);
    }

    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/auth', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) res.json({ success: true });
    else res.status(401).json({ error: "Falsches Passwort!" });
});

// NEU: Route nimmt gezielt "Online" oder "Offline" an
app.post('/api/admin/set-system-status', checkAdminAuth, (req, res) => {
    const { online } = req.body;
    dbData.systemOnline = !!online; // Setzt gezielt auf true oder false
    saveToDB();
    res.json({ success: true, systemOnline: dbData.systemOnline });
});

app.post('/api/queue/:index/hit', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) {
        dbData.songQueue[index].isHit = !dbData.songQueue[index].isHit;
        saveToDB();
        res.json({ success: true });
    } else res.status(400).json({ error: "Index Fehler" });
});

app.post('/api/queue/:index/done', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) {
        dbData.songQueue[index].isDone = !dbData.songQueue[index].isDone;
        saveToDB();
        res.json({ success: true });
    } else res.status(400).json({ error: "Index Fehler" });
});

app.delete('/api/queue/:index', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.songQueue[index]) {
        dbData.songQueue.splice(index, 1);
        saveToDB();
        res.json({ success: true });
    } else res.status(400).json({ error: "Index Fehler" });
});

app.post('/api/admin/overtime', checkAdminAuth, (req, res) => {
    const { minutes } = req.body;
    dbData.extraTimeMinutes = (dbData.extraTimeMinutes || 0) + (parseFloat(minutes) || 0);
    dbData.overtimeActive = dbData.extraTimeMinutes > 0;
    saveToDB();
    res.json({ success: true, maxMinutesAllowed: BASE_LIMIT_MINUTES + dbData.extraTimeMinutes });
});

app.post('/api/admin/toggle-voting', checkAdminAuth, (req, res) => {
    dbData.votingActive = !dbData.votingActive;
    if (dbData.votingActive) dbData.votes = {};
    saveToDB();
    res.json({ success: true, votingActive: dbData.votingActive });
});

app.post('/api/vote', (req, res) => {
    if (!dbData.votingActive) return res.status(400).json({ error: "Voting geschlossen!" });
    const { songIndex } = req.body;
    dbData.votes[songIndex] = (dbData.votes[songIndex] || 0) + 1;
    saveToDB();
    res.json({ success: true });
});

app.post('/api/admin/close-voting-champion', checkAdminAuth, (req, res) => {
    dbData.votingActive = false;
    let winnerIndex = -1; let maxVotes = -1;
    Object.keys(dbData.votes).forEach(idx => {
        if (dbData.votes[idx] > maxVotes) { maxVotes = dbData.votes[idx]; winnerIndex = parseInt(idx); }
    });
    if (winnerIndex !== -1 && dbData.songQueue[winnerIndex]) {
        const champ = dbData.songQueue[winnerIndex];
        dbData.hallOfFame.push({ artist: champ.artist, title: champ.title, votes: maxVotes, date: new Date().toLocaleDateString('de-CH') });
    }
    saveToDB();
    res.json({ success: true, hallOfFame: dbData.hallOfFame });
});

app.delete('/api/admin/halloffame/:index', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.hallOfFame && dbData.hallOfFame[index]) {
        dbData.hallOfFame.splice(index, 1);
        saveToDB();
        res.json({ success: true, hallOfFame: dbData.hallOfFame });
    } else {
        res.status(400).json({ error: "Champion Index nicht gefunden" });
    }
});

app.post('/api/queue/reset', checkAdminAuth, (req, res) => {
    dbData.songQueue = []; dbData.votes = {}; dbData.votingActive = false;
    saveToDB();
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`🚀 MONDO MANDO RECORDS RUNNING ON PORT ${PORT}`); });
