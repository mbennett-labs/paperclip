import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { generateBoardExport } from "../services/board-export.js";
import { generateProviderUsageExport } from "../services/provider-usage-export.js";

export function boardExportRoutes(db: Db) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const { bundle } = await generateBoardExport(db);
      res.json(bundle);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate board export" });
    }
  });

  router.get("/companies", async (_req, res) => {
    try {
      const { bundle } = await generateBoardExport(db);
      res.json(bundle.companies);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate company export" });
    }
  });

  router.get("/agents", async (_req, res) => {
    try {
      const { bundle } = await generateBoardExport(db);
      res.json(bundle.agents);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate agent export" });
    }
  });

  router.get("/issues", async (_req, res) => {
    try {
      const { bundle } = await generateBoardExport(db);
      res.json(bundle.issues);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate issue export" });
    }
  });

  router.get("/governance", async (_req, res) => {
    try {
      const { bundle } = await generateBoardExport(db);
      res.json(bundle.governance);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate governance export" });
    }
  });

  router.get("/crawdaddy", async (_req, res) => {
    try {
      const { bundle } = await generateBoardExport(db);
      res.json(bundle.crawdaddy);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate CrawDaddy export" });
    }
  });

  router.get("/provider-usage", async (_req, res) => {
    try {
      const markdown = await generateProviderUsageExport(db);
      res.type("text/markdown").send(markdown);
    } catch (err) {
      res.status(500).json({ error: "Failed to generate provider usage export" });
    }
  });

  return router;
}
