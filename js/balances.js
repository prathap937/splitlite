import { round2 } from './currency.js';

export function shareBaseAmount(exp, split) {
  return exp.amount ? round2(exp.baseAmount * (split.share / exp.amount)) : 0;
}

// Net balance per member in the group's base currency.
// Positive => group owes this member money. Negative => this member owes the group.
// A split marked `settled` means that member already paid the payer back for that
// specific item outside the app, so it's excluded from the outstanding ledger entirely.
// Recorded payments (group.settlements) shift balances toward zero the same way,
// but for an arbitrary amount between two members rather than one expense's share.
export function computeBalances(group) {
  const balances = {};
  group.members.forEach((m) => { balances[m.id] = 0; });

  group.expenses.forEach((exp) => {
    exp.splits.forEach((s) => {
      if (s.settled) return;
      const shareBase = shareBaseAmount(exp, s);
      balances[exp.paidBy] = round2((balances[exp.paidBy] || 0) + shareBase);
      balances[s.memberId] = round2((balances[s.memberId] || 0) - shareBase);
    });
  });

  (group.settlements || []).forEach((st) => {
    balances[st.fromId] = round2((balances[st.fromId] || 0) + st.amount);
    balances[st.toId] = round2((balances[st.toId] || 0) - st.amount);
  });

  return balances;
}

export function totalSpendByMember(group) {
  const totals = {};
  group.members.forEach((m) => { totals[m.id] = 0; });
  group.expenses.forEach((exp) => {
    totals[exp.paidBy] = round2((totals[exp.paidBy] || 0) + exp.baseAmount);
  });
  return totals;
}

// Greedy min-transaction settlement: largest debtor pays largest creditor, repeat.
export function computeSettlements(balances) {
  const creditors = [];
  const debtors = [];

  Object.entries(balances).forEach(([id, bal]) => {
    if (bal > 0.01) creditors.push({ id, amount: bal });
    else if (bal < -0.01) debtors.push({ id, amount: -bal });
  });

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amt = round2(Math.min(debtor.amount, creditor.amount));
    if (amt > 0.01) {
      settlements.push({ from: debtor.id, to: creditor.id, amount: amt });
    }
    debtor.amount = round2(debtor.amount - amt);
    creditor.amount = round2(creditor.amount - amt);
    if (debtor.amount <= 0.01) i += 1;
    if (creditor.amount <= 0.01) j += 1;
  }

  return settlements;
}

export function computeEqualSplits(amount, memberIds) {
  const n = memberIds.length;
  if (n === 0) return [];
  const base = Math.floor((amount / n) * 100) / 100;
  const shares = memberIds.map((id) => ({ memberId: id, share: base }));
  const assigned = round2(base * n);
  const remainderCents = Math.round(round2(amount - assigned) * 100);
  for (let i = 0; i < remainderCents; i += 1) {
    shares[i % n].share = round2(shares[i % n].share + 0.01);
  }
  return shares;
}

export function computePercentSplits(amount, entries) {
  const shares = entries.map((e) => ({
    memberId: e.memberId,
    share: round2((amount * e.percent) / 100),
  }));
  const sum = round2(shares.reduce((s, x) => s + x.share, 0));
  const diff = round2(amount - sum);
  if (diff !== 0 && shares.length > 0) {
    shares[shares.length - 1].share = round2(shares[shares.length - 1].share + diff);
  }
  return shares;
}
