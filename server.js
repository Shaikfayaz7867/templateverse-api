const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
require('dotenv').config();

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Setup local fallback directory
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Memory Storage holds the file in memory buffer so we can upload directly to Cloudflare R2
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // limit to 10MB
});

// Configure Cloudflare R2 S3 SDK Client
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

let s3Client = null;
let useR2 = false;

if (
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY &&
  !R2_ACCOUNT_ID.includes("YOUR_") && !R2_ACCESS_KEY_ID.includes("YOUR_")
) {
  try {
    s3Client = new S3Client({
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      region: 'auto',
    });
    useR2 = true;
    console.log("☁️  Cloudflare R2 integration successfully initialized.");
  } catch (err) {
    console.error("❌ Failed to initialize Cloudflare R2 Client:", err.message);
    useR2 = false;
  }
} else {
  console.log("⚠️  Cloudflare R2 parameters not configured. Falling back to local filesystem uploads.");
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Static serving for local uploads fallback
app.use('/uploads', express.static(UPLOADS_DIR));

// Fallback Unsplash Thumbnail Bank
const defaultThumbnails = [
  "https://images.unsplash.com/photo-1536440136628-849c177e76a1?q=80&w=300&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1485846234645-a62644f84728?q=80&w=300&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?q=80&w=300&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1478760329108-5c3ed9d495a0?q=80&w=300&auto=format&fit=crop",
  "https://images.unsplash.com/photo-1542751371-adc38448a05e?q=80&w=300&auto=format&fit=crop"
];

// Helper to resolve URLs dynamically based on request host
function resolveUrl(urlPath, req) {
  if (!urlPath) return "";
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    return urlPath;
  }
  const host = req.get('host');
  const protocol = req.protocol;
  const formattedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${protocol}://${host}${formattedPath}`;
}

// Format current date helper (YYYY-MM-DD)
function getFormattedDate() {
  const d = new Date();
  const month = '' + (d.getMonth() + 1);
  const day = '' + d.getDate();
  const year = d.getFullYear();
  return [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
}

// ---------------- API ENDPOINTS ----------------

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// Authentication: Login (Accepts any credentials dynamically)
app.post('/v1/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username) {
    return res.status(400).json({ success: false, message: "Username is required", data: null });
  }

  const users = await db.getUsers();
  let user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user) {
    // If user does not exist, automatically register them!
    user = {
      username: username,
      name: username.charAt(0).toUpperCase() + username.slice(1) + " (Guest)",
      email: `${username.toLowerCase()}@templateverse.com`,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`
    };
    await db.saveUser(user);
  }

  res.json({
    success: true,
    message: "Login successful",
    data: {
      accessToken: `token_${username}_${Date.now()}`,
      refreshToken: `refresh_${username}_${Date.now()}`,
      username: user.username,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl
    }
  });
});

// Authentication: Register (Accepts any credentials dynamically)
app.post('/v1/auth/register', async (req, res) => {
  const { username, name, email, password } = req.body;
  if (!username || !name || !email) {
    return res.status(400).json({ success: false, message: "Missing required fields", data: null });
  }

  const users = await db.getUsers();
  let user = users.find(u => u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === email.toLowerCase());

  if (!user) {
    user = {
      username: username,
      name: name,
      email: email,
      avatarUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`
    };
    await db.saveUser(user);
  }

  res.json({
    success: true,
    message: "Registration successful",
    data: {
      accessToken: `token_${username}_${Date.now()}`,
      refreshToken: `refresh_${username}_${Date.now()}`,
      username: user.username,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl
    }
  });
});

// Get Video list (Supports search queries & filtering)
app.get('/v1/videos', async (req, res) => {
  const { category, filter, query } = req.query;
  let videos = await db.getVideos();

  // Resolve dynamic asset URLs relative to current request's host/protocol and generate presigned URLs if needed
  videos = await Promise.all(videos.map(async (vid) => {
    let finalVideoUrl = vid.videoUrl;
    if (finalVideoUrl && finalVideoUrl.startsWith('r2://')) {
      if (useR2 && s3Client) {
        try {
          const key = finalVideoUrl.replace('r2://', '');
          const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key
          });
          finalVideoUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        } catch (err) {
          console.error("Error generating presigned URL:", err.message);
          finalVideoUrl = "";
        }
      } else {
        finalVideoUrl = ""; // Fallback if R2 is not configured but URL is r2://
      }
    } else {
      finalVideoUrl = resolveUrl(finalVideoUrl, req);
    }
    
    return {
      ...vid,
      videoUrl: finalVideoUrl,
      thumbnailUrl: resolveUrl(vid.thumbnailUrl, req)
    };
  }));

  // Filter by category
  if (category && category.toLowerCase() !== 'all') {
    videos = videos.filter(v => v.category.toLowerCase() === category.toLowerCase());
  }

  // Filter by search query
  if (query) {
    const q = query.toLowerCase();
    videos = videos.filter(v => 
      v.title.toLowerCase().includes(q) ||
      v.description.toLowerCase().includes(q) ||
      v.category.toLowerCase().includes(q) ||
      (v.tags && v.tags.some(tag => tag.toLowerCase().includes(q)))
    );
  }

  // Sort by filter
  if (filter) {
    if (filter === 'Trending') {
      videos.sort((a, b) => b.likesCount - a.likesCount);
    } else if (filter === 'Most Downloaded') {
      videos.sort((a, b) => b.downloadsCount - a.downloadsCount);
    } else if (filter === 'Newest') {
      videos.sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));
    } else if (filter === 'Oldest') {
      videos.sort((a, b) => new Date(a.uploadDate) - new Date(b.uploadDate));
    }
  }

  res.json({
    success: true,
    message: "Fetched template videos",
    data: videos
  });
});

// Upload Video Template (Saves file to Cloudflare R2 or falls back to local disk storage)
app.post('/v1/videos/upload', upload.single('videoFile'), async (req, res) => {
  const { title, description, category, tags } = req.body;

  if (!title || !category) {
    return res.status(400).json({ success: false, message: "Title and Category are required fields", data: null });
  }

  let videoUrlPath = "";
  if (req.file) {
    const originalName = req.file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    const key = `videos/${Date.now()}-${originalName}`;

    if (useR2) {
      // Direct Cloudflare R2 Upload
      try {
        const uploadCommand = new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || 'video/mp4'
        });

        await s3Client.send(uploadCommand);
        // Store as internal R2 URI to be presigned on read
        videoUrlPath = `r2://${key}`;
        console.log(`☁️  File uploaded to R2 successfully: ${videoUrlPath}`);
      } catch (err) {
        console.error("❌ Cloudflare R2 upload error. Falling back to local disk storage:", err.message);
        // Fallback local write
        const filename = `${Date.now()}-${originalName}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
        videoUrlPath = `/uploads/${filename}`;
      }
    } else {
      // Local fallback
      const filename = `${Date.now()}-${originalName}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
      videoUrlPath = `/uploads/${filename}`;
    }
  } else {
    // If no physical file was uploaded (e.g. simulated run), use fallback sample video
    videoUrlPath = "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4";
  }

  const randomThumb = defaultThumbnails[Math.floor(Math.random() * defaultThumbnails.length)];
  const parsedTags = tags ? tags.split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

  const newVideo = {
    id: `vid_${Date.now()}`,
    title: title,
    videoUrl: videoUrlPath,
    thumbnailUrl: randomThumb,
    username: "guest_explorer",
    category: category,
    description: description || "User uploaded short video template.",
    tags: parsedTags,
    uploadDate: getFormattedDate(),
    likesCount: 0,
    downloadsCount: 0
  };

  await db.saveVideo(newVideo);

  res.json({
    success: true,
    message: "Video template uploaded successfully",
    data: {
      ...newVideo,
      videoUrl: resolveUrl(newVideo.videoUrl, req),
      thumbnailUrl: resolveUrl(newVideo.thumbnailUrl, req)
    }
  });
});

// Submit a new video creation request
app.post('/v1/requests/create', async (req, res) => {
  const { id, movieName, actorName, sceneName, dialogue, description, requestDate, status } = req.body;

  if (!movieName || !actorName || !sceneName || !dialogue) {
    return res.status(400).json({ success: false, message: "Missing mandatory video request fields", data: null });
  }

  // Format requestDate if not supplied
  let dateStr = requestDate;
  if (!dateStr) {
    const now = new Date();
    dateStr = now.getFullYear() + '-' + 
              String(now.getMonth() + 1).padStart(2, '0') + '-' + 
              String(now.getDate()).padStart(2, '0') + ' ' + 
              String(now.getHours()).padStart(2, '0') + ':' + 
              String(now.getMinutes()).padStart(2, '0');
  }

  const newRequest = {
    id: id || `req_${Date.now()}`,
    movieName,
    actorName,
    sceneName,
    dialogue,
    description: description || "",
    requestDate: dateStr,
    status: status || "Pending"
  };

  await db.saveRequest(newRequest);

  res.json({
    success: true,
    message: "Video request raised successfully",
    data: newRequest
  });
});

// Retrieve requests history
app.get('/v1/requests/history', async (req, res) => {
  const requests = await db.getRequests();
  res.json({
    success: true,
    message: "Fetched request history",
    data: requests
  });
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`TemplateVerse Backend Server listening on port ${PORT}`);
  console.log(`API URL path: http://localhost:${PORT}/v1/`);
  console.log(`=================================================`);
});
