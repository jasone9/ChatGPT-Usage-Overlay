'use strict';
// Publish fixture-test results as commit statuses so connected GitHub clients can inspect them.
const fs = require('node:fs');
(async () => {
  const file = 'test-results/browser-diagnostics.json';
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify(data, null, 2));
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_SHA) return;
  const details = [
    ['Browser integration', data.stage === 'passed' ? `${data.checks.length} browser checks passed` : `${data.stage}: ${data.error}`, data.stage === 'passed' ? 'success' : 'failure'],
    ['Browser diagnostics / pages', JSON.stringify(data.pages || []), 'success'],
    ['Browser diagnostics / worker', JSON.stringify(data.workers || []), 'success'],
    ['Browser diagnostics / reader', JSON.stringify(data.storage?.session?.reader || {}), 'success'],
    ['Browser diagnostics / status', JSON.stringify(data.storage?.local?.readerStatus || {}), 'success'],
    ['Browser diagnostics / probe', JSON.stringify(data.storage?.probe || {}), 'success'],
    ['Browser diagnostics / fixture requests', String(data.usageRequests ?? 'passed'), 'success']
  ];
  for (const [context, description, state] of details) {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/statuses/${process.env.GITHUB_SHA}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, description: description.slice(0, 140), state })
    });
    if (!response.ok) throw Error(`Could not report browser result: HTTP ${response.status}`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
