import express from "express";
import { getDriveUploadToken } from "../controller/gdriveController.js";

const router = express.Router();

// GET /gdrive/token — short-lived Drive access token for browser-direct uploads.
router.get("/token", getDriveUploadToken);

export default router;
