import express from "express";
import * as ctrl from "../controller/v3Controller.js";
import { addClient } from "../lib/events.js";

const router = express.Router();

router.get("/events", (req, res) => addClient(req, res));

router.get("/templates", ctrl.listTemplates);
// Literal route before :id so /reorder isn't captured as an id.
router.post("/templates/reorder", ctrl.reorderTemplates);
router.post("/templates", ctrl.createTemplate);
router.get("/templates/:id", ctrl.getTemplate);
router.patch("/templates/:id", ctrl.patchTemplate);
router.get("/templates/:id/master-inputs", ctrl.getMasterInputs);

// Version control
router.get("/templates/:id/versions", ctrl.listVersions);
router.post("/templates/:id/versions", ctrl.createVersion);
router.post("/templates/:id/versions/:targetVersionId/restore", ctrl.restoreVersion);
router.delete("/templates/:id/versions/:versionId", ctrl.deleteVersion);
router.post("/templates/:id/publish", ctrl.publishVersion);

router.post("/pages", ctrl.createPage);
router.post("/pages/reorder", ctrl.reorderPages);
router.get("/pages/:id", ctrl.getPage);
router.patch("/pages/:id", ctrl.patchPage);
router.delete("/pages/:id", ctrl.deletePage);

router.get("/master-inputs/:id", ctrl.getMasterInput);
router.post("/master-inputs", ctrl.createMasterInput);
router.post("/master-inputs/bulk", ctrl.bulkCreateMasterInputs);
router.post("/master-inputs/reorder", ctrl.reorderMasterInputs);
router.patch("/master-inputs/:id", ctrl.patchMasterInput);
router.delete("/master-inputs/:id", ctrl.deleteMasterInput);

// Master-input groups (first-class entity)
router.get("/templates/:id/master-input-groups", ctrl.listMasterInputGroups);
router.post("/master-input-groups", ctrl.createMasterInputGroup);
router.post("/master-input-groups/bulk", ctrl.bulkCreateMasterInputGroups);
router.post("/master-input-groups/reorder", ctrl.reorderMasterInputGroups);
router.patch("/master-input-groups/:id", ctrl.patchMasterInputGroup);
router.delete("/master-input-groups/:id", ctrl.deleteMasterInputGroup);

// Instances (per-feasibility copies of a template — own only master-input values)
router.get("/instances", ctrl.listInstances);
router.post("/instances", ctrl.createInstance);
router.get("/instances/:id", ctrl.getInstance);
router.patch("/instances/:id", ctrl.patchInstance);
router.delete("/instances/:id", ctrl.deleteInstance);
router.get("/instances/:id/master-inputs", ctrl.getInstanceMasterInputs);
router.patch("/instances/:instanceId/master-inputs/:templateMiId", ctrl.patchInstanceMasterInput);

router.get("/legacy/templates", ctrl.listLegacyTemplates);
router.post("/migrate/:legacyTemplateId", ctrl.migrateLegacy);

router.get("/active-context", ctrl.getActiveContext);
router.post("/active-context", ctrl.setActiveContext);

// Real Estate calculations — standalone CRUD
router.get("/calculations", ctrl.listCalculations);
// Reorder before :id so the literal route wins the match.
router.post("/calculations/reorder", ctrl.reorderCalculations);
router.get("/calculations/:id", ctrl.getCalculation);
router.post("/calculations", ctrl.createCalculation);
router.patch("/calculations/:id", ctrl.patchCalculation);
// DELETE route intentionally removed — use PATCH { disabled: true } instead.

export default router;
