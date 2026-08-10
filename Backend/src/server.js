import express from "express";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import binRoutes from "./routes/binRoutes.js";
import disposalRoutes from "./routes/disposalRoutes.js";
import questRoutes from "./routes/questRoutes.js";
import rewardRoutes from "./routes/rewardRoutes.js";
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
 
connectDB();
 
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "32kb", strict: true }));
app.use("/api", generalApiLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/bins", binRoutes);
app.use("/api/disposals", disposalRoutes);
app.use("/api/quests", questRoutes);
app.use("/api/rewards", rewardRoutes);

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ success: false, message: "Invalid JSON request" });
  }
  return next(error);
});
 
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
