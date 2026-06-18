const express = require('express');
const app = express();
const path = require('path');
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

let songQueue = [];

// --- CONFIG FÜR STREAM-ZEIT-RECHNER ---
const MAX_STREAM_TIME_MINUTES = 90;
const FEEDBACK_BUFFER_SECONDS = 120; // 2 Minuten Feedback pro Song

// Hilfsfunktion: Berechnet die aktuelle Gesamtzeit aller Songs inklusive Feedback
function getTotalTimeSeconds() {
    let total = 0;
    songQueue.forEach(song => {
        total += (parseInt(song.duration) || 0) + FEEDBACK_BUFFER_SECONDS;
    });
    return total;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Schickt die Songs verpackt PLUS die sekundengenauen Berechnungen
app.get('/api/queue', (req, res) => {
    const totalSeconds = getTotalTimeSeconds();
    const maxSeconds = MAX_STREAM_TIME_MINUTES * 60; // 5400 Sekunden (90 Min)
    const remainingSecondsTotal = Math.max(0, maxSeconds - totalSeconds);
    
    // Berechne verbleibende Minuten und Sekunden fürs Runterzählen (Zuschauer)
    const remMinutes = Math.floor(remainingSecondsTotal / 60);
    const remSeconds = remainingSecondsTotal % 60;
    
    // Berechne bereits verplante Zeit fürs Hochzählen (Admin & Zuschauer)
    const spentMinutes = Math.floor(totalSeconds / 60);
    const spentSeconds = totalSeconds % 60;
    
    res.json({
        queue: songQueue,
        remainingMinutes: remMinutes,
        remainingSeconds: remSeconds,
        remainingSecondsTotal: remainingSecondsTotal,
        spentFormatted: `${spentMinutes} Min. ${spentSeconds < 10 ? '0' : ''}${spentSeconds} Sek.`,
        submissionsOpen: totalSeconds < maxSeconds
    });
});

// Prüft vor dem Speichern Zeitlimit, Genresperre UND das neue 2-Song-Limit pro Künstler
app.post('/api/submit', (req, res) => {
    const { artist, title, duration, genre, songLink } = req.body;
    
    // 1. Zeitprüfung: Ist im 90-Minuten-Topf noch Platz?
    const totalSeconds = getTotalTimeSeconds();
    const maxSeconds = MAX_STREAM_TIME_MINUTES * 60;
    if (totalSeconds >= maxSeconds) {
        return res.status(400).json({ error: "Das Limit von 90 Minuten Stream-Zeit ist erreicht! Keine weiteren Einreichungen möglich." });
    }

    // 2. Genresperre prüfen
    if (["Schlager", "Hardstyle", "Hardcore", "Metal"].includes(genre)) {
        return res.status(400).json({ error: "Genre blockiert!" });
    }
    
    // 3. NEU: 2-Song-Limit pro Künstler prüfen (Zählt nur aktive/unbewertete Songs)
    if (artist) {
        const cleanArtistName = artist.trim().toLowerCase();
        const activeSongsFromArtist = songQueue.filter(song => !song.isDone && song.artist.trim().toLowerCase() === cleanArtistName);
        
        if (activeSongsFromArtist.length >= 2) {
            return res.status(400).json({ error: "Du hast bereits 2 aktive Songs in der Warteliste eingereicht!" });
        }
    }
    
    // duration wird als Integer (Gesamtsekunden) gespeichert
    songQueue.push({ 
        artist: artist ? artist.trim() : "Unbekannt", 
        title: title ? title.trim() : "Kein Titel", 
        duration: parseInt(duration) || 0, 
        genre, 
        songLink, 
        isHit: false, 
        isDone: false,
        status: "" // NEU: Feld für die erweiterten Admin-Urteile ('potenzial', 'edit', 'taste')
    });
    
    console.log(`🎵 Song eingereicht: ${artist} - ${title} (${duration} Sek. + 2 Min. Feedback)`);
    res.json({ success: true });
});

// Beibehalten für direkte Kompatibilität oder direkten Hit-Toggle
app.post('/api/queue/:index/hit', (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < songQueue.length) {
        songQueue[index].isHit = !songQueue[index].isHit;
        // Synchronisiere den Text-Status mit dem Boolean-Wert
        songQueue[index].status = songQueue[index].isHit ? "hit" : "";
        res.json({ success: true, isHit: songQueue[index].isHit });
    } else {
        res.status(400).json({ error: "Ungültiger Index" });
    }
});

// NEU: API-Endpunkt für die erweiterten Admin-Bewertungen (potenzial, edit, taste)
app.post('/api/queue/:index/status', (req, res) => {
    const index = parseInt(req.params.index);
    const { status } = req.body;
    
    if (index >= 0 && index < songQueue.length) {
        // Status setzen (Wenn der geklickte Status schon aktiv war, wird er zurückgesetzt)
        if (songQueue[index].status === status) {
            songQueue[index].status = "";
        } else {
            songQueue[index].status = status;
        }
        
        // Playlist-Hit Boolean 'isHit' automatisch synchronisieren
        songQueue[index].isHit = (songQueue[index].status === "hit");
        
        console.log(`⭐ Urteil aktualisiert für: ${songQueue[index].artist} -> Status: ${songQueue[index].status || 'Keiner'}`);
        res.json({ success: true, currentStatus: songQueue[index].status });
    } else {
        res.status(400).json({ error: "Ungültiger Index" });
    }
});

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
