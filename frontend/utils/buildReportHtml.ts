/**
 * utils/buildReportHtml.ts
 *
 * Pure function that builds the HTML string for the project impact report
 * print view.
 *
 * Extracted from handlePrintReport so the HTML-generation logic can be
 * tested in isolation without mounting the full page component.  The
 * function accepts only the data it needs, has no side-effects, and returns
 * a complete HTML document string ready to be assigned to an iframe's
 * `srcdoc` attribute.
 *
 * Security contract:
 *   Every field that originates from user/database input MUST be passed
 *   through escapeHtml() before it is interpolated into the HTML string.
 *   Fields produced by our own formatting helpers (formatXLM,
 *   progressPercent, toLocaleString) are numeric/locale-formatted and
 *   contain no HTML-significant characters — they are left as-is.
 */
import { escapeHtml } from "@/utils/escapeHtml";
import { formatXLM, progressPercent } from "@/utils/format";
import type { ClimateProject, ProjectUpdate } from "@/utils/types";

export interface ReportOptions {
  project: ClimateProject;
  updates: ProjectUpdate[];
}

/**
 * Build the full HTML document string for the impact report.
 *
 * @param options - The project and its updates.
 * @returns A complete HTML document string safe for use as an iframe srcdoc.
 */
export function buildReportHtml({ project, updates }: ReportOptions): string {
  const pct = progressPercent(project.raisedXLM, project.goalXLM);
  const reportDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // ── Escape every user-supplied string ─────────────────────────────────────
  const safeName        = escapeHtml(project.name);
  const safeLocation    = escapeHtml(project.location);
  const safeCategory    = escapeHtml(project.category);
  const safeDescription = escapeHtml(project.description);
  const safeWallet      = escapeHtml(project.walletAddress);

  // ── Update rows ───────────────────────────────────────────────────────────
  const updatesHtml =
    updates.length > 0
      ? `
      <div class="section">
        <h3 class="section-title">Recent Project Updates</h3>
        <ul class="updates-list">
          ${updates
            .slice(0, 5)
            .map((update) => {
              const safeTitle = escapeHtml(update.title);
              const safeBody  = escapeHtml(update.body);
              const safeDate  = escapeHtml(
                new Date(update.createdAt).toLocaleDateString(),
              );
              return `
              <li class="update-item">
                <div class="update-title">${safeTitle}</div>
                <div class="update-date">${safeDate}</div>
                <div class="update-body">${safeBody}</div>
              </li>`;
            })
            .join("")}
        </ul>
      </div>`
      : "";

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${safeName} - Impact Report</title>
    <style>
      @media print {
        @page { margin: 0.75in; }
        body { margin: 0; }
      }

      * { box-sizing: border-box; }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                     'Helvetica Neue', Arial, sans-serif;
        line-height: 1.6;
        color: #1a2e1a;
        max-width: 800px;
        margin: 0 auto;
        padding: 40px 20px;
        background: white;
      }

      .header {
        text-align: center;
        margin-bottom: 40px;
        padding-bottom: 30px;
        border-bottom: 3px solid #227239;
      }

      .logo { font-size: 48px; margin-bottom: 10px; }

      .header h1 {
        font-size: 28px;
        color: #227239;
        margin: 0 0 10px 0;
        font-weight: 700;
      }

      .header .subtitle {
        font-size: 14px;
        color: #4b654b;
        text-transform: uppercase;
        letter-spacing: 2px;
        font-weight: 600;
      }

      .project-header { margin-bottom: 30px; }

      .project-title {
        font-size: 32px;
        color: #1a2e1a;
        margin: 0 0 10px 0;
        font-weight: 700;
      }

      .project-meta {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
        font-size: 14px;
        color: #4b654b;
        margin-bottom: 20px;
      }

      .project-meta span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      .badges {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }

      .badge {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 600;
        border: 2px solid;
      }

      .badge-verified  { background: #e8f5e9; color: #2e7d32; border-color: #4caf50; }
      .badge-funded    { background: #e8f5e9; color: #1b5e20; border-color: #4caf50; }
      .badge-category  { background: #f0f7f0; color: #227239; border-color: #c8dfc8; }

      .section { margin-bottom: 30px; page-break-inside: avoid; }

      .section-title {
        font-size: 20px;
        color: #227239;
        margin: 0 0 15px 0;
        font-weight: 700;
        border-bottom: 2px solid #e8f3e8;
        padding-bottom: 8px;
      }

      .description {
        font-size: 15px;
        line-height: 1.8;
        color: #1a2e1a;
        white-space: pre-wrap;
      }

      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }

      .stat-card {
        background: #f0f7f0;
        border: 2px solid #c8dfc8;
        border-radius: 12px;
        padding: 20px;
        text-align: center;
      }

      .stat-icon  { font-size: 32px; margin-bottom: 8px; }
      .stat-value { font-size: 24px; font-weight: 700; color: #227239; margin-bottom: 5px; }
      .stat-label {
        font-size: 13px;
        color: #4b654b;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-weight: 600;
      }

      .progress-section {
        background: #f0f7f0;
        border: 2px solid #c8dfc8;
        border-radius: 12px;
        padding: 25px;
        margin-bottom: 30px;
      }

      .progress-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 12px;
        font-size: 14px;
        font-weight: 600;
      }

      .progress-bar {
        height: 24px;
        background: #c8dfc8;
        border-radius: 12px;
        overflow: hidden;
        position: relative;
      }

      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #227239, #4caf70);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: 700;
        font-size: 13px;
      }

      .updates-list { list-style: none; padding: 0; margin: 0; }

      .update-item {
        padding: 15px 0;
        border-bottom: 1px solid #e8f3e8;
      }

      .update-item:last-child { border-bottom: none; }
      .update-title { font-weight: 600; color: #1a2e1a; margin-bottom: 5px; }
      .update-date  { font-size: 12px; color: #547454; margin-bottom: 8px; }
      .update-body  { font-size: 14px; color: #4b654b; line-height: 1.6; }

      .footer {
        margin-top: 50px;
        padding-top: 30px;
        border-top: 2px solid #e8f3e8;
        text-align: center;
        font-size: 12px;
        color: #547454;
      }

      .footer-logo { font-size: 24px; margin-bottom: 10px; }

      .wallet-address {
        font-family: 'Courier New', monospace;
        background: #f0f7f0;
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 11px;
        color: #227239;
        border: 1px solid #c8dfc8;
        word-break: break-all;
      }

      @media print {
        body { font-size: 12pt; }
        .no-print { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="logo">🌱</div>
      <h1>Stellar GreenPay</h1>
      <div class="subtitle">Project Impact Report</div>
    </div>

    <div class="project-header">
      <h2 class="project-title">${safeName}</h2>
      <div class="project-meta">
        <span>📍 ${safeLocation}</span>
        <span>📅 Report Date: ${reportDate}</span>
      </div>
      <div class="badges">
        ${project.verified ? '<span class="badge badge-verified">✓ Verified Project</span>' : ""}
        ${pct >= 100 ? '<span class="badge badge-funded">✅ Fully Funded</span>' : ""}
        <span class="badge badge-category">${safeCategory}</span>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">Project Overview</h3>
      <div class="description">${safeDescription}</div>
    </div>

    <div class="section">
      <h3 class="section-title">Funding Metrics</h3>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">💰</div>
          <div class="stat-value">${formatXLM(project.raisedXLM)}</div>
          <div class="stat-label">Total Raised</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🎯</div>
          <div class="stat-value">${formatXLM(project.goalXLM)}</div>
          <div class="stat-label">Funding Goal</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-value">${project.donorCount.toLocaleString()}</div>
          <div class="stat-label">Total Donors</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📋</div>
          <div class="stat-value">Live record</div>
          <div class="stat-label">Outcome claims on project page</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3 class="section-title">Funding Progress</h3>
      <div class="progress-section">
        <div class="progress-header">
          <span>${formatXLM(project.raisedXLM)} raised</span>
          <span>${pct}% of goal</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${Math.min(pct, 100)}%">
            ${pct >= 100 ? "Goal Reached!" : `${pct}%`}
          </div>
        </div>
      </div>
    </div>

    ${updatesHtml}

    <div class="section">
      <h3 class="section-title">Project Wallet</h3>
      <p style="margin-bottom: 10px; font-size: 14px; color: #4b654b;">
        All donations are sent directly to this Stellar blockchain address:
      </p>
      <div class="wallet-address">${safeWallet}</div>
    </div>

    <div class="footer">
      <div class="footer-logo">🌍</div>
      <p>
        <strong>Stellar GreenPay</strong><br>
        Blockchain-powered climate finance<br>
        Open Source • Built on Stellar • Powered by Soroban
      </p>
      <p style="margin-top: 15px;">
        Learn more at stellar-greenpay.org
      </p>
    </div>
  </body>
</html>`;
}
