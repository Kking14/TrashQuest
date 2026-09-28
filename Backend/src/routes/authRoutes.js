import express from "express";
import { registerAccount, loginAccount, logoutAccount, getProfile, updatePassword, requestPasswordReset, resetPassword} from "../controller/authController.js";
import { validateLogin, validateRegister } from "../middleware/validateRequest.js";
import authenticate from "../middleware/authenticate.js";
import { authLimiter } from "../middleware/rateLimits.js";

const router = express.Router();

router.post("/register", authLimiter, validateRegister, registerAccount);

router.post("/login", authLimiter, validateLogin, loginAccount);
router.post("/forgot-password", authLimiter, requestPasswordReset);
router.post("/reset-password", authLimiter, resetPassword);

router.post("/logout", logoutAccount);

router.get("/me", authenticate, getProfile);

router.put("/change-password/", authenticate, updatePassword);


export default router;
