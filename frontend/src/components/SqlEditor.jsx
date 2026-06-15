import { useEffect, useRef } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { basicSetup } from 'codemirror';
import { tags } from '@lezer/highlight';
import { api } from '../api';

// ── Schema cache (shared across all editor instances) ─────────────────────────
const _schema = { data: null, queue: [] };

function getSchema(cb) {
  if (_schema.data !== null) { cb(_schema.data); return; }
  _schema.queue.push(cb);
  if (_schema.queue.length > 1) return; // fetch already in progress

  api.tables.list()
    .then(tables => Promise.all(
      tables.map(async tbl => {
        const cols = await api.tables.columns(tbl);
        return [tbl, cols.map(c => c.column_name)];
      })
    ))
    .then(entries => { _schema.data = Object.fromEntries(entries); })
    .catch(() => { _schema.data = {}; })
    .finally(() => {
      _schema.queue.forEach(fn => fn(_schema.data));
      _schema.queue = [];
    });
}

// ── GitHub-dark theme ─────────────────────────────────────────────────────────
const editorTheme = EditorView.theme({
  '&': { backgroundColor: '#161b22', color: '#e6edf3' },
  '.cm-content': { caretColor: '#79c0ff', padding: '12px 4px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#79c0ff' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(88,166,255,0.25)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(88,166,255,0.15)' },
  '.cm-gutters': {
    backgroundColor: '#161b22',
    color: '#484f58',
    border: 'none',
    borderRight: '1px solid #21262d',
  },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(88,166,255,0.06)' },
  '.cm-activeLine': { backgroundColor: 'rgba(88,166,255,0.04)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(88,166,255,0.2)', outline: 'none' },
  '.cm-tooltip': {
    backgroundColor: '#21262d',
    border: '1px solid #30363d',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul': { maxHeight: '260px' },
  '.cm-tooltip-autocomplete ul li': { color: '#e6edf3', padding: '4px 14px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#1f6feb', color: '#fff' },
  '.cm-completionLabel': { fontSize: '13px' },
  '.cm-completionDetail': { color: '#8b949e', fontSize: '11px', marginLeft: '8px' },
  '.cm-completionMatchedText': { color: '#58a6ff', textDecoration: 'none', fontWeight: '600' },
  '.cm-completionIcon': { width: '1.2em', opacity: '0.7' },
  '.cm-scroller': {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    fontSize: '13px',
    lineHeight: '1.6',
  },
}, { dark: true });

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword,         color: '#ff7b72' },
  { tag: tags.operatorKeyword, color: '#ff7b72' },
  { tag: tags.operator,        color: '#ff7b72' },
  { tag: tags.string,          color: '#a5d6ff' },
  { tag: tags.number,          color: '#f2cc60' },
  { tag: tags.comment,         color: '#8b949e', fontStyle: 'italic' },
  { tag: tags.variableName,    color: '#79c0ff' },
  { tag: tags.name,            color: '#79c0ff' },
  { tag: tags.typeName,        color: '#ffa657' },
  { tag: tags.null,            color: '#ff7b72' },
  { tag: tags.bool,            color: '#79c0ff' },
  { tag: tags.punctuation,     color: '#e6edf3' },
]);

// ── Component ─────────────────────────────────────────────────────────────────
export default function SqlEditor({ value, onChange, onRun, minHeight = 140, readOnly = false }) {
  const containerRef       = useRef(null);
  const viewRef            = useRef(null);
  const compartment        = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());
  const onRunRef           = useRef(onRun);
  const onChangeRef        = useRef(onChange);

  // Keep refs current without recreating the editor
  useEffect(() => { onRunRef.current = onRun; },    [onRun]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Update editable state when readOnly changes
  useEffect(() => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      effects: editableCompartment.current.reconfigure(EditorView.editable.of(!readOnly)),
    });
  }, [readOnly]);

  // Create the editor once on mount
  useEffect(() => {
    if (!containerRef.current) return;
    const cpt = compartment.current;
    const editCpt = editableCompartment.current;
    let alive = true;

    const view = new EditorView({
      state: EditorState.create({
        doc: value ?? '',
        extensions: [
          basicSetup,
          cpt.of(sql({ dialect: PostgreSQL })),
          editCpt.of(EditorView.editable.of(!readOnly)),
          editorTheme,
          syntaxHighlighting(highlightStyle),
          // Run query on Ctrl/Cmd+Enter — highest priority so it wins over basicSetup bindings
          Prec.highest(keymap.of([
            { key: 'Ctrl-Enter', run: () => { onRunRef.current?.(); return true; } },
            { key: 'Mod-Enter',  run: () => { onRunRef.current?.(); return true; } },
          ])),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { minHeight: `${minHeight}px` },
            '.cm-scroller': { minHeight: `${minHeight}px` },
          }),
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;

    // Load table/column schema and reconfigure SQL autocomplete
    getSchema(schema => {
      if (alive) {
        view.dispatch({
          effects: cpt.reconfigure(sql({ dialect: PostgreSQL, schema })),
        });
      }
    });

    return () => { alive = false; view.destroy(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync externally controlled value (task switch, clear, etc.)
  useEffect(() => {
    if (!viewRef.current) return;
    const cur = viewRef.current.state.doc.toString();
    if (cur !== value) {
      viewRef.current.dispatch({
        changes: { from: 0, to: cur.length, insert: value ?? '' },
      });
    }
  }, [value]);

  return <div ref={containerRef} className="sql-editor-cm" />;
}
