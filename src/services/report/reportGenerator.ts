import {
  OverallVerdict,
  RuleStatus,
  type ComplianceReport,
  type RuleResult,
} from '../../types/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function verdictColor(v: OverallVerdict): string {
  if (v === OverallVerdict.COMPLIANT) return '#16a34a';
  if (v === OverallVerdict.REVIEW_REQUIRED) return '#d97706';
  return '#dc2626';
}

function verdictBg(v: OverallVerdict): string {
  if (v === OverallVerdict.COMPLIANT) return '#dcfce7';
  if (v === OverallVerdict.REVIEW_REQUIRED) return '#fef3c7';
  return '#fee2e2';
}

function scoreColor(s: number): string {
  if (s >= 80) return '#16a34a';
  if (s >= 50) return '#d97706';
  return '#dc2626';
}

function statusBadge(status: RuleStatus): string {
  const config = {
    [RuleStatus.PASS]: { bg: '#dcfce7', color: '#15803d', label: 'PASS' },
    [RuleStatus.WARN]: { bg: '#fef3c7', color: '#92400e', label: 'WARN' },
    [RuleStatus.FAIL]: { bg: '#fee2e2', color: '#991b1b', label: 'FAIL' },
  }[status];
  return `<span style="background:${config.bg};color:${config.color};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.5px;">${config.label}</span>`;
}

function severityBadge(s: string): string {
  const colors: Record<string, { bg: string; color: string }> = {
    critical: { bg: '#fee2e2', color: '#991b1b' },
    high: { bg: '#ffedd5', color: '#9a3412' },
    medium: { bg: '#fef3c7', color: '#92400e' },
    low: { bg: '#f0fdf4', color: '#166534' },
  };
  const c = colors[s] || colors.low;
  return `<span style="background:${c.bg};color:${c.color};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;">${s.toUpperCase()}</span>`;
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function renderRuleCard(rule: RuleResult): string {
  const flagsHtml =
    rule.flags.length === 0
      ? ''
      : `<div style="margin-top:8px;">
        ${rule.flags
          .slice(0, 3)
          .map(
            (f) => `
          <div style="background:#f9fafb;border-left:3px solid ${f.severity === 'critical' || f.severity === 'high' ? '#dc2626' : '#d97706'};padding:6px 10px;margin-top:6px;border-radius:0 4px 4px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
              ${severityBadge(f.severity)}
              <span style="font-size:10px;color:#6b7280;">Post ${f.postId === 'PROFILE' ? '(Bio)' : '#' + f.postId.slice(-6)}</span>
            </div>
            ${f.excerpt ? `<div style="font-size:11px;color:#374151;font-style:italic;margin-bottom:3px;">"${escHtml(f.excerpt.slice(0, 120))}${f.excerpt.length > 120 ? '…' : ''}"</div>` : ''}
            <div style="font-size:11px;color:#6b7280;">${escHtml(f.explanation)}</div>
          </div>`,
          )
          .join('')}
        ${rule.flags.length > 3 ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px;">+${rule.flags.length - 3} more flag(s)</div>` : ''}
      </div>`;

  return `
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div>
          <div style="font-weight:600;font-size:13px;color:#111827;">${escHtml(rule.ruleName)}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px;">${escHtml(rule.description)}</div>
        </div>
        <div style="flex-shrink:0;">${statusBadge(rule.status)}</div>
      </div>
      ${flagsHtml}
    </div>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Main report builder ──────────────────────────────────────────────────────

export function generateHTMLReport(report: ComplianceReport): string {
  const { creator, sebiCompliance, brandSafety, overallScore, verdict, summaryNotes } = report;

  const vc = verdictColor(verdict);
  const vbg = verdictBg(verdict);
  const verdictLabel = verdict.replace(/_/g, ' ');

  const sebiRulesHtml = Object.values(sebiCompliance.rules).map(renderRuleCard).join('');
  const brandRulesHtml = Object.values(brandSafety.rules).map(renderRuleCard).join('');

  const summaryHtml = summaryNotes
    .map(
      (note) =>
        `<li style="margin-bottom:4px;font-size:12px;color:#374151;">• ${escHtml(note)}</li>`,
    )
    .join('');

  const reportDate = new Date(report.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Compliance Report — @${escHtml(creator.username)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f3f4f6; color: #111827; }
    @media print {
      body { background: white; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div style="max-width:900px;margin:24px auto;padding:0 16px;">

    <!-- Header -->
    <div style="background:#1e293b;border-radius:12px 12px 0 0;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Galvor Compliance Engine</div>
        <div style="color:white;font-size:20px;font-weight:700;margin-top:4px;">Creator Compliance Report</div>
      </div>
      <div style="text-align:right;">
        <div style="color:#94a3b8;font-size:11px;">Report ID: ${escHtml(report.reportId.slice(0, 8).toUpperCase())}</div>
        <div style="color:#94a3b8;font-size:11px;margin-top:2px;">${reportDate}</div>
      </div>
    </div>

    <!-- Creator Profile + Score -->
    <div style="background:white;padding:20px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
      <!-- Avatar -->
      <div style="width:72px;height:72px;border-radius:50%;overflow:hidden;background:#e5e7eb;flex-shrink:0;">
        ${creator.profilePictureUrl ? `<img src="${escHtml(creator.profilePictureUrl)}" width="72" height="72" style="object-fit:cover;" alt="Profile" />` : `<div style="width:72px;height:72px;background:#e5e7eb;display:flex;align-items:center;justify-content:center;font-size:28px;color:#9ca3af;">👤</div>`}
      </div>

      <!-- Creator Info -->
      <div style="flex:1;min-width:180px;">
        <div style="font-size:18px;font-weight:700;color:#111827;">${escHtml(creator.name)}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px;">@${escHtml(creator.username)}</div>
        <div style="display:flex;gap:16px;margin-top:8px;flex-wrap:wrap;">
          <div style="font-size:12px;color:#374151;"><span style="font-weight:600;">${formatFollowers(creator.followersCount)}</span> followers</div>
          <div style="font-size:12px;color:#374151;"><span style="font-weight:600;">${report.postsAnalyzed}</span> posts analyzed</div>
          <div style="font-size:12px;color:#374151;"><span style="font-weight:600;">${report.postsTranscribed}</span> videos transcribed</div>
        </div>
        ${creator.biography ? `<div style="font-size:11px;color:#9ca3af;margin-top:6px;font-style:italic;">${escHtml(creator.biography.slice(0, 100))}${creator.biography.length > 100 ? '…' : ''}</div>` : ''}
      </div>

      <!-- Overall Score -->
      <div style="text-align:center;padding:16px 24px;background:${vbg};border-radius:10px;min-width:140px;">
        <div style="font-size:40px;font-weight:800;color:${vc};line-height:1;">${overallScore}</div>
        <div style="font-size:10px;color:${vc};font-weight:600;letter-spacing:0.5px;margin-top:2px;">OUT OF 100</div>
        <div style="margin-top:8px;background:${vc};color:white;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:0.5px;">${verdictLabel}</div>
      </div>
    </div>

    <!-- Scores Bar -->
    <div style="background:white;padding:12px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-top:1px solid #f3f4f6;display:flex;gap:24px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${scoreColor(sebiCompliance.score)};"></div>
        <div style="font-size:12px;color:#374151;">SEBI Compliance Score: <strong style="color:${scoreColor(sebiCompliance.score)};">${sebiCompliance.score}/100</strong></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${scoreColor(brandSafety.score)};"></div>
        <div style="font-size:12px;color:#374151;">Brand Safety Score: <strong style="color:${scoreColor(brandSafety.score)};">${brandSafety.score}/100</strong></div>
      </div>
      ${sebiCompliance.hasSEBIRegistration ? `<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:12px;">✅</span><span style="font-size:12px;color:#374151;">SEBI Reg: <strong>${escHtml(sebiCompliance.sebiRegistrationNumber || '')}</strong></span></div>` : ''}
    </div>

    <!-- Summary Notes -->
    <div style="background:#f8fafc;padding:12px 24px;border:1px solid #e5e7eb;border-top:none;">
      <div style="font-size:11px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Key Findings</div>
      <ul style="list-style:none;">${summaryHtml}</ul>
    </div>

    <!-- Two Column: SEBI + Brand Safety -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #e5e7eb;border-top:none;background:white;">

      <!-- SEBI Column -->
      <div style="padding:20px;border-right:1px solid #e5e7eb;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div>
            <div style="font-size:14px;font-weight:700;color:#1e293b;">SEBI Compliance</div>
            <div style="font-size:11px;color:#6b7280;margin-top:1px;">Regulatory rules for financial creators</div>
          </div>
          <div style="font-size:20px;font-weight:800;color:${scoreColor(sebiCompliance.score)};">${sebiCompliance.score}<span style="font-size:11px;font-weight:400;color:#9ca3af;">/100</span></div>
        </div>
        ${sebiRulesHtml}
      </div>

      <!-- Brand Safety Column -->
      <div style="padding:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div>
            <div style="font-size:14px;font-weight:700;color:#1e293b;">Brand Safety</div>
            <div style="font-size:11px;color:#6b7280;margin-top:1px;">Content quality & safety attributes</div>
          </div>
          <div style="font-size:20px;font-weight:800;color:${scoreColor(brandSafety.score)};">${brandSafety.score}<span style="font-size:11px;font-weight:400;color:#9ca3af;">/100</span></div>
        </div>
        ${brandRulesHtml}
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#1e293b;border-radius:0 0 12px 12px;padding:14px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div style="color:#64748b;font-size:11px;">Generated by Galvor Compliance Engine · ${reportDate}</div>
      <div style="color:#64748b;font-size:11px;">SEBI sources: PR No. 14/2025 · Circular HO/(79)2026-MIRSD-PODMMC</div>
    </div>

  </div>
</body>
</html>`;
}
