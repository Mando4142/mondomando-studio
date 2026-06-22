const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// --- DATEN-FUNDAMENT ---
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
    allowedFroschUser: "",
    allowedDjUser: ""
};

if (fs.existsSync(DB_FILE)) {
    try { dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.log("DB initialisiert."); }
}

function saveToDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
}

const BASE_LIMIT_MINUTES = 90;
const MAX_OVERTIME_MINUTES = 30;
const FEEDBACK_BUFFER_SECONDS = 120;

// NEUES PASSWORT HIER HINTERLEGT
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
    if (authHeader === ADMIN_PASSWORD) { next(); } else { res.status(401).json({ error: "Unbefugter Zugriff!" }); }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/info', (req, res) => res.sendFile(path.join(__dirname, 'info.html')));

app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const allowedMinutes = BASE_LIMIT_MINUTES + dbData.extraTimeMinutes;
    const maxSeconds = allowedMinutes * 60;
    const remainingSecondsTotal = Math.max(0, maxSeconds - totalSeconds);
    
    const processedQueue = dbData.songQueue.map((song, idx) => {
        let platform = 'other';
        if (/spotify\.com/i.test(song.songLink)) platform = 'spotify';
        else if (/youtube\.com|youtu\.be/i.test(song.songLink)) platform = 'youtube';
        return { ...song, id: idx, platform };
    });

    res.json({
        queue: processedQueue,
        remainingMinutes: Math.floor(remainingSecondsTotal / 60),
        remainingSeconds: remainingSecondsTotal % 60,
        remainingSecondsTotal: remainingSecondsTotal,
        spentFormatted: `${Math.floor(totalSeconds / 60)} Min. ${totalSeconds % 60 < 10 ? '0' : ''}${totalSeconds % 60} Sek.`,
        submissionsOpen: totalSeconds < maxSeconds,
        overtimeOpen: dbData.extraTimeMinutes < MAX_OVERTIME_MINUTES,
        votingActive: dbData.votingActive,
        hallOfFame: dbData.hallOfFame
    });
});

app.post('/api/submit', (req, res) => {
    const { artist, title, duration, genre, songLink, isVipJoker } = req.body;
    const cleanArtist = artist.trim().toLowerCase();
    
    if (["Schlager", "Hardstyle", "Hardcore", "Metal"].includes(genre)) {
        return res.status(400).json({ error: "Dieses Genre verletzt Mondos Ohren!" });
    }

    const existingSongsCount = dbData.songQueue.filter(s => s.artist.trim().toLowerCase() === cleanArtist && !s.isDone).length;

    let hasDjPermission = (dbData.allowedDjUser !== "" && dbData.allowedDjUser.toLowerCase() === cleanArtist);
    let maxAllowedSongsForUser = hasDjPermission ? 3 : 2;

    if (existingSongsCount >= maxAllowedSongsForUser) {
        return res.status(400).json({ error: hasDjPermission ? "Du hast dein DJ-Set Limit von 3 Songs bereits erreicht!" : "Maximal 2 aktive Songs erlaubt! Gönn den anderen auch mal." });
    }

    const totalSeconds = getTotalTimeSeconds();
    const allowedMinutes = BASE_LIMIT_MINUTES + dbData.extraTimeMinutes;
    const maxSeconds = allowedMinutes * 60;

    let hasFroschPermission = (dbData.allowedFroschUser !== "" && dbData.allowedFroschUser.toLowerCase() === cleanArtist);
    
    if (totalSeconds >= maxSeconds && !isVipJoker && !hasFroschPermission) {
        return res.status(400).json({ error: "Die Show ist voll! Nur noch freigegebene Frosch-Tickets kommen rein." });
    }

    let jokerApplied = false;
    if (isVipJoker) {
        if (dbData.usedJokers.includes(cleanArtist)) {
            return res.status(400).json({ error: "Du hast deinen Stammzuschauer-Joker diesen Monat bereits eingelöst!" });
        }
        dbData.usedJokers.push(cleanArtist);
        jokerApplied = true;
    }

    const newSong = {
        artist: artist.trim(), title: title.trim(), duration: parseInt(duration) || 0, genre, songLink,
        status: '', isHit: false, isDone: false, isJoker: jokerApplied, timestamp: Date.now()
    };

    if (jokerApplied || hasFroschPermission) {
        const currentActiveIndex = dbData.songQueue.findIndex(s => !s.isDone);
        if (currentActiveIndex === -1) {
            dbData.songQueue.push(newSong);
        } else {
            dbData.songQueue.splice(currentActiveIndex + 1, 0, newSong);
        }
        if (hasFroschPermission) dbData.allowedFroschUser = ""; 
    } else {
        dbData.songQueue.push(newSong);
    }

    if (hasDjPermission && (existingSongsCount + 1) === 3) {
        dbData.allowedDjUser = "";
    }

    saveToDB();
    res.json({ success: true });
});

// --- ADMIN ENDPOINTS ---
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) res.json({ success: true }); else res.status(401).json({ error: "Falsches Passwort!" });
});

app.post('/api/admin/set-coin-user', checkAdminAuth, (req, res) => {
    const { type, username } = req.body;
    const cleanName = username.trim();
    
    if (type === 'frosch') {
        dbData.allowedFroschUser = cleanName;
        dbData.extraTimeMinutes = Math.min(dbData.extraTimeMinutes + 10, MAX_OVERTIME_MINUTES);
        dbData.overtimeActive = true;
    }
    if (type === 'dj') {
        dbData.allowedDjUser = cleanName;
    }
    saveToDB();
    res.json({ success: true, allowedFrosch: dbData.allowedFroschUser, allowedDj: dbData.allowedDjUser });
});

app.post('/api/queue/:index/status', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    const { status } = req.body;
    if (dbData.songQueue[index]) {
        dbData.songQueue[index].status = status;
        dbData.songQueue[index].isHit = (status === 'hit');
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

app.delete('/api/admin/hof/:index', checkAdminAuth, (req, res) => {
    const index = parseInt(req.params.index);
    if (dbData.hallOfFame && dbData.hallOfFame[index]) {
        dbData.hallOfFame.splice(index, 1);
        saveToDB();
        res.json({ success: true });
    } else {
        res.status(400).json({ error: "Hall of Fame Index Fehler" });
    }
});

app.post('/api/admin/voting', checkAdminAuth, (req, res) => {
    dbData.votingActive = !dbData.votingActive;
    if (!dbData.votingActive) {
        let winnerIndex = -1; let maxVotes = -1;
        Object.keys(dbData.votes).forEach(idx => {
            if (dbData.votes[idx] > maxVotes) { maxVotes = dbData.votes[idx]; winnerIndex = parseInt(idx); }
        });
        if (winnerIndex !== -1 && dbData.songQueue[winnerIndex] && maxVotes > 0) {
            const champ = dbData.songQueue[winnerIndex];
            dbData.hallOfFame.push({ artist: champ.artist, title: champ.title, votes: maxVotes, date: new Date().toLocaleDateString('de-CH') });
        }
    } else { dbData.votes = {}; }
    saveToDB();
    res.json({ success: true, votingActive: dbData.votingActive });
});

app.post('/api/queue/:index/vote', (req, res) => {
    if (!dbData.votingActive) return res.status(400).json({ error: "Voting geschlossen!" });
    const index = parseInt(req.params.index);
    dbData.votes[index] = (dbData.votes[index] || 0) + 1;
    saveToDB();
    res.json({ success: true });
});

app.post('/api/queue/reset', checkAdminAuth, (req, res) => {
    dbData.songQueue = []; dbData.votes = {}; dbData.votingActive = false; dbData.extraTimeMinutes = 0; dbData.overtimeActive = false; dbData.allowedFroschUser = ""; dbData.allowedDjUser = "";
    saveToDB();
    res.json({ success: true });
});

app.listen(PORT, () => { console.log(`🚀 MONDO MANDO STUDIO SERVER LÄUFT AUF PORT ${PORT}`); });
