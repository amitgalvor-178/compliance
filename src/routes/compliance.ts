import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runCompliancePipeline } from '../services/compliance/complianceOrchestrator.js';
import { generateHTMLReport } from '../services/report/reportGenerator.js';
import { debugMetaCredentials } from '../instagram/metaGraphClient.js';
import type { ComplianceReport } from '../types/index.js';

const router = Router();

// In-memory job store (sufficient for this service — jobs expire after 1h)
interface Job {
  status: 'processing' | 'done' | 'error';
  step: number; // 0=fetching 1=transcribing 2=sebi 3=brand-safety 4=done
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

  const job: Job = { status: 'processing', step: 0, startedAt: Date.now() };
  jobs.set(jobId, job);

  // Run pipeline in background — do not await
  runCompliancePipeline(cleanHandle, (step) => { job.step = step; })
    .then((report) => {
      job.status = 'done';
      job.step = 4;
      job.report = report;
    })
    .catch((err: Error) => {
      console.error(`[compliance] Pipeline failed for @${cleanHandle}:`, err.message);
      job.status = 'error';
      job.error = err.message;
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
  res.json({ status: job.status, step: job.step, error: job.error });
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

// GET /api/compliance/debug[?handle=xyz] — diagnose Meta credentials
router.get('/debug', async (req: Request, res: Response) => {
  const handle = typeof req.query.handle === 'string' ? req.query.handle : undefined;
  try {
    const result = await debugMetaCredentials(handle);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
