'use strict';
const crypto = require('node:crypto');

// Build metadata only. One catalog owns the default set; no host inventory or downloads.
function snapshot(bytes) {
  const catalog = JSON.parse(bytes);
  if (catalog.schemaVersion !== 1 || catalog.status !== 'local-candidate' || catalog.publicReleaseReady !== false || !Array.isArray(catalog.skills)) throw new Error('Expected local candidate catalog');
  const ids = new Set();
  for (const item of catalog.skills) {
    if (!/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id) || typeof item.defaultInstall !== 'boolean') throw new Error('Invalid catalog identity');
    ids.add(item.id);
  }
  const selected = catalog.skills.filter(item => item.defaultInstall);
  if (!selected.length) throw new Error('Empty default set');
  const skills = selected.map(item => {
    if (typeof item.description !== 'string' || !item.description || !/^[a-f0-9]{64}$/.test(item.contentSha256) || !item.runtime?.minimumVersion || typeof item.version !== 'string') throw new Error('Incomplete Skill metadata');
    return { name: item.id, description: item.description, version: item.version, contentSha256: item.contentSha256,
      minimumRuntimeVersion: item.runtime.minimumVersion, installed: 'unknown', enabled: 'unknown', loaded: 'unknown', compatible: 'unknown' };
  });
  return { schemaVersion: 2, sourceKind: 'independent-local-candidates', pluginId: 'chengfeng-videocut',
    publicReleaseReady: false, catalogSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    installUnit: 'independent-skill', skills };
}
function source(bytes) {
  return `// Generated from skills.local-candidate.json. Not an installation inventory.\nexport const SKILL_DIRECTORY = ${JSON.stringify(snapshot(bytes), null, 2)} as const;\n`;
}
module.exports = { snapshot, source };
