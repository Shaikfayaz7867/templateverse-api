const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Seed data
const defaultVideos = [];

// In-memory fallback stores
const memoryStore = {
  users: [],
  videos: [...defaultVideos],
  requests: []
};

let pool = null;
let usePostgres = false;

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL && !DATABASE_URL.includes("YOUR_") && !DATABASE_URL.includes("localhost")) {
  // If a valid non-default Postgres connection string is provided, attempt connection
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    usePostgres = true;
  } catch (err) {
    console.error("Failed to construct PostgreSQL Pool:", err.message);
    usePostgres = false;
  }
} else {
  // If using local/default URL, attempt it but support immediate fallback if local Postgres service isn't active
  try {
    pool = new Pool({
      connectionString: DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/templateverse'
    });
    usePostgres = true;
  } catch (err) {
    usePostgres = false;
  }
}

// SQL schema scripts
const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS videos (
    id VARCHAR(100) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    video_url TEXT NOT NULL,
    thumbnail_url TEXT,
    username VARCHAR(100) NOT NULL,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    tags TEXT[],
    upload_date VARCHAR(20) NOT NULL,
    likes_count INT DEFAULT 0,
    downloads_count INT DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS requests (
    id VARCHAR(100) PRIMARY KEY,
    movie_name VARCHAR(255) NOT NULL,
    actor_name VARCHAR(255) NOT NULL,
    scene_name VARCHAR(255) NOT NULL,
    dialogue TEXT NOT NULL,
    description TEXT,
    request_date VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'Pending'
  );
`;

// Initialize database schema and seed data
async function initDb() {
  if (!usePostgres) {
    console.log("⚠️  PostgreSQL is not configured or offline. Falling back to local in-memory storage.");
    return;
  }

  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    
    // Auto-migrate tables
    await pool.query(CREATE_TABLES_SQL);
    console.log("✅ PostgreSQL schema tables initialized successfully.");

    // Delete any pre-existing dummy seed data if they exist in Postgres database
    await pool.query("DELETE FROM videos WHERE id IN ('vid_1', 'vid_2', 'vid_3', 'vid_4', 'vid_5')");
    console.log("🧹 Pre-existing dummy seed videos deleted from PostgreSQL database.");

    // Seed default videos if table is empty
    const checkVideos = await pool.query('SELECT COUNT(*) FROM videos');
    if (parseInt(checkVideos.rows[0].count, 10) === 0) {
      for (const v of defaultVideos) {
        await pool.query(
          `INSERT INTO videos (id, title, video_url, thumbnail_url, username, category, description, tags, upload_date, likes_count, downloads_count) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [v.id, v.title, v.videoUrl, v.thumbnailUrl, v.username, v.category, v.description, v.tags, v.uploadDate, v.likesCount, v.downloadsCount]
        );
      }
      console.log("🌱 Default videos successfully seeded to PostgreSQL.");
    }
  } catch (err) {
    console.error("❌ PostgreSQL connection/migration failed:", err.message);
    console.log("⚠️  Falling back to local in-memory storage for execution.");
    usePostgres = false;
  }
}

// Call init during startup
initDb();

module.exports = {
  initDb,
  
  getUsers: async () => {
    if (usePostgres) {
      const res = await pool.query('SELECT * FROM users');
      return res.rows.map(row => ({
        username: row.username,
        name: row.name,
        email: row.email,
        avatarUrl: row.avatar_url
      }));
    }
    return memoryStore.users;
  },

  saveUser: async (user) => {
    if (usePostgres) {
      await pool.query(
        'INSERT INTO users (username, name, email, avatar_url) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
        [user.username, user.name, user.email, user.avatarUrl]
      );
    } else {
      memoryStore.users.push(user);
    }
  },

  getVideos: async () => {
    if (usePostgres) {
      const res = await pool.query('SELECT * FROM videos');
      return res.rows.map(row => ({
        id: row.id,
        title: row.title,
        videoUrl: row.video_url,
        thumbnailUrl: row.thumbnail_url,
        username: row.username,
        category: row.category,
        description: row.description,
        tags: row.tags || [],
        uploadDate: row.upload_date,
        likesCount: row.likes_count,
        downloadsCount: row.downloads_count
      }));
    }
    return memoryStore.videos;
  },

  saveVideo: async (video) => {
    if (usePostgres) {
      await pool.query(
        `INSERT INTO videos (id, title, video_url, thumbnail_url, username, category, description, tags, upload_date, likes_count, downloads_count) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [video.id, video.title, video.videoUrl, video.thumbnailUrl, video.username, video.category, video.description, video.tags, video.uploadDate, video.likesCount, video.downloadsCount]
      );
    } else {
      memoryStore.videos.unshift(video);
    }
  },

  getRequests: async () => {
    if (usePostgres) {
      const res = await pool.query('SELECT * FROM requests ORDER BY request_date DESC');
      return res.rows.map(row => ({
        id: row.id,
        movieName: row.movie_name,
        actorName: row.actor_name,
        sceneName: row.scene_name,
        dialogue: row.dialogue,
        description: row.description,
        requestDate: row.request_date,
        status: row.status
      }));
    }
    return memoryStore.requests;
  },

  saveRequest: async (request) => {
    if (usePostgres) {
      await pool.query(
        `INSERT INTO requests (id, movie_name, actor_name, scene_name, dialogue, description, request_date, status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [request.id, request.movieName, request.actorName, request.sceneName, request.dialogue, request.description, request.requestDate, request.status]
      );
    } else {
      memoryStore.requests.unshift(request);
    }
  }
};
