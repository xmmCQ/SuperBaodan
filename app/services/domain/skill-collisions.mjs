import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { skillTreeDigest } from './skill-transfer.mjs';

// Compare the entire skill, including scripts/references, not only SKILL.md.
// Unknown/oversized/link-containing trees must never be labelled identical.
export async function markSkillCollisions(skills) {
  const groups = new Map();
  for (const skill of skills) {
    const group = groups.get(skill.name) || [];
    group.push(skill); groups.set(skill.name, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const digests = await Promise.all(group.map(async skill => {
      try {
        const file = await realpath(skill.filePath);
        if (path.basename(file).toLowerCase() !== 'skill.md') return null;
        return await skillTreeDigest(path.dirname(file), { maxBytes: 32 * 1024 * 1024 });
      } catch { return null; }
    }));
    const known = digests.filter(value => value !== null);
    const kind = new Set(known).size > 1 ? 'conflict'
      : known.length !== group.length ? 'unverified' : 'duplicate';
    for (const skill of group) {
      skill.collision = {
        kind,
        peers: group.filter(peer => peer !== skill).map(peer => ({
          id: peer.id, scope: peer.scope, filePath: peer.filePath, loadState: peer.loadState,
        })),
      };
    }
  }
  return skills;
}
