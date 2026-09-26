import express from "express";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import binRoutes from "./routes/binRoutes.js";
import disposalRoutes from "./routes/disposalRoutes.js";
import questRoutes from "./routes/questRoutes.js";
import rewardRoutes from "./routes/rewardRoutes.js";
import overviewRoutes from "./routes/overviewRoutes.js";
import { connectDB } from "./config/db.js";
import dotenv from "dotenv";
import helmet from "helmet";
import { generalApiLimiter } from "./middleware/rateLimits.js";
 
dotenv.config();
const PORT = process.env.PORT || 5001;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters");
}
 
const app = express();
app.disable("x-powered-by");

const allowedOrigins = new Set((process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Device-Key");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  if (origin && req.method === "OPTIONS") return res.sendStatus(403);
  next();
});

app.use("/api", async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("MongoDB connection error:", error);
    res.status(503).json({ success: false, message: "Database unavailable" });
  }
});
 
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "32kb", strict: true }));
app.use("/api", generalApiLimiter);
app.get("/api/health", (req, res) => res.json({ success: true }));
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/bins", binRoutes);
app.use("/api/disposals", disposalRoutes);
app.use("/api/quests", questRoutes);
app.use("/api/rewards", rewardRoutes);
app.use("/api/overview", overviewRoutes);

app.use((error, req, res, next) => {
  if (error.status === 413) {
    return res.status(413).json({ success: false, message: 'Reward photo is too large. Choose a smaller image.' });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ success: false, message: "Invalid JSON request" });
  }
  return next(error);
});
 
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
