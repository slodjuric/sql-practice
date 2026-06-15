// Topics used in session plan form (checkbox options)
export const PLAN_TOPICS = [
  { id: 'select',              label: 'SELECT basics' },
  { id: 'where',               label: 'WHERE filtering' },
  { id: 'sorting',             label: 'ORDER BY sorting' },
  { id: 'aggregate-functions', label: 'Aggregate functions' },
  { id: 'group-by-having',     label: 'GROUP BY / HAVING' },
  { id: 'join',                label: 'JOIN' },
  { id: 'subqueries',          label: 'Subqueries' },
  { id: 'case-when',           label: 'CASE WHEN' },
  { id: 'set-operations',      label: 'Set Operations' },
  { id: 'cte',                 label: 'CTE' },
  { id: 'window-functions',    label: 'Window Functions' },
  { id: 'date-functions',      label: 'Date Functions' },
  { id: 'text-functions',      label: 'Text Functions' },
  { id: 'data-analysis',       label: 'Data Analysis' },
];

// Short display names for topic IDs — used in session scope summary
export const TOPIC_LABELS = {
  'select':              'SELECT',
  'where':               'WHERE',
  'sorting':             'Sorting',
  'aggregate-functions': 'Aggregate Functions',
  'group-by-having':     'GROUP BY / HAVING',
  'join':                'JOIN',
  'set-operations':      'Set Operations',
  'subqueries':          'Subqueries',
  'case-when':           'CASE WHEN',
  'cte':                 'CTE',
  'window-functions':    'Window Functions',
  'date-functions':      'Date Functions',
  'text-functions':      'Text Functions',
  'data-analysis':       'Data Analysis',
};
