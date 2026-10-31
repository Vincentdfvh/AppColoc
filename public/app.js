// Interface de l'app coloc. Les données vivent sur le serveur ; on les recharge régulièrement
// pour voir les changements faits par les autres colocs.

const $ = (s) => document.querySelector(s);
const POLL_MS = 4000;

let state = { people: [], shopping: [], tasks: [], settings: {} };
let lastJson = '';
let editingTaskId = null;

// ---------- Préférences de cet appareil ----------

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value ?? ''); } catch { /* stockage indisponible */ }
}
const getMe = () => Number(load('coloc.me')) || null;

// ---------- Outils ----------

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

async function refresh(force = false) {
  try {
    const s = await api('GET', '/state');
    const json = JSON.stringify(s);
    if (force || json !== lastJson) {
      lastJson = json;
      state = s;
      render();
    }
    document.body.classList.remove('offline');
  } catch {
    document.body.classList.add('offline');
  }
}

async function act(fn) {
  try {
    await fn();
    await refresh(true);
  } catch (e) {
    toast(e.message);
  }
}

// Crée un élément DOM (le texte est toujours inséré en texte brut, jamais en HTML).
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

const person = (id) => state.people.find((p) => p.id === id);
const nameOf = (id) => person(id)?.name ?? '—';
const activePeople = () => state.people.filter((p) => p.active);

// Demande qui fait l'action ; null si personne n'est choisi.
function requireMe() {
  const me = getMe();
  if (me && person(me)?.active) return me;
  if (!activePeople().length) {
    toast("Ajoute d'abord les colocs dans l'onglet Colocs");
    showTab('colocs');
  } else {
    toast('Choisis qui tu es en haut de la page');
    $('#me').focus();
  }
  return null;
}

// ---------- Dates ----------

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => isoDay(new Date());

function dueLabel(due) {
  if (!due) return null;
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.round((date - now) / 86400000);
  if (diff < 0) return { text: `En retard (${shortDate(date)})`, cls: 'late' };
  if (diff === 0) return { text: "Aujourd'hui", cls: 'today' };
  if (diff === 1) return { text: 'Demain', cls: '' };
  if (diff < 7) return { text: date.toLocaleDateString('fr-CH', { weekday: 'long' }), cls: '' };
  return { text: shortDate(date), cls: '' };
}

const shortDate = (date) => date.toLocaleDateString('fr-CH', { day: 'numeric', month: 'short' });
// Les dates du serveur sont en UTC au format "AAAA-MM-JJ HH:MM:SS".
const fromServer = (s) => shortDate(new Date(s.replace(' ', 'T') + 'Z'));

const REC_LABELS = {
  daily: 'chaque jour',
  weekly: 'chaque semaine',
  biweekly: 'toutes les 2 sem.',
  monthly: 'chaque mois',
};

// ---------- Rendu ----------

function render() {
  renderMe();
  renderShopping();
  renderTasks();
  renderTricount();
  renderPeople();
}

function renderMe() {
  const sel = $('#me');
  const me = getMe();
  const active = activePeople();
  sel.replaceChildren(
    el('option', { value: '' }, active.length ? '— choisir —' : '— aucun coloc —'),
    ...active.map((p) => el('option', { value: p.id, selected: p.id === me }, p.name)),
  );
  if (me && !active.some((p) => p.id === me)) save('coloc.me', '');
}

function renderShopping() {
  const toBuy = state.shopping.filter((i) => !i.bought_at);
  const bought = state.shopping
    .filter((i) => i.bought_at)
    .sort((a, b) => b.bought_at.localeCompare(a.bought_at));

  $('#shop-list').replaceChildren(
    ...toBuy.map((i) =>
      el('li', {},
        el('button', {
          class: 'tick', 'aria-label': `Marquer ${i.name} comme acheté`,
          onclick: () => {
            const me = requireMe();
            if (me) act(() => api('PATCH', `/shopping/${i.id}`, { bought: true, by: me }));
          },
        }),
        el('div', { class: 'body' },
          el('div', { class: 'title' }, i.name, i.qty && el('span', { class: 'qty-badge' }, i.qty)),
          el('div', { class: 'meta' }, i.added_by ? `Demandé par ${nameOf(i.added_by)}` : 'Ajouté', ' · ', fromServer(i.created_at)),
        ),
        el('button', {
          class: 'icon', 'aria-label': `Supprimer ${i.name}`,
          onclick: () => act(() => api('DELETE', `/shopping/${i.id}`)),
        }, '✕'),
      ),
    ),
  );
  $('#shop-empty').hidden = toBuy.length > 0;

  $('#shop-bought-wrap').hidden = bought.length === 0;
  $('#shop-bought').replaceChildren(
    ...bought.map((i) =>
      el('li', {},
        el('button', {
          class: 'tick on', 'aria-label': `Remettre ${i.name} dans la liste`,
          onclick: () => act(() => api('PATCH', `/shopping/${i.id}`, { bought: false })),
        }, '✓'),
        el('div', { class: 'body' },
          el('div', { class: 'title' }, i.name, i.qty && el('span', { class: 'qty-badge' }, i.qty)),
          el('div', { class: 'meta' }, `Acheté par ${nameOf(i.bought_by)} · ${fromServer(i.bought_at)}`),
        ),
      ),
    ),
  );
}

function renderTasks() {
  const me = getMe();
  const onlyMine = $('#only-mine').checked;
  const open = state.tasks
    .filter((t) => !t.done && (!onlyMine || t.assignee_id === me))
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.title.localeCompare(b.title));
  const done = state.tasks
    .filter((t) => t.done && (!onlyMine || t.last_done_by === me))
    .sort((a, b) => (b.last_done_at ?? '').localeCompare(a.last_done_at ?? ''));

  $('#task-list').replaceChildren(
    ...open.map((t) => {
      const due = dueLabel(t.due_date);
      return el('li', { class: t.assignee_id && t.assignee_id === me ? 'mine' : '' },
        el('button', {
          class: 'tick', 'aria-label': `Marquer ${t.title} comme faite`,
          onclick: () => {
            const by = requireMe();
            if (!by) return;
            act(async () => {
              await api('POST', `/tasks/${t.id}/complete`, { by });
              if (t.recurrence !== 'none') toast('Bravo ! Prochaine fois programmée.');
            });
          },
        }),
        el('div', { class: 'body clickable', onclick: () => openTaskDialog(t) },
          el('div', { class: 'title' }, t.title),
          el('div', { class: 'chips' },
            el('span', { class: 'chip' + (t.assignee_id ? '' : ' warn') }, '👤 ', t.assignee_id ? nameOf(t.assignee_id) : 'Personne'),
            t.recurrence !== 'none' && el('span', { class: 'chip' }, '🔁 ', REC_LABELS[t.recurrence]),
            due && el('span', { class: `chip ${due.cls}` }, '📅 ', due.text),
          ),
          t.last_done_at && el('div', { class: 'meta' }, `Dernière fois : ${nameOf(t.last_done_by)} · ${fromServer(t.last_done_at)}`),
        ),
      );
    }),
  );
  $('#task-empty').hidden = open.length > 0;

  $('#task-done-wrap').hidden = done.length === 0;
  $('#task-done').replaceChildren(
    ...done.map((t) =>
      el('li', {},
        el('button', {
          class: 'tick on', 'aria-label': `Rouvrir ${t.title}`,
          onclick: () => act(() => api('POST', `/tasks/${t.id}/reopen`)),
        }, '✓'),
        el('div', { class: 'body' },
          el('div', { class: 'title' }, t.title),
          el('div', { class: 'meta' }, `Fait par ${nameOf(t.last_done_by)} · ${fromServer(t.last_done_at)}`),
        ),
        el('button', {
          class: 'icon', 'aria-label': `Supprimer ${t.title}`,
          onclick: () => act(() => api('DELETE', `/tasks/${t.id}`)),
        }, '✕'),
      ),
    ),
  );
}

function renderTricount() {
  const url = state.settings.tricount_url;
  const link = $('#tricount-link');
  link.hidden = !url;
  $('#tricount-empty').hidden = !!url;
  if (url) link.href = url;
  const input = $('#tricount-form [name=url]');
  if (document.activeElement !== input) input.value = url ?? '';
}

function renderPeople() {
  const active = activePeople();
  const old = state.people.filter((p) => !p.active);
  const openTasks = (id) => state.tasks.filter((t) => !t.done && t.assignee_id === id).length;

  $('#people-active').replaceChildren(
    ...active.map((p) => {
      const n = openTasks(p.id);
      return el('li', {},
        el('div', { class: 'avatar' }, p.name.slice(0, 1).toUpperCase()),
        el('div', { class: 'body' },
          el('div', { class: 'title' }, p.name, p.id === getMe() && el('span', { class: 'qty-badge' }, 'moi')),
          el('div', { class: 'meta' }, n ? `${n} tâche${n > 1 ? 's' : ''} en cours` : 'Aucune tâche en cours'),
        ),
        el('button', {
          class: 'small', onclick: () => {
            const name = prompt('Nouveau nom', p.name);
            if (name && name.trim() !== p.name) act(() => api('PATCH', `/people/${p.id}`, { name }));
          },
        }, 'Renommer'),
        el('button', {
          class: 'small', onclick: () => {
            if (confirm(`${p.name} quitte la coloc ? Ses tâches récurrentes passeront au coloc suivant.`)) {
              act(() => api('PATCH', `/people/${p.id}`, { active: false }));
            }
          },
        }, 'Est parti'),
      );
    }),
  );
  $('#people-empty').hidden = active.length > 0;

  $('#people-old-wrap').hidden = old.length === 0;
  $('#people-old').replaceChildren(
    ...old.map((p) =>
      el('li', {},
        el('div', { class: 'avatar' }, p.name.slice(0, 1).toUpperCase()),
        el('div', { class: 'body' }, el('div', { class: 'title' }, p.name)),
        el('button', {
          class: 'small', onclick: () => act(() => api('PATCH', `/people/${p.id}`, { active: true })),
        }, 'Revenu'),
        el('button', {
          class: 'small danger', onclick: () => {
            if (confirm(`Supprimer définitivement ${p.name} ? Son nom disparaîtra de l'historique.`)) {
              act(() => api('DELETE', `/people/${p.id}`));
            }
          },
        }, 'Supprimer'),
      ),
    ),
  );
}

// ---------- Dialogue des tâches ----------

function openTaskDialog(task = null) {
  editingTaskId = task?.id ?? null;
  const f = $('#task-form');
  $('#task-dialog-title').textContent = task ? 'Modifier la tâche' : 'Nouvelle tâche';
  $('#task-delete').hidden = !task;

  // Les anciens colocs restent visibles s'ils sont encore responsables de cette tâche.
  const options = activePeople();
  const current = task?.assignee_id && person(task.assignee_id);
  if (current && !current.active) options.push(current);
  const selected = task ? task.assignee_id : getMe();
  f.assignee_id.replaceChildren(
    el('option', { value: '' }, 'Personne'),
    ...options.map((p) => el('option', { value: p.id, selected: p.id === selected }, p.name + (p.active ? '' : ' (parti)'))),
  );

  f.title.value = task?.title ?? '';
  f.recurrence.value = task?.recurrence ?? 'none';
  f.rotate.checked = task ? !!task.rotate : true;
  f.due_date.value = task?.due_date ?? '';
  syncRotate();
  $('#task-dialog').showModal();
  if (!task) f.title.focus();
}

function syncRotate() {
  const f = $('#task-form');
  $('#rotate-row').hidden = f.recurrence.value === 'none';
  if (f.recurrence.value !== 'none' && !f.due_date.value) f.due_date.value = todayIso();
}

// ---------- Onglets ----------

function showTab(name) {
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  save('coloc.tab', name);
}

// ---------- Événements ----------

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

$('#me').addEventListener('change', (e) => {
  save('coloc.me', e.target.value);
  render();
});

$('#shop-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const me = requireMe();
  if (!me) return;
  act(async () => {
    await api('POST', '/shopping', { name: f.name.value, qty: f.qty.value, added_by: me });
    f.reset();
    f.name.focus();
  });
});

$('#clear-bought').addEventListener('click', () => {
  if (confirm('Effacer tous les articles achetés ?')) act(() => api('POST', '/shopping/clear-bought'));
});

$('#only-mine').addEventListener('change', (e) => {
  save('coloc.onlyMine', e.target.checked ? '1' : '');
  renderTasks();
});

$('#new-task').addEventListener('click', () => openTaskDialog());
$('#clear-done').addEventListener('click', () => {
  if (confirm('Effacer toutes les tâches terminées ?')) act(() => api('POST', '/tasks/clear-done'));
});

$('#task-form').recurrence.addEventListener('change', syncRotate);
$('#task-cancel').addEventListener('click', () => $('#task-dialog').close());
$('#task-delete').addEventListener('click', () => {
  if (!editingTaskId || !confirm('Supprimer cette tâche ?')) return;
  const id = editingTaskId;
  $('#task-dialog').close();
  act(() => api('DELETE', `/tasks/${id}`));
});

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    title: f.title.value,
    assignee_id: f.assignee_id.value || null,
    recurrence: f.recurrence.value,
    rotate: f.rotate.checked,
    due_date: f.due_date.value || null,
  };
  const id = editingTaskId;
  act(async () => {
    await (id ? api('PUT', `/tasks/${id}`, body) : api('POST', '/tasks', body));
    $('#task-dialog').close();
  });
});

$('#tricount-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.url;
  act(async () => {
    await api('PUT', '/settings', { tricount_url: input.value });
    input.blur();
    toast('Lien enregistré');
  });
});

$('#person-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  act(async () => {
    const { id } = await api('POST', '/people', { name: f.name.value });
    if (!getMe()) save('coloc.me', id);
    f.reset();
  });
});

// ---------- Démarrage ----------

$('#only-mine').checked = load('coloc.onlyMine') === '1';
showTab(load('coloc.tab') || 'courses');
refresh(true);
setInterval(() => {
  if (!document.hidden && !$('#task-dialog').open) refresh();
}, POLL_MS);
document.addEventListener('visibilitychange', () => !document.hidden && refresh());
