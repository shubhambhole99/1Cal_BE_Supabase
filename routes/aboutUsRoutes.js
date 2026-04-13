import express from "express";
import * as aboutusController from "../controller/aboutusController.js";

const router = express.Router();

router.post("/", aboutusController.createAboutUs);
router.get("/", aboutusController.getAllAboutUs);
router.get("/:id", aboutusController.getAboutUsById);
router.put("/:id", aboutusController.updateAboutUs);
router.delete("/:id", aboutusController.deleteAboutUs);
router.put("/photo/:id", aboutusController.updateProfilePhoto);

export default router;
