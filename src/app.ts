import express from 'express';
import cors from 'cors';
import complianceRouter from './routes/compliance.js';

export const app = express();

app.use(cors());
app.use(express.json());

// ─── Single-Page App ──────────────────────────────────────────────────────────
// The root route serves the interactive 1-pager HTML UI.
// Creator handle input → live compliance report — all within one page.

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildSPAPage());
});

// ─── API ──────────────────────────────────────────────────────────────────────

app.use('/api/compliance', complianceRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'galvor-compliance' });
});

// ─── SPA HTML ─────────────────────────────────────────────────────────────────

function buildSPAPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Galvor — Creator Compliance Check</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f1f5f9; min-height: 100vh; }

    /* ── Input section ── */
    #input-section {
      background: #1e293b;
      padding: 32px 24px 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    #input-section .logo {
      color: white;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      opacity: 0.6;
      margin-bottom: 6px;
    }
    #input-section h1 {
      color: white;
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 20px;
    }
    .handle-form {
      display: flex;
      gap: 10px;
      width: 100%;
      max-width: 520px;
    }
    .handle-form input {
      flex: 1;
      padding: 11px 14px;
      border-radius: 8px;
      border: none;
      font-size: 14px;
      outline: none;
      background: #334155;
      color: white;
    }
    .handle-form input::placeholder { color: #64748b; }
    .handle-form input:focus { background: #475569; }
    .handle-form button {
      padding: 11px 20px;
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .handle-form button:hover { background: #2563eb; }
    .handle-form button:disabled { background: #475569; cursor: not-allowed; }

    /* ── State panels ── */
    #status-section {
      display: none;
      padding: 48px 24px;
      text-align: center;
    }
    .spinner {
      width: 40px; height: 40px;
      border: 4px solid #e2e8f0;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text { font-size: 14px; color: #64748b; }
    .status-step { font-size: 12px; color: #94a3b8; margin-top: 6px; }

    #error-section {
      display: none;
      padding: 32px 24px;
      text-align: center;
      color: #dc2626;
    }

    /* ── Report wrapper ── */
    #report-section {
      display: none;
      padding: 0 0 32px;
    }

    /* ── Report embedded ── */
    #report-embed {
      width: 100%;
      background: white;
    }

    @media print {
      #input-section, #status-section, #error-section { display: none !important; }
      #report-section { display: block !important; }
    }
  </style>
</head>
<body>

  <!-- Always-visible input bar -->
  <div id="input-section">
    <div class="logo">Galvor</div>
    <h1>Creator Compliance Check</h1>
    <form class="handle-form" id="handle-form" onsubmit="startAnalysis(event)">
      <input
        id="handle-input"
        type="text"
        placeholder="Instagram handle (e.g. johndoe)"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="submit" id="analyze-btn">Analyze</button>
    </form>
  </div>

  <!-- Processing state -->
  <div id="status-section">
    <div class="spinner"></div>
    <div class="status-text">Analyzing creator <span id="analyzing-handle"></span>…</div>
    <div class="status-step" id="status-step">Fetching Instagram profile</div>
  </div>

  <!-- Error state -->
  <div id="error-section">
    <div style="font-size:32px;margin-bottom:12px;">⚠️</div>
    <div style="font-size:16px;font-weight:600;" id="error-msg">Something went wrong</div>
    <div style="font-size:13px;color:#6b7280;margin-top:8px;" id="error-detail"></div>
    <button onclick="resetForm()" style="margin-top:16px;padding:8px 20px;background:#1e293b;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Try Again</button>
  </div>

  <!-- Report output (injected HTML from API) -->
  <div id="report-section">
    <div id="report-embed"></div>
    <div style="text-align:center;margin-top:8px;">
      <button onclick="resetForm()" style="padding:8px 20px;background:#1e293b;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Check Another Creator</button>
      <button onclick="window.print()" style="margin-left:10px;padding:8px 20px;background:#475569;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;">Print / Save PDF</button>
    </div>
  </div>

<script>
  const STEP_MESSAGES = [
    'Fetching Instagram profile…',
    'Fetching last 25 posts…',
    'Transcribing video content…',
    'Running SEBI compliance analysis…',
    'Running brand safety checks…',
    'Generating report…',
  ];

  let pollInterval = null;
  let stepIdx = 0;
  let stepTimer = null;

  function show(id) {
    ['status-section', 'error-section', 'report-section'].forEach(s => {
      document.getElementById(s).style.display = s === id ? (id === 'report-section' ? 'block' : 'flex') : 'none';
    });
  }

  function hide(id) {
    document.getElementById(id).style.display = 'none';
  }

  function resetForm() {
    clearInterval(pollInterval);
    clearInterval(stepTimer);
    pollInterval = null;
    document.getElementById('analyze-btn').disabled = false;
    document.getElementById('handle-input').value = '';
    hide('status-section');
    hide('error-section');
    hide('report-section');
    document.getElementById('report-embed').innerHTML = '';
  }

  function advanceStep() {
    stepIdx = (stepIdx + 1) % STEP_MESSAGES.length;
    document.getElementById('status-step').textContent = STEP_MESSAGES[stepIdx];
  }

  async function startAnalysis(e) {
    e.preventDefault();
    const handle = document.getElementById('handle-input').value.trim().replace(/^@/, '');
    if (!handle) return;

    document.getElementById('analyze-btn').disabled = true;
    document.getElementById('analyzing-handle').textContent = '@' + handle;
    stepIdx = 0;
    document.getElementById('status-step').textContent = STEP_MESSAGES[0];

    show('status-section');

    // Rotate step messages every 12s to show progress feel
    stepTimer = setInterval(advanceStep, 12000);

    let jobId;
    try {
      const res = await fetch('/api/compliance/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start analysis');
      jobId = data.jobId;
    } catch (err) {
      clearInterval(stepTimer);
      showError('Could not start analysis', err.message);
      return;
    }

    // Poll every 4s for completion
    pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/compliance/status/' + jobId);
        const { status, error } = await res.json();

        if (status === 'done') {
          clearInterval(pollInterval);
          clearInterval(stepTimer);
          await loadReport(jobId);
        } else if (status === 'error') {
          clearInterval(pollInterval);
          clearInterval(stepTimer);
          showError('Analysis failed', error || 'Unknown error');
        }
      } catch (err) {
        // Network blip — keep polling
      }
    }, 4000);
  }

  async function loadReport(jobId) {
    try {
      const res = await fetch('/api/compliance/report/' + jobId);
      const html = await res.text();

      // Extract just the body content from the returned HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const reportBody = doc.body.innerHTML;

      document.getElementById('report-embed').innerHTML = reportBody;
      document.getElementById('analyze-btn').disabled = false;
      show('report-section');
    } catch (err) {
      showError('Could not load report', err.message);
    }
  }

  function showError(msg, detail) {
    document.getElementById('error-msg').textContent = msg;
    document.getElementById('error-detail').textContent = detail || '';
    document.getElementById('analyze-btn').disabled = false;
    document.getElementById('status-section').style.display = 'none';
    document.getElementById('error-section').style.display = 'block';
  }
</script>
</body>
</html>`;
}

export default app;
