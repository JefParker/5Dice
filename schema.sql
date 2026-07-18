CREATE TABLE IF NOT EXISTS YahtzeeScore (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    score TEXT,
    ip TEXT,
    lastdataset DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room, player_id)
);
