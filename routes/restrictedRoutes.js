import express from "express";
import * as restrictedController from "../controller/restrictedController.js";
import { isAuthenticated, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Public: the calculation page checks whether a user may see "Create Report V3".
// Returns only a boolean for the given userId, so it needs no auth.
router.get("/allowlist/check", restrictedController.checkAllowed);

// Admin-only: read and replace the allowlist.
router.get("/allowlist", isAuthenticated, authorizeRoles("admin"), restrictedController.getAllowlist);
router.put("/allowlist", isAuthenticated, authorizeRoles("admin"), restrictedController.setAllowlist);

export default router;
