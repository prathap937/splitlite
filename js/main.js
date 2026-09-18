import { uid, loadState, saveState } from './storage.js';
import {
  CURRENCIES, FALLBACK_RATES, getRates, convert, fetchLiveRates, formatMoney, round2,
} from './currency.js';
import {
  computeBalances, computeSettlements, totalSpendByMember, shareBaseAmount,
  computeEqualSplits, computePercentSplits,
} from './balances.js';
import { toCsv, parseCsv } from './csv.js';
import { createShareOffer, createJoinAnswer, completeShare } from './sync.js';
import { renderQrCode } from './qr.js';

const state = loadState();
let currentTab = 'expenses';
let currentDetailExpenseId = null;

const el = (id) => document.getElementById(id);

const groupSelect = el('group-select');
const emptyState = el('empty-state');
const groupView = el('group-view');
const groupNameHeading = el('group-name-heading');
const expenseList = el('expense-list');
const balancesContent = el('balances-content');
const memberList = el('member-list');

const modalGroup = el('modal-group');
const modalExpense = el('modal-expense');
const modalExpenseDetail = el('modal-expense-detail');
const modalSettings = el('modal-settings');
const modalSync = el('modal-sync');

function persist() {
  saveState(state);
}

function activeGroup() {
  return state.groups.find((g) => g.id === state.activeGroupId) || null;
}

function memberName(group, memberId) {
  const m = group.members.find((x) => x.id === memberId);
  return m ? m.name : 'Unknown';
}

// ---------- Rendering ----------

function render() {
  renderGroupSelect();
  const group = activeGroup();

  if (!group) {
    emptyState.hidden = false;
    groupView.hidden = true;
    return;
  }

  emptyState.hidden = true;
  groupView.hidden = false;
  groupNameHeading.textContent = `${group.name} (${group.baseCurrency})`;

  renderTabButtons();
  if (currentTab === 'expenses') renderExpenses(group);
  if (currentTab === 'balances') renderBalances(group);
  if (currentTab === 'members') renderMembers(group);
}

function renderGroupSelect() {
  groupSelect.innerHTML = '';
  if (state.groups.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No groups';
    groupSelect.appendChild(opt);
    return;
  }
  state.groups.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    opt.selected = g.id === state.activeGroupId;
    groupSelect.appendChild(opt);
  });
}

function renderTabButtons() {
  document.querySelectorAll('.tab').forEach((btn) => {
    const isActive = btn.dataset.tab === currentTab;
    btn.classList.toggle('active', isActive);
  });
  el('tab-expenses').hidden = currentTab !== 'expenses';
  el('tab-balances').hidden = currentTab !== 'balances';
  el('tab-members').hidden = currentTab !== 'members';
}

function expensesByDateDesc(group) {
  return [...group.expenses].sort((a, b) => {
    if (a.date === b.date) return 0;
    return a.date < b.date ? 1 : -1;
  });
}

function renderExpenses(group) {
  if (group.expenses.length === 0) {
    expenseList.innerHTML = `
      <p class="empty-hint">No expenses yet. Add one to get started.</p>
      <button type="button" id="btn-expense-empty-scan-join" class="btn btn-secondary btn-small">Or scan a QR code to import someone's data</button>
    `;
    return;
  }
  const sorted = expensesByDateDesc(group);
  expenseList.innerHTML = sorted.map((exp) => {
    const payer = memberName(group, exp.paidBy);
    const showConverted = exp.currency !== group.baseCurrency;
    const isSelected = exp.id === currentDetailExpenseId;
    return `
      <div class="card expense-card${isSelected ? ' is-selected' : ''}" data-expense-id="${exp.id}" tabindex="0" role="button">
        <div class="expense-main">
          <div class="expense-title">${escapeHtml(exp.description)}</div>
          <div class="expense-meta">${exp.date} &middot; paid by ${escapeHtml(payer)} &middot; split ${exp.splitMode} ${settleSummaryBadge(exp)}</div>
        </div>
        <div class="expense-amounts">
          <div class="expense-amount-base">${formatMoney(showConverted ? exp.baseAmount : exp.amount, group.baseCurrency)}</div>
          ${showConverted ? `<div class="expense-amount-orig">${formatMoney(exp.amount, exp.currency)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function settleSummaryBadge(exp) {
  const owers = exp.splits.filter((s) => s.memberId !== exp.paidBy);
  if (owers.length === 0) return '';
  const settledCount = owers.filter((s) => s.settled).length;
  if (settledCount === 0) return '';
  const allSettled = settledCount === owers.length;
  return `<span class="settle-badge ${allSettled ? 'all' : 'partial'}">${allSettled ? 'settled' : `${settledCount}/${owers.length} settled`}</span>`;
}

function renderBalances(group) {
  const balances = computeBalances(group);
  const settlements = computeSettlements(balances);
  const spend = totalSpendByMember(group);
  const totalSpend = round2(Object.values(spend).reduce((s, v) => s + v, 0));
  const maxBalance = Math.max(1, ...Object.values(balances).map((v) => Math.abs(v)));
  const maxSpend = Math.max(1, ...Object.values(spend));

  const balanceRows = group.members.map((m) => {
    const bal = balances[m.id] || 0;
    const pct = Math.min(100, (Math.abs(bal) / maxBalance) * 100);
    const cls = bal >= 0 ? 'positive' : 'negative';
    return `
      <div class="balance-row">
        <div class="balance-name">${escapeHtml(m.name)}</div>
        <div class="balance-bar-track"><div class="balance-bar-fill ${cls}" style="width:${pct}%"></div></div>
        <div class="balance-amount ${cls}">${formatMoney(bal, group.baseCurrency)}</div>
      </div>
    `;
  }).join('');

  const settlementRows = settlements.length === 0
    ? '<p class="empty-hint">Everyone is settled up.</p>'
    : settlements.map((s) => `
      <div class="settlement-row card">
        <strong>${escapeHtml(memberName(group, s.from))}</strong>
        <span class="settlement-arrow">pays</span>
        <strong>${escapeHtml(memberName(group, s.to))}</strong>
        <span class="settlement-suggested-amount">${formatMoney(s.amount, group.baseCurrency)}</span>
        <button type="button" class="btn btn-small btn-secondary" data-action="use-settlement"
          data-from="${s.from}" data-to="${s.to}" data-amount="${s.amount}">Use amount</button>
      </div>
    `).join('');

  const memberOptions = group.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');

  const history = [...(group.settlements || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
  const historyRows = history.length === 0
    ? '<p class="empty-hint">No payments recorded yet.</p>'
    : history.map((st) => `
      <div class="settlement-row card">
        <strong>${escapeHtml(memberName(group, st.fromId))}</strong>
        <span class="settlement-arrow">paid</span>
        <strong>${escapeHtml(memberName(group, st.toId))}</strong>
        <span class="settlement-suggested-amount">${formatMoney(st.amount, group.baseCurrency)}</span>
        <span class="hint">${st.date}</span>
        <button type="button" class="btn btn-small btn-danger" data-action="delete-settlement" data-id="${st.id}">Undo</button>
      </div>
    `).join('');

  const spendRows = group.members.map((m) => {
    const amt = spend[m.id] || 0;
    const pct = Math.min(100, (amt / maxSpend) * 100);
    return `
      <div class="spend-row">
        <div class="spend-name">${escapeHtml(m.name)}</div>
        <div class="spend-bar-track"><div class="spend-bar-fill" style="width:${pct}%"></div></div>
        <div class="spend-amount">${formatMoney(amt, group.baseCurrency)}</div>
      </div>
    `;
  }).join('');

  balancesContent.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Total spend</div><div class="stat-value">${formatMoney(totalSpend, group.baseCurrency)}</div></div>
      <div class="stat-card"><div class="stat-label">Expenses</div><div class="stat-value">${group.expenses.length}</div></div>
      <div class="stat-card"><div class="stat-label">Members</div><div class="stat-value">${group.members.length}</div></div>
    </div>

    <h3>Net balance</h3>
    <div class="stack">${balanceRows || '<p class="empty-hint">Add members to see balances.</p>'}</div>

    <h3>Suggested settlements</h3>
    <div class="stack">${settlementRows}</div>

    <h3>Record a payment</h3>
    <p class="hint">Log any amount someone actually paid back &mdash; doesn't have to match a suggestion above.</p>
    <form id="form-record-settlement" class="settlement-form card">
      <select id="settlement-from" required>${memberOptions}</select>
      <span>pays</span>
      <select id="settlement-to" required>${memberOptions}</select>
      <input type="number" id="settlement-amount" min="0.01" step="0.01" placeholder="Amount (${group.baseCurrency})" required />
      <button type="submit" class="btn btn-primary btn-small">Record payment</button>
    </form>

    <h3>Payment history</h3>
    <div class="stack">${historyRows}</div>

    <h3>Spend by member</h3>
    <div class="stack">${spendRows || '<p class="empty-hint">No spend yet.</p>'}</div>
  `;
}

balancesContent.addEventListener('click', (e) => {
  const useBtn = e.target.closest('[data-action="use-settlement"]');
  if (useBtn) {
    el('settlement-from').value = useBtn.dataset.from;
    el('settlement-to').value = useBtn.dataset.to;
    el('settlement-amount').value = useBtn.dataset.amount;
    el('settlement-amount').focus();
    return;
  }
  const deleteBtn = e.target.closest('[data-action="delete-settlement"]');
  if (deleteBtn) {
    const group = activeGroup();
    if (!group || !confirm('Remove this recorded payment?')) return;
    group.settlements = (group.settlements || []).filter((s) => s.id !== deleteBtn.dataset.id);
    persist();
    renderBalances(group);
  }
});

balancesContent.addEventListener('submit', (e) => {
  const form = e.target.closest('#form-record-settlement');
  if (!form) return;
  e.preventDefault();
  const group = activeGroup();
  if (!group) return;

  const fromId = el('settlement-from').value;
  const toId = el('settlement-to').value;
  const amount = round2(parseFloat(el('settlement-amount').value) || 0);

  if (!fromId || !toId || fromId === toId || amount <= 0) {
    alert('Pick two different members and enter a valid amount.');
    return;
  }

  group.settlements = group.settlements || [];
  group.settlements.push({
    id: uid(), fromId, toId, amount, date: new Date().toISOString().slice(0, 10),
  });
  persist();
  renderBalances(group);
});

function renderMembers(group) {
  if (group.members.length === 0) {
    memberList.innerHTML = '<p class="empty-hint">No members yet. Add someone above.</p>';
    return;
  }
  memberList.innerHTML = group.members.map((m) => `
    <div class="card member-row" data-member-id="${m.id}">
      <span>${escapeHtml(m.name)}</span>
      <button class="btn btn-small btn-danger" data-action="delete-member" data-id="${m.id}">Remove</button>
    </div>
  `).join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Group creation ----------

function populateCurrencySelect(selectEl, selected) {
  selectEl.innerHTML = CURRENCIES.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}

function openSyncScanJoin() {
  modalSync.showModal();
  startScanner('join');
}

el('btn-new-group').addEventListener('click', openGroupModal);
el('btn-empty-new-group').addEventListener('click', openGroupModal);
el('btn-empty-scan-join').addEventListener('click', openSyncScanJoin);

function openGroupModal() {
  el('group-name').value = '';
  el('group-members').value = '';
  populateCurrencySelect(el('group-currency'), 'USD');
  modalGroup.showModal();
}

el('form-group').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el('group-name').value.trim();
  if (!name) return;
  const baseCurrency = el('group-currency').value;
  const memberNames = el('group-members').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const group = {
    id: uid(),
    name,
    baseCurrency,
    createdAt: new Date().toISOString(),
    members: memberNames.map((n) => ({ id: uid(), name: n })),
    expenses: [],
    settlements: [],
  };

  state.groups.push(group);
  state.activeGroupId = group.id;
  persist();
  modalGroup.close();
  render();
});

groupSelect.addEventListener('change', () => {
  state.activeGroupId = groupSelect.value;
  persist();
  render();
});

// ---------- Tabs ----------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    render();
  });
});

// ---------- Members ----------

el('form-add-member').addEventListener('submit', (e) => {
  e.preventDefault();
  const group = activeGroup();
  if (!group) return;
  const nameInput = el('new-member-name');
  const name = nameInput.value.trim();
  if (!name) return;
  group.members.push({ id: uid(), name });
  nameInput.value = '';
  persist();
  render();
});

memberList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="delete-member"]');
  if (!btn) return;
  const group = activeGroup();
  const memberId = btn.dataset.id;
  const usedInExpense = group.expenses.some(
    (exp) => exp.paidBy === memberId || exp.splits.some((s) => s.memberId === memberId)
  );
  if (usedInExpense) {
    alert('This member is referenced in one or more expenses. Delete those expenses first.');
    return;
  }
  group.members = group.members.filter((m) => m.id !== memberId);
  persist();
  render();
});

// ---------- Expenses ----------

let splitMode = 'equal';

el('btn-add-expense').addEventListener('click', () => {
  const group = activeGroup();
  if (!group) return;
  if (group.members.length === 0) {
    alert('Add at least one member before creating an expense.');
    return;
  }
  el('expense-description').value = '';
  el('expense-amount').value = '';
  el('expense-form-error').hidden = true;
  el('expense-date').value = new Date().toISOString().slice(0, 10);
  populateCurrencySelect(el('expense-currency'), group.baseCurrency);

  const paidBySelect = el('expense-paid-by');
  paidBySelect.innerHTML = group.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');

  splitMode = 'equal';
  document.querySelectorAll('input[name="split-mode"]').forEach((r) => { r.checked = r.value === 'equal'; });

  renderSplitRows(group);
  updateConversionNote(group);
  modalExpense.showModal();
});

document.querySelectorAll('input[name="split-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    splitMode = radio.value;
    renderSplitRows(activeGroup());
  });
});

el('expense-amount').addEventListener('input', () => {
  renderSplitRows(activeGroup());
  updateConversionNote(activeGroup());
});
el('expense-currency').addEventListener('change', () => updateConversionNote(activeGroup()));

function currentAmount() {
  return parseFloat(el('expense-amount').value) || 0;
}

function updateConversionNote(group) {
  const note = el('expense-conversion-note');
  const currency = el('expense-currency').value;
  if (!group || currency === group.baseCurrency) {
    note.textContent = '';
    return;
  }
  const rates = getRates(state.rates);
  const rate = convert(1, currency, group.baseCurrency, rates);
  const amount = currentAmount();
  const converted = convert(amount, currency, group.baseCurrency, rates);
  note.textContent = `1 ${currency} ≈ ${rate.toFixed(4)} ${group.baseCurrency} — total converts to ${formatMoney(converted, group.baseCurrency)}`;
}

function renderSplitRows(group) {
  if (!group) return;
  const container = el('expense-split-rows');
  const amount = currentAmount();

  if (splitMode === 'equal') {
    container.innerHTML = group.members.map((m) => `
      <div class="split-row">
        <label class="split-name"><input type="checkbox" class="split-include" value="${m.id}" checked /> ${escapeHtml(m.name)}</label>
        <span class="split-preview" data-preview-for="${m.id}"></span>
      </div>
    `).join('');
    updateEqualPreview(group, amount);
    container.querySelectorAll('.split-include').forEach((cb) => {
      cb.addEventListener('change', () => updateEqualPreview(group, currentAmount()));
    });
  } else if (splitMode === 'amount') {
    container.innerHTML = group.members.map((m) => `
      <div class="split-row">
        <label class="split-name"><input type="checkbox" class="split-include" value="${m.id}" checked /> ${escapeHtml(m.name)}</label>
        <input type="number" class="split-value" data-member="${m.id}" min="0" step="0.01" placeholder="0.00" />
      </div>
    `).join('');
  } else {
    container.innerHTML = group.members.map((m) => `
      <div class="split-row">
        <label class="split-name"><input type="checkbox" class="split-include" value="${m.id}" checked /> ${escapeHtml(m.name)}</label>
        <input type="number" class="split-value" data-member="${m.id}" min="0" max="100" step="0.1" placeholder="%" />
      </div>
    `).join('');
  }
}

function updateEqualPreview(group, amount) {
  const container = el('expense-split-rows');
  const includedIds = [...container.querySelectorAll('.split-include:checked')].map((cb) => cb.value);
  const shares = computeEqualSplits(amount, includedIds);
  container.querySelectorAll('[data-preview-for]').forEach((span) => {
    const share = shares.find((s) => s.memberId === span.dataset.previewFor);
    span.textContent = share ? formatMoney(share.share, el('expense-currency').value) : '—';
  });
}

el('form-expense').addEventListener('submit', (e) => {
  e.preventDefault();
  const group = activeGroup();
  const errorEl = el('expense-form-error');
  errorEl.hidden = true;

  const description = el('expense-description').value.trim();
  const amount = round2(currentAmount());
  const currency = el('expense-currency').value;
  const paidBy = el('expense-paid-by').value;
  const date = el('expense-date').value;

  if (!description || amount <= 0 || !paidBy || !date) {
    errorEl.textContent = 'Please fill in all fields with a valid amount.';
    errorEl.hidden = false;
    return;
  }

  const container = el('expense-split-rows');
  const includedIds = [...container.querySelectorAll('.split-include:checked')].map((cb) => cb.value);
  if (includedIds.length === 0) {
    errorEl.textContent = 'Select at least one member to split with.';
    errorEl.hidden = false;
    return;
  }

  let splits = [];
  if (splitMode === 'equal') {
    splits = computeEqualSplits(amount, includedIds);
  } else if (splitMode === 'amount') {
    splits = includedIds.map((id) => ({
      memberId: id,
      share: round2(parseFloat(container.querySelector(`.split-value[data-member="${id}"]`).value) || 0),
    }));
    const sum = round2(splits.reduce((s, x) => s + x.share, 0));
    if (Math.abs(sum - amount) > 0.02) {
      errorEl.textContent = `Split amounts (${formatMoney(sum, currency)}) must add up to the total (${formatMoney(amount, currency)}).`;
      errorEl.hidden = false;
      return;
    }
  } else {
    const entries = includedIds.map((id) => ({
      memberId: id,
      percent: parseFloat(container.querySelector(`.split-value[data-member="${id}"]`).value) || 0,
    }));
    const pctSum = round2(entries.reduce((s, x) => s + x.percent, 0));
    if (Math.abs(pctSum - 100) > 0.5) {
      errorEl.textContent = `Percentages must add up to 100% (currently ${pctSum}%).`;
      errorEl.hidden = false;
      return;
    }
    splits = computePercentSplits(amount, entries);
  }

  const rates = getRates(state.rates);
  const baseAmount = round2(convert(amount, currency, group.baseCurrency, rates));

  group.expenses.push({
    id: uid(),
    description,
    amount,
    currency,
    baseAmount,
    date,
    paidBy,
    splitMode,
    splits: splits.map((s) => ({ ...s, settled: false })),
  });

  persist();
  modalExpense.close();
  render();
});

expenseList.addEventListener('click', (e) => {
  if (e.target.closest('#btn-expense-empty-scan-join')) {
    openSyncScanJoin();
    return;
  }
  const card = e.target.closest('.expense-card');
  if (card) openExpenseDetail(card.dataset.expenseId);
});

expenseList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.expense-card');
  if (!card) return;
  e.preventDefault();
  openExpenseDetail(card.dataset.expenseId);
});

// ---------- Expense detail & per-item settling ----------

let editingDate = false;

function openExpenseDetail(expenseId) {
  const group = activeGroup();
  const exp = group && group.expenses.find((x) => x.id === expenseId);
  if (!exp) return;
  currentDetailExpenseId = expenseId;
  editingDate = false;
  renderExpenseDetail(group, exp);
  modalExpenseDetail.showModal();
  renderExpenses(group);
}

modalExpenseDetail.addEventListener('close', () => {
  currentDetailExpenseId = null;
  const group = activeGroup();
  if (group) renderExpenses(group);
});

function renderExpenseDetail(group, exp) {
  const payerName = memberName(group, exp.paidBy);
  const showConverted = exp.currency !== group.baseCurrency;

  const rows = exp.splits.map((s) => {
    const isPayer = s.memberId === exp.paidBy;
    const shareBase = shareBaseAmount(exp, s);
    const name = memberName(group, s.memberId);
    const amountDisplay = showConverted
      ? `${formatMoney(s.share, exp.currency)} <span class="hint">(${formatMoney(shareBase, group.baseCurrency)})</span>`
      : formatMoney(s.share, exp.currency);
    const control = isPayer
      ? '<span class="hint">paid &mdash; no debt</span>'
      : `<label class="settle-toggle"><input type="checkbox" data-split-member="${s.memberId}" ${s.settled ? 'checked' : ''} /> Settled</label>`;
    return `
      <div class="split-detail-row ${s.settled ? 'is-settled' : ''}">
        <span class="split-detail-name">${escapeHtml(name)}</span>
        <span class="split-detail-amount">${amountDisplay}</span>
        <span class="split-detail-control">${control}</span>
      </div>
    `;
  }).join('');

  const dateSection = editingDate
    ? `<span class="expense-detail-date-edit">
        <input type="date" id="expense-detail-date" value="${exp.date}" required />
        <button type="button" class="btn btn-small btn-primary" data-action="save-date">Save</button>
        <button type="button" class="btn btn-small btn-secondary" data-action="cancel-edit-date">Cancel</button>
      </span>`
    : `<span class="expense-detail-date-view">
        ${exp.date}
        <button type="button" class="btn btn-small btn-secondary" data-action="edit-date">Edit date</button>
      </span>`;

  el('expense-detail-content').innerHTML = `
    <div class="expense-detail-header">
      <h2>${escapeHtml(exp.description)}</h2>
      <button type="button" class="btn btn-small btn-danger" data-action="delete-expense">Delete expense</button>
    </div>
    <p class="hint expense-detail-meta">${dateSection} &middot; paid by ${escapeHtml(payerName)}</p>
    <p class="expense-detail-total"><strong>${formatMoney(exp.amount, exp.currency)}</strong>${showConverted ? ` &asymp; ${formatMoney(exp.baseAmount, group.baseCurrency)}` : ''}</p>
    <h3>Split &mdash; mark a member settled once they've paid ${escapeHtml(payerName)} back</h3>
    <div class="stack">${rows}</div>
  `;
}

el('expense-detail-content').addEventListener('click', (e) => {
  const group = activeGroup();
  const exp = group && group.expenses.find((x) => x.id === currentDetailExpenseId);
  if (!exp) return;

  if (e.target.closest('[data-action="delete-expense"]')) {
    if (!confirm(`Delete "${exp.description}"? This can't be undone.`)) return;
    group.expenses = group.expenses.filter((x) => x.id !== exp.id);
    persist();
    modalExpenseDetail.close();
    render();
    return;
  }
  if (e.target.closest('[data-action="edit-date"]')) {
    editingDate = true;
    renderExpenseDetail(group, exp);
    return;
  }
  if (e.target.closest('[data-action="cancel-edit-date"]')) {
    editingDate = false;
    renderExpenseDetail(group, exp);
    return;
  }
  if (e.target.closest('[data-action="save-date"]')) {
    const input = el('expense-detail-date');
    if (!input.value) return;
    exp.date = input.value;
    editingDate = false;
    persist();
    renderExpenseDetail(group, exp);
    render();
  }
});

el('expense-detail-content').addEventListener('change', (e) => {
  const group = activeGroup();
  const exp = group && group.expenses.find((x) => x.id === currentDetailExpenseId);
  if (!exp) return;

  const checkbox = e.target.closest('[data-split-member]');
  if (!checkbox) return;
  const split = exp.splits.find((s) => s.memberId === checkbox.dataset.splitMember);
  if (!split) return;
  split.settled = checkbox.checked;
  persist();
  renderExpenseDetail(group, exp);
  render();
});

// ---------- Settings: rates, export/import/reset ----------

el('btn-settings').addEventListener('click', () => {
  renderRatesPanel();
  modalSettings.showModal();
});

function renderRatesPanel() {
  const status = el('rates-status');
  if (state.rates.values) {
    status.textContent = `Live rates last updated ${new Date(state.rates.updatedAt).toLocaleString()}.`;
  } else {
    status.textContent = 'Using built-in approximate rates (no live fetch yet).';
  }
  const rates = getRates(state.rates);
  el('rates-table').innerHTML = Object.keys(FALLBACK_RATES).map((code) => `
    <div class="rate-cell"><span>${code}</span><span>${(rates[code] ?? 1).toFixed(2)}</span></div>
  `).join('');
}

el('btn-refresh-rates').addEventListener('click', async () => {
  const btn = el('btn-refresh-rates');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  try {
    const rates = await fetchLiveRates();
    state.rates = { values: rates, updatedAt: new Date().toISOString() };
    persist();
    renderRatesPanel();
    render();
  } catch (err) {
    el('rates-status').textContent = "Couldn't fetch live rates (offline?). Still using built-in rates.";
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh live rates';
  }
});

el('btn-export-data').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `splitlite-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

el('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.groups)) throw new Error('Invalid backup file');
    if (!confirm('Import will replace your current data. Continue?')) return;
    Object.assign(state, parsed);
    state.activeGroupId = state.groups[0]?.id || null;
    persist();
    render();
    modalSettings.close();
  } catch (err) {
    alert('Could not import this file. Make sure it is a SplitLite backup JSON.');
    console.error(err);
  } finally {
    e.target.value = '';
  }
});

el('btn-reset-data').addEventListener('click', () => {
  if (!confirm('This will permanently delete all groups, members, and expenses. Continue?')) return;
  Object.assign(state, { groups: [], activeGroupId: null, rates: { values: null, updatedAt: null } });
  persist();
  modalSettings.close();
  render();
});

// ---------- Group CSV export/import (members & expenses) ----------

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'group';
}

function downloadCsv(filename, rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function findOrCreateMember(group, rawName) {
  const name = (rawName || '').trim();
  if (!name) return null;
  const existing = group.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const member = { id: uid(), name };
  group.members.push(member);
  return member.id;
}

el('btn-export-members-csv').addEventListener('click', () => {
  const group = activeGroup();
  if (!group) { alert('Select a group first.'); return; }
  const rows = [['name'], ...group.members.map((m) => [m.name])];
  downloadCsv(`${slugify(group.name)}-members.csv`, rows);
});

el('btn-export-expenses-csv').addEventListener('click', () => {
  const group = activeGroup();
  if (!group) { alert('Select a group first.'); return; }
  const rows = [['item', 'description', 'date', 'currency', 'amount', 'paid_by', 'split_mode', 'member', 'share', 'settled']];
  expensesByDateDesc(group).forEach((exp, idx) => {
    const item = idx + 1;
    const payerName = memberName(group, exp.paidBy);
    exp.splits.forEach((s) => {
      rows.push([
        item, exp.description, exp.date, exp.currency, exp.amount,
        payerName, exp.splitMode, memberName(group, s.memberId), s.share, s.settled ? 'TRUE' : 'FALSE',
      ]);
    });
  });
  downloadCsv(`${slugify(group.name)}-expenses.csv`, rows);
});

el('import-members-csv').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const group = activeGroup();
  if (!file) return;
  if (!group) { alert('Select a group first.'); e.target.value = ''; return; }
  try {
    const text = await file.text();
    const allRows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
    if (allRows.length === 0) throw new Error('Empty file');
    const dataRows = (allRows[0][0] || '').trim().toLowerCase() === 'name' ? allRows.slice(1) : allRows;

    let added = 0;
    let skipped = 0;
    dataRows.forEach((row) => {
      const name = (row[0] || '').trim();
      if (!name) return;
      const exists = group.members.some((m) => m.name.toLowerCase() === name.toLowerCase());
      if (exists) { skipped += 1; return; }
      group.members.push({ id: uid(), name });
      added += 1;
    });

    persist();
    render();
    alert(`Imported ${added} new member(s).${skipped ? ` Skipped ${skipped} already in the group.` : ''}`);
  } catch (err) {
    alert('Could not read that CSV file.');
    console.error(err);
  } finally {
    e.target.value = '';
  }
});

el('import-expenses-csv').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const group = activeGroup();
  if (!file) return;
  if (!group) { alert('Select a group first.'); e.target.value = ''; return; }
  try {
    const text = await file.text();
    const allRows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
    if (allRows.length < 2) throw new Error('No data rows found');

    const header = allRows[0].map((h) => h.trim().toLowerCase());
    const colIndex = (name) => header.indexOf(name);
    const required = ['description', 'date', 'currency', 'amount', 'paid_by', 'member', 'share'];
    const missing = required.filter((c) => colIndex(c) === -1);
    if (missing.length > 0) throw new Error(`Missing required column(s): ${missing.join(', ')}`);

    const itemIdx = colIndex('item');
    const splitModeIdx = colIndex('split_mode');
    const settledIdx = colIndex('settled');

    const groupedRows = new Map();
    allRows.slice(1).forEach((row, seq) => {
      const key = itemIdx !== -1 && (row[itemIdx] || '').trim() !== '' ? row[itemIdx].trim() : `row-${seq}`;
      if (!groupedRows.has(key)) groupedRows.set(key, []);
      groupedRows.get(key).push(row);
    });

    const rates = getRates(state.rates);
    let imported = 0;
    const errors = [];

    groupedRows.forEach((rows, key) => {
      try {
        const first = rows[0];
        const description = first[colIndex('description')].trim();
        const date = first[colIndex('date')].trim();
        const currency = first[colIndex('currency')].trim().toUpperCase();
        const amount = round2(parseFloat(first[colIndex('amount')]));
        const paidByName = first[colIndex('paid_by')].trim();
        const splitMode = splitModeIdx !== -1 ? (first[splitModeIdx].trim() || 'imported') : 'imported';

        if (!description || !date || !currency || !amount || amount <= 0 || !paidByName) {
          throw new Error('missing or invalid required fields');
        }

        const paidBy = findOrCreateMember(group, paidByName);
        const splits = rows.map((row) => {
          const memberId = findOrCreateMember(group, row[colIndex('member')]);
          const share = round2(parseFloat(row[colIndex('share')]) || 0);
          const settled = settledIdx !== -1 && /^(true|1|yes)$/i.test((row[settledIdx] || '').trim());
          return { memberId, share, settled };
        }).filter((s) => s.memberId);

        if (splits.length === 0) throw new Error('no valid split rows');

        const baseAmount = round2(convert(amount, currency, group.baseCurrency, rates));
        group.expenses.push({
          id: uid(), description, amount, currency, baseAmount, date, paidBy, splitMode, splits,
        });
        imported += 1;
      } catch (err) {
        errors.push(`${key}: ${err.message}`);
      }
    });

    persist();
    render();

    let msg = `Imported ${imported} expense(s).`;
    if (errors.length > 0) {
      msg += ` Skipped ${errors.length}: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? '…' : ''}`;
    }
    alert(msg);
  } catch (err) {
    alert(`Could not import that file: ${err.message}`);
    console.error(err);
  } finally {
    e.target.value = '';
  }
});

// ---------- Peer-to-peer sync (WebRTC, no server) ----------

let sharePc = null;
let shareChannel = null;
let joinPc = null;
let joinChannel = null;
let pendingImportPayload = null;

function setShareStatus(msg) { el('sync-share-status').textContent = msg; }
function setJoinStatus(msg) { el('sync-join-status').textContent = msg; }

function extractSyncCode(raw) {
  const trimmed = (raw || '').trim();
  try {
    const url = new URL(trimmed);
    const joinParam = url.searchParams.get('join');
    if (joinParam) return joinParam;
  } catch {
    // not a URL — treat the whole thing as a raw code
  }
  return trimmed;
}

function copyFieldValue(id) {
  const field = el(id);
  field.select();
  navigator.clipboard?.writeText(field.value).catch(() => {});
}

el('btn-sync').addEventListener('click', () => modalSync.showModal());
el('btn-copy-share-link').addEventListener('click', () => copyFieldValue('sync-share-link'));
el('btn-copy-share-code').addEventListener('click', () => copyFieldValue('sync-share-code'));
el('btn-copy-join-reply').addEventListener('click', () => copyFieldValue('sync-join-reply-code'));

el('btn-sync-start-share').addEventListener('click', async () => {
  setShareStatus('Creating offer...');
  el('btn-sync-send-data').hidden = true;
  try {
    if (sharePc) sharePc.close();
    const { pc, channel, code } = await createShareOffer();
    sharePc = pc;
    shareChannel = channel;

    const baseUrl = location.href.split(/[?#]/)[0];
    el('sync-share-link').value = `${baseUrl}?join=${code}`;
    el('sync-share-code').value = code;
    el('sync-share-link-box').hidden = false;
    el('sync-share-reply-box').hidden = false;
    renderQrCode(el('sync-share-qr'), code);
    setShareStatus("Share the link/code (or let them scan the QR above). Once they send back a reply code, paste or scan it below.");

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setShareStatus(`Connection ${pc.connectionState}. They may be behind a network that blocks direct peer connections.`);
      }
    });
    channel.addEventListener('open', () => {
      setShareStatus('Connected.');
      el('btn-sync-send-data').hidden = false;
    });
    channel.addEventListener('close', () => setShareStatus('Disconnected.'));
  } catch (err) {
    setShareStatus(`Could not start sharing: ${err.message}`);
    console.error(err);
  }
});

el('btn-sync-finish-share').addEventListener('click', async () => {
  if (!sharePc) return;
  const code = extractSyncCode(el('sync-share-reply-input').value);
  if (!code) return;
  try {
    setShareStatus('Connecting...');
    await completeShare(sharePc, code);
  } catch (err) {
    setShareStatus(`Could not connect: ${err.message}`);
    console.error(err);
  }
});

el('btn-sync-send-data').addEventListener('click', () => {
  if (!shareChannel || shareChannel.readyState !== 'open') return;
  shareChannel.send(JSON.stringify(state));
  setShareStatus('Sent your data to them.');
});

el('btn-sync-generate-reply').addEventListener('click', async () => {
  const code = extractSyncCode(el('sync-join-input').value);
  if (!code) { setJoinStatus('Paste a code or link first.'); return; }
  try {
    setJoinStatus('Creating reply...');
    if (joinPc) joinPc.close();
    const { pc, code: replyCode } = await createJoinAnswer(code);
    joinPc = pc;
    el('sync-join-reply-code').value = replyCode;
    el('sync-join-reply-box').hidden = false;
    renderQrCode(el('sync-join-qr'), replyCode);
    setJoinStatus('Send the reply code back to them (or let them scan the QR above), then wait here for their data.');

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setJoinStatus(`Connection ${pc.connectionState}. You may be behind a network that blocks direct peer connections.`);
      }
    });
    pc.addEventListener('datachannel', (event) => {
      joinChannel = event.channel;
      joinChannel.addEventListener('open', () => setJoinStatus('Connected. Waiting for their data...'));
      joinChannel.addEventListener('message', (msgEvent) => {
        try {
          const payload = JSON.parse(msgEvent.data);
          if (!Array.isArray(payload.groups)) throw new Error('Unexpected data shape');
          pendingImportPayload = payload;
          const expenseCount = payload.groups.reduce((s, g) => s + (g.expenses ? g.expenses.length : 0), 0);
          el('sync-import-summary').textContent = `Received ${payload.groups.length} group(s), ${expenseCount} expense(s).`;
          el('sync-import-box').hidden = false;
          setJoinStatus('Data received — choose how to import it below.');
        } catch (err) {
          setJoinStatus('Received something unexpected from them.');
          console.error(err);
        }
      });
    });
  } catch (err) {
    setJoinStatus(`Could not create a reply: ${err.message}`);
    console.error(err);
  }
});

el('btn-sync-import').addEventListener('click', () => {
  if (!pendingImportPayload) return;
  const mode = document.querySelector('input[name="sync-import-mode"]:checked').value;

  if (mode === 'replace') {
    if (!confirm('Replace ALL your data with theirs? This cannot be undone.')) return;
    Object.assign(state, pendingImportPayload);
    state.activeGroupId = state.groups[0]?.id || null;
    setJoinStatus('Replaced your data.');
  } else {
    let added = 0;
    pendingImportPayload.groups.forEach((g) => {
      if (!state.groups.some((existing) => existing.id === g.id)) {
        state.groups.push(g);
        added += 1;
      }
    });
    setJoinStatus(`Merged. Added ${added} new group(s).`);
  }

  persist();
  render();
  pendingImportPayload = null;
  el('sync-import-box').hidden = true;
});

el('btn-sync-discard').addEventListener('click', () => {
  pendingImportPayload = null;
  el('sync-import-box').hidden = true;
  setJoinStatus('Discarded.');
});

// ---------- QR camera scanner (shared by both sync roles) ----------

let scannerStream = null;
let scannerRafId = null;
let scannerTarget = null; // 'join' | 'share-reply'

function stopScanner() {
  if (scannerRafId) { cancelAnimationFrame(scannerRafId); scannerRafId = null; }
  if (scannerStream) { scannerStream.getTracks().forEach((t) => t.stop()); scannerStream = null; }
  el('sync-scanner').hidden = true;
  el('sync-scanner-video').srcObject = null;
}

function onScanSuccess(text) {
  const target = scannerTarget;
  stopScanner();
  if (target === 'join') {
    el('sync-join-input').value = text;
    el('btn-sync-generate-reply').click();
  } else if (target === 'share-reply') {
    el('sync-share-reply-input').value = text;
    el('btn-sync-finish-share').click();
  }
}

async function startScanner(target) {
  if (!window.jsQR) {
    alert('The QR scanning library failed to load (are you offline?). Use the code/link instead.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Camera access is not available here. This needs HTTPS (or localhost) in a browser that supports camera access. Use the code/link instead.');
    return;
  }
  scannerTarget = target;
  const statusEl = el('sync-scanner-status');
  el('sync-scanner').hidden = false;
  statusEl.textContent = 'Requesting camera access...';
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    statusEl.textContent = `Camera access failed: ${err.message}. This needs HTTPS (or localhost) and camera permission.`;
    return;
  }

  const video = el('sync-scanner-video');
  video.srcObject = scannerStream;
  await video.play();
  statusEl.textContent = "Point your camera at their QR code...";

  const canvas = el('sync-scanner-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = () => {
    if (!scannerStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(imageData.data, imageData.width, imageData.height);
      if (result && result.data) {
        onScanSuccess(result.data);
        return;
      }
    }
    scannerRafId = requestAnimationFrame(tick);
  };
  scannerRafId = requestAnimationFrame(tick);
}

el('btn-scan-join').addEventListener('click', () => startScanner('join'));
el('btn-scan-reply').addEventListener('click', () => startScanner('share-reply'));
el('btn-sync-scanner-cancel').addEventListener('click', stopScanner);
modalSync.addEventListener('close', stopScanner);

// ---------- Dialog close buttons ----------

document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('dialog').close());
});

// ---------- Init ----------

if (!state.activeGroupId && state.groups.length > 0) {
  state.activeGroupId = state.groups[0].id;
}

render();

const incomingJoinCode = new URLSearchParams(location.search).get('join');
if (incomingJoinCode) {
  el('sync-join-input').value = incomingJoinCode;
  modalSync.showModal();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
