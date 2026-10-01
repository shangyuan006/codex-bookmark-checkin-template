// Values remain in memory. Persist only the booleans returned by this helper.
export function quotaChangeEvidence(before,after,expectedReward) {
  const number=value=>typeof value==='number'&&Number.isFinite(value);
  const balanceComparable=number(before?.quota)&&number(after?.quota);
  const usageComparable=number(before?.usedQuota)&&number(after?.usedQuota)&&after.usedQuota>=before.usedQuota;
  const expected=number(expectedReward)&&expectedReward>0;
  const matches=delta=>expected&&Math.abs(delta-expectedReward)<0.000001;
  return {
    balanceIncreased:balanceComparable&&after.quota>before.quota,
    balanceRewardMatched:balanceComparable&&matches(after.quota-before.quota),
    totalRewardMatched:balanceComparable&&usageComparable&&matches(after.quota+after.usedQuota-before.quota-before.usedQuota),
    consumptionObserved:usageComparable&&after.usedQuota>before.usedQuota,
  };
}
