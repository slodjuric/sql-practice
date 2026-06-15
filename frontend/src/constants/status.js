// Status filter tabs shown in PracticeView task list
export const STATUS_FILTERS = [
  { key: 'all',         label: 'All' },
  { key: 'not_started', label: 'Not started' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'solved',      label: 'Solved' },
];

// Used for sorting tasks by status
export const STATUS_ORDER = { not_started: 0, in_progress: 1, solved: 2 };
