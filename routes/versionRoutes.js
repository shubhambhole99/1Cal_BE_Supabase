import express from "express";
import * as versionController from "../controller/versionController.js";

const router = express.Router();

router.post("/:id", versionController.createVersion);
router.get("/", versionController.getAllVersions);
router.get("/:id", versionController.getVersion);
router.put("/:id", versionController.updateVersion);

export default router;
