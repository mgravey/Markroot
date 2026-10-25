import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap } from '@codemirror/commands';
import { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldKeymap } from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine, keymap } from '@codemirror/view';

/** CodeMirror basicSetup without history() or historyKeymap: DocumentSession owns undo. */
export const sourceSetup = [
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), foldGutter(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
];
