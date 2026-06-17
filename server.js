const express = require('express');
const app = express();
const path = require('path');
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

let songQueue = [];

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/queue', (req, res) => {
    res.json(songQueue);
});

app.post('/api/submit', (req, res) => {
    const { artist, title, duration, genre, songLink } = req.body;
    if (["Schlager", "Hardstyle", "Hardcore", "Metal"].includes(genre)) {
        return res.status(400).json({ error: "Genre blockiert!" });
    }
    // isDone: false bedeutet, der Song ist neu in der Warteliste
    songQueue.push({ artist, title, duration: parseInt(duration), genre, songLink, isHit: false, isDone: false });
    console.log(`🎵 Song eingereicht: ${artist} - ${title}`);
    res.json({ success: true });
});

app.post('/api/queue/:index/hit', (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < songQueue.length) {
        songQueue[index].isHit = !songQueue[index].isHit;
        res.json({ success: true, isHit: songQueue[index].isHit });
    } else {
        res.status(400).json({ error: "Ungültiger Index" });
    }
});

// NEU GEÄNDERT: Löscht den Song nicht mehr, sondern markiert ihn als erledigt!
app.post('/api/queue/:index/done', (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < songQueue.length) {
        songQueue[index].isDone = !songQueue[index].isDone; // Schaltet erledigt ein/aus
        console.log(`✅ Song Status geändert (Erledigt): ${songQueue[index].artist} - ${songQueue[index].title}`);
        res.json({ success: true, isDone: songQueue[index].isDone });
    } else {
        res.status(400).json({ error: "Ungültiger Index" });
    }
});

app.post('/api/queue/reset', (req, res) => {
    songQueue = [];
    console.log(`🧹 Warteliste komplett zurückgesetzt!`);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log("==================================================");
    console.log(`🚀 MONDO MANDO STUDIO SERVER LÄUFT!`);
    console.log(`💻 Zuschauer-Link: http://localhost:${PORT}`);
    console.log(`👑 Admin-Link: http://localhost:${PORT}/admin`);
    console.log("==================================================");
});
