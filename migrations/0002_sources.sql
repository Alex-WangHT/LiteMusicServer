ALTER TABLE videos RENAME COLUMN youtube_id TO source_id;
ALTER TABLE videos ADD COLUMN platform TEXT NOT NULL DEFAULT 'youtube';
