const KEY = 'super-baodan.skill-groups.v1';
export function createSkillGroups() {
  let collapsed = {};
  try { const saved = JSON.parse(localStorage.getItem(KEY)); if (saved && typeof saved === 'object') collapsed = saved; } catch {}
  return (scope, label, count, searching) => {
    const group = document.createElement('details'); group.className = 'skill-group'; group.dataset.scope = scope;
    group.open = searching || collapsed[scope] !== true;
    const summary = document.createElement('summary'); summary.className = 'skill-group-title'; summary.textContent = `${label} · ${count}`;
    group.append(summary);
    group.addEventListener('toggle', () => {
      if (!group.isConnected || searching) return;
      collapsed[scope] = !group.open;
      try { localStorage.setItem(KEY, JSON.stringify(collapsed)); } catch {}
    });
    return group;
  };
}
