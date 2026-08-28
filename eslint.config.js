'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Baseline-Konfiguration (Arbeitspaket "CI + Lint-Baseline"):
// bewusst schlank gehalten - fängt echte Bugs (unused vars, undefined refs,
// ==/!= statt ===/!==) statt Stil zu erzwingen. Bestehender Code wird NICHT
// automatisch umformatiert; keine Formatter-Regeln (Einrückung/Quotes) sind
// aktiv, um massenhafte Diffs im bestehenden Codestand zu vermeiden.
module.exports = [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'ThreadStackApp/**',
      'design_handoff_threadstack_redesign/**',
      'Claude_Agent_team/**',
      'index.html',
      'addin.html',
      'public/graph-dev.html',
      'public/progress-dev.html',
    ],
  },
  {
    files: ['server.js', 'lib/**/*.js', 'ai/**/*.js', 'export/**/*.js', 'graph/**/*.js', 'db/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.mocha },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
  {
    files: ['public/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      // TSHost/TSGraph/TSProgress werden per `window.X = {...}` gesetzt
      // (app.js/graph.js/progress.js sind klassische, nicht gemodulte
      // Scripts) - ESLint leitet daraus keinen impliziten globalen Bezeichner
      // ab, daher hier explizit als bekannte Browser-Globals ergaenzt.
      globals: { ...globals.browser, TSHost: 'writable', TSGraph: 'writable', TSProgress: 'writable' },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
];
