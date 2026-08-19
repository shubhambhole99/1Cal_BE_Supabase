import express from "express";
import * as ctrl from "../controller/v3Controller.js";
import * as payments from "../controller/paymentsController.js";
import * as ent from "../controller/entitlementsController.js";
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
router.patch("/templates/:id/versions/:versionId", ctrl.patchVersion);
router.delete("/templates/:id/versions/:versionId", ctrl.deleteVersion);
router.post("/templates/:id/publish", ctrl.publishVersion);
router.post("/templates/:id/promote", ctrl.promoteToPublished);
router.post("/templates/:id/push-to-published/preview", ctrl.pushToPublishedPreview);
router.post("/templates/:id/push-to-published", ctrl.pushToPublished);

router.post("/pages", ctrl.createPage);
router.post("/pages/reorder", ctrl.reorderPages);
// Import a page from ANOTHER template as a read-only live mirror. Literal
// segment declared before /pages/:id so it isn't captured as an id.
router.post("/pages/import", ctrl.importPage);
router.get("/pages/:id", ctrl.getPage);
router.patch("/pages/:id", ctrl.patchPage);
router.delete("/pages/:id", ctrl.deletePage);
router.post("/pages/:id/duplicate", ctrl.duplicatePage);

router.get("/master-inputs/:id", ctrl.getMasterInput);
router.post("/master-inputs", ctrl.createMasterInput);
router.post("/master-inputs/bulk", ctrl.bulkCreateMasterInputs);
router.post("/master-inputs/import", ctrl.importMasterInputs);
router.post("/master-inputs/wipe", ctrl.wipeVersionMasterInputs);
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
router.post("/instances/:id/copy", ctrl.copyInstance);
// Which project does this report live in? (bare /instance/<id> links)
router.get("/instances/:id/home-report", ctrl.getInstanceHomeReport);
// Paywall: the one action that spends a report credit.
router.post("/instances/:id/change-plot-area", ent.changePlotArea);
// Generic form: pay to change any one-time input. { key, value }
router.post("/instances/:id/change-locked-input", ent.changePlotArea);
// Version switcher: pin the report to a template version (null = published).
router.post("/instances/:id/change-version", ctrl.changeInstanceVersion);
// Instance links — live 2-way mimic between two reports.
router.get("/instance-links", ctrl.listInstanceLinks);
router.post("/instance-links", ctrl.createInstanceLink);
router.patch("/instance-links/:id", ctrl.patchInstanceLink);
router.delete("/instance-links/:id", ctrl.deleteInstanceLink);
router.get("/instances/:id/master-inputs", ctrl.getInstanceMasterInputs);
// Bulk seed/replace overrides — literal /bulk before /:templateMiId so it isn't
// captured as a template-mi id.
router.post("/instances/:instanceId/master-inputs/bulk", ctrl.bulkPatchInstanceMasterInputs);
router.patch("/instances/:instanceId/master-inputs/:templateMiId", ctrl.patchInstanceMasterInput);

// Per-instance comments (flat discussion thread). Delete is keyed by comment id.
router.get("/instances/:id/comments", ctrl.listInstanceComments);
router.post("/instances/:id/comments", ctrl.createInstanceComment);
router.delete("/comments/:commentId", ctrl.deleteInstanceComment);

// Combined comparison reports (multi-instance). Literal /preview before /:id so
// it isn't captured as a report id.
router.get("/reports/preview", ctrl.previewReport);
router.get("/reports", ctrl.listReports);
router.post("/reports", ctrl.createReport);
router.get("/reports/:id", ctrl.getReport);
router.patch("/reports/:id", ctrl.patchReport);
router.delete("/reports/:id", ctrl.deleteReport);

router.get("/legacy/templates", ctrl.listLegacyTemplates);
router.post("/migrate/:legacyTemplateId", ctrl.migrateLegacy);

router.get("/active-context", ctrl.getActiveContext);
router.post("/active-context", ctrl.setActiveContext);

// Real Estate calculations — standalone CRUD
router.get("/calculations", ctrl.listCalculations);
// Reorder before :id so the literal route wins the match.
router.post("/calculations/reorder", ctrl.reorderCalculations);
router.get("/calculations/applicable", ctrl.applicableCalculations);
router.get("/calculations/:id", ctrl.getCalculation);
router.post("/calculations", ctrl.createCalculation);
router.patch("/calculations/:id", ctrl.patchCalculation);

// Mumbai DCPR workflow — rules, evaluation, and run tracking.
router.get("/dcpr/rules", ctrl.listDcprRules);
router.put("/dcpr/rules", ctrl.saveDcprRules);
router.get("/dcpr/graph", ctrl.getDcprGraph);
router.put("/dcpr/graph", ctrl.saveDcprGraph);
router.get("/dcpr/schemes", ctrl.evaluateDcprSchemes);
router.get("/dcpr/calculations", ctrl.resolveDcprCalculations);
// Post-instance workflow config (common + per-calculation steps), per retemplate.
router.get("/post-instance-workflow/:retemplateId", ctrl.getPostInstanceWorkflow);
router.put("/post-instance-workflow/:retemplateId", ctrl.savePostInstanceWorkflow);
// Sheet mapping: where the analytics views read their numbers, per retemplate.
// The list route must be registered BEFORE the :retemplateId one or "sheet-mapping"
// would never match the bare path.
router.get("/sheet-mapping", ctrl.listSheetMappings);
router.get("/sheet-mapping/:retemplateId", ctrl.getSheetMapping);
router.put("/sheet-mapping/:retemplateId", ctrl.saveSheetMapping);
// Post-instance FAQ config (common + per-calculation FAQs), per retemplate.
router.get("/post-instance-faq/:retemplateId", ctrl.getPostInstanceFaq);
router.put("/post-instance-faq/:retemplateId", ctrl.savePostInstanceFaq);
// Test sets — named MI-override snapshots for the retemplate editor Testing tab.
router.get("/test-sets/:templateId", ctrl.getTestSets);
router.put("/test-sets/:templateId", ctrl.saveTestSets);
// Report dashboard config (version-scoped widgets linked to cells), per retemplate.
router.get("/dashboard/:retemplateId", ctrl.getDashboard);
router.put("/dashboard/:retemplateId", ctrl.saveDashboard);
// Sources — standalone reusable reference docs (markdown + attached Drive files).
router.get("/sources", ctrl.listSources);
router.post("/sources", ctrl.createSource);
router.get("/sources/:id", ctrl.getSource);
router.put("/sources/:id", ctrl.updateSource);
router.delete("/sources/:id", ctrl.deleteSource);
router.get("/dcpr/runs", ctrl.listDcprRuns);
// Literal segment before :id so it isn't captured as an id.
router.get("/dcpr/runs/by-instance/:instanceId", ctrl.getDcprRunByInstance);
router.post("/dcpr/runs", ctrl.createDcprRun);
router.patch("/dcpr/runs/:id", ctrl.updateDcprRun);
// DELETE route intentionally removed — use PATCH { disabled: true } instead.

// Cashfree payments — ledger + create/verify/webhook. Literal segments are
// declared before any :param so they aren't captured as ids.
router.get("/payments", payments.listPayments);
router.post("/payments/create-order", payments.createPaymentOrder);
router.get("/payments/status/:orderId", payments.getPaymentStatus);
router.post("/payments/webhook", payments.cashfreeWebhook);

// ── Entitlements (paywall) ───────────────────────────────────────────────────
router.get("/entitlements/me", ent.getMyEntitlement);
router.post("/entitlements/grant", ent.grantEntitlement);
router.get("/entitlements/:userId", ent.getUserEntitlement);

export default router;
