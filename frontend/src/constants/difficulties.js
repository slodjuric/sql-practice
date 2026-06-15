export const PLAN_DIFFICULTIES = ['easy', 'medium', 'hard'];

export const PLAN_DIFFICULTY_OPTIONS = PLAN_DIFFICULTIES.map(d => ({
  id: d,
  label: d,
  labelClassName: `create-plan-diff create-plan-diff--${d}`,
}));

// Maps difficulty value to its CSS badge class
export const DIFFICULTY_CLASS = {
  easy:   'badge-easy',
  medium: 'badge-medium',
  hard:   'badge-hard',
};

// Used for sorting tasks by difficulty
export const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };
