const fs = require('node:fs');
const path = require('node:path');
const { projectRoot } = require('../src/core/config');
const {
  findWorkTaskByActivityId,
  importActivityAsWorkTask,
} = require('../src/core/workTaskStore');

const apply = process.argv.includes('--apply');
const activityRoot = path.resolve(process.env.AGENTTOOLS_ACTIVITY_ROOT || path.join(projectRoot, 'state', 'activity'));
const stateFile = path.join(activityRoot, 'activities.json');

if (!fs.existsSync(stateFile)) {
  console.log(JSON.stringify({ ok: true, apply, migrated: 0, skipped: 0, reason: 'activity store not found' }, null, 2));
  process.exit(0);
}

const store = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const activities = Array.isArray(store.activities) ? store.activities : [];
let migrated = 0;
let skipped = 0;
const preview = [];

for (const activity of activities) {
  if (!activity?.id) continue;
  if (findWorkTaskByActivityId(activity.id)) {
    skipped += 1;
    continue;
  }
  preview.push({ id: activity.id, title: activity.title || activity.id, status: activity.status || 'running' });
  if (apply) {
    importActivityAsWorkTask(activity);
    migrated += 1;
  }
}

console.log(JSON.stringify({
  ok: true,
  apply,
  migrated,
  wouldMigrate: apply ? 0 : preview.length,
  skipped,
  preview: preview.slice(0, 20),
  previewTruncated: preview.length > 20,
}, null, 2));
