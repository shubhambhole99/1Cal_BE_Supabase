import express from "express";
import * as commentController from "../controller/commentController.js";
import { isAuthenticated } from "../middleware/auth.js";

const router = express.Router();

router.get("/threads", commentController.getOrCreateThread);
router.get("/threads/:threadId/comments", commentController.getComments);
router.post("/threads/:threadId/comments", isAuthenticated, commentController.createComment);
router.patch("/comments/:commentId", isAuthenticated, commentController.updateComment);
router.delete("/comments/:commentId", isAuthenticated, commentController.deleteComment);

export default router;
