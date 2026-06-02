import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runCompliancePipeline } from '../services/compliance/complianceOrchestrator.js';
import { generateHTMLReport } from '../services/report/reportGenerator.js';
import type { ComplianceReport } from '../types/index.js';

const router = Router();

// In-memory job store (sufficient for this service — jobs expire after 1h)
interface Job {
  status: 'processing' | 'done' | 'error';
  report?: ComplianceReport;
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, Job>();

// Prune jobs older than 1 hour to prevent memory growth
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.startedAt < oneHourAgo) jobs.delete(id);
  }
}, 15 * 60 * 1000);

// POST /api/compliance/analyze — kick off async pipeline
router.post('/analyze', async (req: Request, res: Response) => {
  const { handle } = req.body as { handle?: string };

  if (!handle || typeof handle !== 'string' || !handle.trim()) {
    res.status(400).json({ error: 'handle is required' });
    return;
  }

  const cleanHandle = handle.trim().replace(/^@/, '');
  const jobId = uuidv4();

  jobs.set(jobId, { status: 'processing', startedAt: Date.now() });

  // Run pipeline in background — do not await
  runCompliancePipeline(cleanHandle)
    .then((report) => {
      jobs.set(jobId, { status: 'done', report, startedAt: Date.now() });
    })
    .catch((err: Error) => {
      console.error(`[compliance] Pipeline failed for @${cleanHandle}:`, err.message);
      jobs.set(jobId, { status: 'error', error: err.message, startedAt: Date.now() });
    });

  res.json({ jobId });
});

// GET /api/compliance/status/:jobId
router.get('/status/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ status: job.status, error: job.error });
});

// GET /api/compliance/report/:jobId — returns full HTML report
router.get('/report/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job) {
    res.status(404).send('<p>Report not found</p>');
    return;
  }
  if (job.status !== 'done' || !job.report) {
    res.status(202).send(`<p>Report is still processing. Status: ${job.status}</p>`);
    return;
  }

  const html = generateHTMLReport(job.report);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// GET /api/compliance/report/:jobId/json — raw JSON (useful for debugging)
router.get('/report/:jobId/json', (req: Request, res: Response) => {
  const job = jobs.get(String(req.params.jobId));
  if (!job || job.status !== 'done' || !job.report) {
    res.status(404).json({ error: 'Report not ready' });
    return;
  }
  res.json(job.report);
});

export default router;
