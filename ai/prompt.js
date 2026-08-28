'use strict';
const fs   = require('fs');
const path = require('path');

// ── Prompt loading & interpolation ───────────────────────────
// Aus ai/index.js extrahiert (Arbeit zur Lesbarkeit/Wartbarkeit).
const PROMPT_DIR = path.join(__dirname, 'prompts');
const promptCache = {};

function loadPrompt(name) {
  if (promptCache[name]) return promptCache[name];
  const raw = fs.readFileSync(path.join(PROMPT_DIR, `${name}.md`), 'utf8');
  const sysMatch  = raw.match(/^#\s*SYSTEM\s*\n([\s\S]*?)(?=^#\s*USER\s*$)/m);
  const userMatch = raw.match(/^#\s*USER\s*\n([\s\S]*)$/m);
  const parsed = {
    system: (sysMatch  ? sysMatch[1]  : '').trim(),
    user:   (userMatch ? userMatch[1] : '').trim(),
  };
  promptCache[name] = parsed;
  return parsed;
}

function interpolate(tpl, vars) {
  // Supports {{key}} and {{#key}}…{{/key}} conditional blocks.
  let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, body) =>
    vars[k] ? body : ''
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  return out;
}

module.exports = { loadPrompt, interpolate };
