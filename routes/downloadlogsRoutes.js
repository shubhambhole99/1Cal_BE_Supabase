import express from "express";
import * as downloadlogController from "../controller/downloadlogController.js";

const router = express.Router();

router.post("/", downloadlogController.logPdfDownload);
router.get("/", downloadlogController.getAllPdfDownloadLogs);

export default router;
