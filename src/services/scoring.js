export const WEIGHT_KEYS = ['w_distance', 'w_trust', 'w_skill', 'w_acceptance', 'w_workload'];

const MAX_SKILL_YEARS = 10;
const MAX_JOBS_PER_DAY = 5;

const clamp = (v) => Math.max(0, Math.min(1, v));

export const criteriaOf = (candidate, radiusKm) => ({
  distance: clamp(1 - candidate.distance_m / (radiusKm * 1000)),
  trust: clamp(candidate.trust_score),
  skill: clamp(candidate.skill_years / MAX_SKILL_YEARS),
  acceptance: clamp(candidate.acceptance_rate),
  workload: clamp(1 - candidate.jobs_today / MAX_JOBS_PER_DAY),
});

export const scoreCandidate = (candidate, config) => {
  const criteria = criteriaOf(candidate, config.max_radius_km);
  const score =
    config.w_distance * criteria.distance +
    config.w_trust * criteria.trust +
    config.w_skill * criteria.skill +
    config.w_acceptance * criteria.acceptance +
    config.w_workload * criteria.workload;
  return { ...candidate, criteria, score };
};

export const rankCandidates = (candidates, config) =>
  candidates.map((c) => scoreCandidate(c, config)).sort((a, b) => b.score - a.score);