CREATE TABLE users (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 key_hash TEXT NOT NULL UNIQUE,
 key_version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
CREATE TABLE user_videos (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
 added_at INTEGER NOT NULL,
 PRIMARY KEY(user_id, video_id)
);
CREATE TABLE playlists (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(id,user_id)
);
CREATE TABLE playlist_items (
 playlist_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 video_id TEXT NOT NULL,
 position INTEGER NOT NULL,
 PRIMARY KEY(playlist_id,video_id),
 FOREIGN KEY(playlist_id,user_id) REFERENCES playlists(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,video_id) REFERENCES user_videos(user_id,video_id) ON DELETE CASCADE
);
CREATE TABLE playback_tickets (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 video_id TEXT NOT NULL,
 key_version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 FOREIGN KEY(user_id,video_id) REFERENCES user_videos(user_id,video_id) ON DELETE CASCADE
);
CREATE INDEX tickets_expiry ON playback_tickets(expires_at);
