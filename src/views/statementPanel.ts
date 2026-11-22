import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { escapeHtml, sanitizeStatementHtml } from '../api/parser';
import { DescriptionRef, ProblemRef, Statement } from '../api/types';
import { describeError, Session } from '../session';
import { downloadStatementFile } from '../fileTransfer';
import { fetchStatement } from '../statementCache';

export type StatementCommand =
  | 'submit'
  | 'newFile'
  | 'testSamples'
  | 'openBrowser'
  | 'copyLink';

const TOOLBAR: { command: string; label: string; secondary?: boolean }[] = [
  { command: 'submit', label: '提交代码' },
  { command: 'newFile', label: '新建代码文件', secondary: true },
  { command: 'testSamples', label: '测试样例', secondary: true },
  { command: 'openBrowser', label: '在浏览器打开', secondary: true },
  { command: 'copyLink', label: '复制题目链接', secondary: true },
  { command: 'refresh', label: '刷新题面', secondary: true },
];

const STYLES = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.6;
}
.toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 16px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
}
.toolbar-title { flex: 1 1 240px; min-width: 0; }
.toolbar-title h1 {
  margin: 0; font-size: 1.05em; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.toolbar-title .subtitle {
  display: block; margin-top: 2px; font-size: 0.82em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.toolbar-actions { display: flex; flex-wrap: wrap; gap: 6px; }
button {
  border: none; border-radius: 2px; padding: 4px 10px;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  font-family: inherit; font-size: 0.92em; cursor: pointer;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: .5; cursor: default; }
main { padding: 16px 20px 64px; max-width: 980px; }
.descriptions {
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  border-radius: 4px; margin-bottom: 20px; overflow: hidden;
}
.descriptions-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: .9em; font-weight: 600;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
}
.descriptions-head .hint { font-weight: 400; }
.description-list { display: flex; flex-direction: column; }
.desc-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px; border: none; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2));
  background: transparent; color: var(--vscode-foreground);
  font-family: inherit; font-size: .92em; text-align: left; cursor: pointer;
}
.desc-item:first-child { border-top: none; }
.desc-item:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.18)); }
.desc-item.active {
  background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.3));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
}
.desc-author { font-weight: 600; }
.desc-badge {
  padding: 1px 6px; border-radius: 999px; font-size: .78em;
  border: 1px solid currentColor; opacity: .85;
}
.desc-lang { opacity: .9; }
.desc-date { margin-left: auto; font-size: .85em; opacity: .7; white-space: nowrap; }
.statement .mj, .statement .mj-display {
  font-family: "Cambria Math", "Latin Modern Math", "STIX Two Math", "Times New Roman", serif;
}
.statement .mj { white-space: nowrap; }
.statement .mj sup, .statement .mj sub { font-size: .72em; line-height: 0; }
.statement .mj-display {
  display: block; margin: .75em 0; text-align: center;
  overflow-x: auto; overflow-y: hidden; white-space: nowrap;
}
.statement .mj-frac {
  display: inline-flex; flex-direction: column; vertical-align: middle;
  text-align: center; margin: 0 .12em; line-height: 1.15;
}
.statement .mj-frac .mj-num { border-bottom: 1px solid currentColor; padding: 0 .25em; }
.statement .mj-frac .mj-den { padding: 0 .25em; }
.statement .mj-sqrt { display: inline-flex; align-items: flex-start; }
.statement .mj-radicand { border-top: 1px solid currentColor; padding: 0 .15em; margin-top: .15em; }
.statement .mj-cases { display: inline-flex; flex-direction: column; vertical-align: middle; margin: 0 .15em; }
.statement .mj-matrix { display: inline-flex; flex-direction: column; vertical-align: middle; margin: 0 .3em; }
.statement .mj-env-row { display: flex; gap: 1em; justify-content: flex-start; }
.statement .mj-env-cell { min-width: 0; }
.statement .mj-overline { border-top: 1px solid currentColor; }
.statement .mj-underline { border-bottom: 1px solid currentColor; }
.statement .mj-accent { position: relative; display: inline-block; padding-top: .15em; }
.statement .mj-accent-mark {
  position: absolute; left: 50%; top: -.35em;
  transform: translateX(-50%); font-size: .8em;
}
.statement .mj-text, .statement .mj-roman { font-style: normal; }
.statement .mj-italic { font-style: italic; }
.statement .mj-bold { font-weight: 600; }
.statement .mj-bb { font-weight: 600; font-family: inherit; }
.statement .mj-op { padding: 0 .12em; }
.statement .mj-cmd { font-style: normal; }
.statement img { max-width: 100%; height: auto; }
.statement h1, .statement h2, .statement h3, .statement h4 {
  font-weight: 600; margin: 1.2em 0 .5em; line-height: 1.3;
}
.statement h1:first-child, .statement h2:first-child, .statement h3:first-child { margin-top: 0; }
.statement p { margin: .6em 0; }
.statement ul, .statement ol { padding-left: 1.6em; }
.statement table { border-collapse: collapse; margin: .8em 0; max-width: 100%; display: block; overflow-x: auto; }
.statement th, .statement td { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.45)); padding: 4px 10px; }
.statement blockquote {
  margin: .8em 0; padding: .2em 1em; border-left: 3px solid var(--vscode-textBlockQuote-border);
  background: var(--vscode-textBlockQuote-background);
}
.statement code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px; border-radius: 3px;
}
.statement pre {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background);
  padding: 10px 12px; border-radius: 4px; overflow: auto;
}
.statement pre code { background: transparent; padding: 0; }
.statement a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.statement a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.statement .vj-file {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: .8em 0; padding: 8px 10px;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  border-radius: 4px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
}
.statement .vj-file-kind {
  padding: 1px 6px; border-radius: 3px;
  font-size: .75em; font-weight: 600; letter-spacing: .04em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.statement .vj-file-label { flex: 1 1 auto; min-width: 120px; font-weight: 600; }
.statement .vj-file-action { padding: 3px 9px; font-size: .85em; }
.statement hr { border: none; border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); margin: 1.5em 0; }
.vj-section-sep { margin: 2em 0; }
.samples { margin-top: 28px; }
.samples > h2 { font-size: 1.1em; margin: 0 0 12px; }
.sample { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); border-radius: 4px; margin-bottom: 16px; overflow: hidden; }
.sample-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
  font-weight: 600; font-size: .92em;
}
.sample-head .spacer { flex: 1; }
.sample-head button { padding: 2px 8px; font-size: .85em; }
.sample-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--vscode-widget-border, rgba(128,128,128,.35)); }
.sample-grid > div { background: var(--vscode-editor-background); padding: 8px 10px; min-width: 0; }
.sample-grid h4 { margin: 0 0 4px; font-size: .85em; font-weight: 600; color: var(--vscode-descriptionForeground); }
.sample-grid pre {
  margin: 0; max-height: 260px; overflow: auto; padding: 6px 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background); border-radius: 3px;
  white-space: pre; font-size: .92em;
}
@media (max-width: 640px) { .sample-grid { grid-template-columns: 1fr; } }
.hint { color: var(--vscode-descriptionForeground); }
.error-box {
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,.1));
  padding: 12px 14px; border-radius: 4px; margin: 12px 0;
  white-space: pre-wrap;
}
.note { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: .9em; }
`;

const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ϵ',
    zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ',
    varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ',
    varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
    Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', lt: '<', gt: '>',
    ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇',
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔',
    mapsto: '↦', uparrow: '↑', downarrow: '↓', forall: '∀', exists: '∃', nexists: '∄',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', setminus: '∖',
    land: '∧', wedge: '∧', lor: '∨', vee: '∨', lnot: '¬', neg: '¬',
    oplus: '⊕', otimes: '⊗', equiv: '≡', sim: '∼', simeq: '≃', approx: '≈',
    propto: '∝', circ: '∘', bullet: '•', degree: '°', angle: '∠', perp: '⊥',
    parallel: '∥', mid: '∣', dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
    prime: '′', backslash: '\\', lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩',
    lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', Vert: '‖',
    quad: '\u2003', qquad: '\u2003\u2003', colon: ':',
    sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
    log: 'log', ln: 'ln', exp: 'exp', lim: 'lim', max: 'max', min: 'min',
    gcd: 'gcd', lcm: 'lcm', mod: 'mod', bmod: 'mod', arg: 'arg', det: 'det',
    dim: 'dim', ker: 'ker', deg: 'deg', Pr: 'Pr'
  };

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function MathParser(src) {
    this.src = src || '';
    this.pos = 0;
  }
  MathParser.prototype.parse = function () {
    return this.parseSequence('');
  };
  MathParser.prototype.parseSequence = function (stop) {
    var out = '';
    while (this.pos < this.src.length) {
      if (stop && this.src.startsWith(stop, this.pos)) { break; }
      var spaced = false;
      while (this.pos < this.src.length && /\s/.test(this.src.charAt(this.pos))) {
        spaced = true;
        this.pos++;
      }
      if (stop && this.src.startsWith(stop, this.pos)) { break; }
      if (this.pos >= this.src.length) { break; }
      if (spaced && out) { out += '\u2009'; }
      var atom = this.parseAtom();
      if (atom === null) { break; }
      out += this.parseScripts(atom);
    }
    return out;
  };
  MathParser.prototype.parseScripts = function (atom) {
    var html = atom;
    var guard = 0;
    while (this.pos < this.src.length && guard++ < 8) {
      this.skipSpaces();
      var ch = this.src.charAt(this.pos);
      if (ch === '^' || ch === '_') {
        this.pos++;
        var arg = this.parseArgument();
        html += ch === '^' ? '<sup>' + arg + '</sup>' : '<sub>' + arg + '</sub>';
      } else {
        break;
      }
    }
    return html;
  };
  MathParser.prototype.skipSpaces = function () {
    while (this.pos < this.src.length && /\s/.test(this.src.charAt(this.pos))) {
      this.pos++;
    }
  };
  MathParser.prototype.parseArgument = function () {
    this.skipSpaces();
    if (this.src.charAt(this.pos) === '{') {
      this.pos++;
      var inner = this.parseSequence('}');
      if (this.src.charAt(this.pos) === '}') { this.pos++; }
      return inner;
    }
    var atom = this.parseAtom();
    return atom === null ? '' : atom;
  };
  MathParser.prototype.readRawGroup = function () {
    this.skipSpaces();
    if (this.src.charAt(this.pos) !== '{') { return ''; }
    var depth = 0;
    var start = ++this.pos;
    while (this.pos < this.src.length) {
      var ch = this.src.charAt(this.pos);
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        if (depth === 0) {
          var text = this.src.slice(start, this.pos);
          this.pos++;
          return text;
        }
        depth--;
      }
      this.pos++;
    }
    return this.src.slice(start);
  };
  MathParser.prototype.parseEnvironment = function () {
    var name = this.readRawGroup();
    var endToken = '\\end{' + name + '}';
    var end = this.src.indexOf(endToken, this.pos);
    var content;
    if (end < 0) {
      content = this.src.slice(this.pos);
      this.pos = this.src.length;
    } else {
      content = this.src.slice(this.pos, end);
      this.pos = end + endToken.length;
    }
    var rows = content.split('\\\\');
    var html = '';
    for (var r = 0; r < rows.length; r++) {
      if (!rows[r].trim()) { continue; }
      var cells = rows[r].split('&');
      html += '<span class="mj-env-row">';
      for (var c = 0; c < cells.length; c++) {
        html += '<span class="mj-env-cell">' + new MathParser(cells[c]).parse() + '</span>';
      }
      html += '</span>';
    }
    var cls = name === 'cases' ? 'mj-cases' : 'mj-matrix';
    return '<span class="' + cls + '">' + html + '</span>';
  };
  MathParser.prototype.parseAtom = function () {
    this.skipSpaces();
    if (this.pos >= this.src.length) { return null; }
    var ch = this.src.charAt(this.pos);
    if (ch === '{') {
      this.pos++;
      var inner = this.parseSequence('}');
      if (this.src.charAt(this.pos) === '}') { this.pos++; }
      return '<span class="mj-group">' + inner + '</span>';
    }
    if (ch === '\\') {
      this.pos++;
      var name = '';
      if (/[a-zA-Z]/.test(this.src.charAt(this.pos))) {
        while (this.pos < this.src.length && /[a-zA-Z]/.test(this.src.charAt(this.pos))) {
          name += this.src.charAt(this.pos++);
        }
      } else {
        name = this.src.charAt(this.pos++);
      }
      return this.parseCommand(name);
    }
    if (ch === '~') { this.pos++; return '\u00a0'; }
    if (ch === '&') { this.pos++; return ''; }
    this.pos++;
    if (ch === '-') { return '<span class="mj-op">−</span>'; }
    return escapeHtml(ch);
  };
  MathParser.prototype.parseCommand = function (name) {
    this.skipSpaces();
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      var num = this.parseArgument();
      var den = this.parseArgument();
      return '<span class="mj-frac"><span class="mj-num">' + num +
        '</span><span class="mj-den">' + den + '</span></span>';
    }
    if (name === 'sqrt') {
      if (this.src.charAt(this.pos) === '[') {
        var close = this.src.indexOf(']', this.pos);
        if (close >= 0) { this.pos = close + 1; }
      }
      return '<span class="mj-sqrt"><span class="mj-radical">√</span>' +
        '<span class="mj-radicand">' + this.parseArgument() + '</span></span>';
    }
    if (name === 'text' || name === 'textrm' || name === 'mbox' || name === 'hbox' || name === 'operatorname') {
      return '<span class="mj-text">' + escapeHtml(this.readRawGroup()) + '</span>';
    }
    if (name === 'mathrm' || name === 'mathbf' || name === 'mathit' || name === 'mathbb' ||
        name === 'mathcal' || name === 'mathsf' || name === 'mathtt') {
      var style = name === 'mathbf' ? 'mj-bold' : name === 'mathit' ? 'mj-italic' :
        name === 'mathbb' ? 'mj-bb' : 'mj-roman';
      return '<span class="' + style + '">' + this.parseArgument() + '</span>';
    }
    if (name === 'left' || name === 'right' || name === 'middle' ||
        name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg') {
      var delimiter = this.parseAtom();
      return delimiter === null ? '' : delimiter;
    }
    if (name === 'begin') { return this.parseEnvironment(); }
    if (name === 'displaystyle' || name === 'textstyle' || name === 'scriptstyle' ||
        name === 'scriptscriptstyle' || name === 'limits' || name === 'nolimits') {
      return '';
    }
    if (name === 'color') {
      this.readRawGroup();
      return this.parseArgument();
    }
    if (name === ',' || name === ';' || name === ':' || name === '>' || name === ' ') {
      return '\u2009';
    }
    if (name === '!') { return ''; }
    if (name === 'quad') { return '\u2003'; }
    if (name === 'qquad') { return '\u2003\u2003'; }
    if (name === '\\') { return '<br>'; }
    if (name === 'pmod') { return ' (mod ' + this.parseArgument() + ')'; }
    if (name === 'overline') { return '<span class="mj-overline">' + this.parseArgument() + '</span>'; }
    if (name === 'underline') { return '<span class="mj-underline">' + this.parseArgument() + '</span>'; }
    if (name === 'hat' || name === 'bar' || name === 'vec' || name === 'dot' || name === 'ddot' || name === 'tilde') {
      var marks = { hat: '^', bar: '¯', vec: '→', dot: '˙', ddot: '¨', tilde: '~' };
      return '<span class="mj-accent">' + this.parseArgument() +
        '<span class="mj-accent-mark">' + marks[name] + '</span></span>';
    }
    var symbol = Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? SYMBOLS[name] : undefined;
    if (symbol !== undefined) { return escapeHtml(symbol); }
    return '<span class="mj-cmd">' + escapeHtml(name) + '</span>';
  };

  function looksLikeMath(body) {
    if (!body || body.length > 200 || /[\r\n]/.test(body)) { return false; }
    if (/\\[a-zA-Z]+/.test(body)) { return true; }
    if (/[\^_=<>]|[{}]/.test(body) && /[A-Za-z0-9]/.test(body)) { return true; }
    var text = body.replace(/\s+/g, ' ').trim();
    if (/^[A-Za-z0-9]{1,8}$/.test(text)) { return true; }
    return /^[A-Za-z0-9+\-*/(),.\[\]|!' ]{1,40}$/.test(text) &&
      /[A-Za-z0-9]/.test(text) && /[+\-*/()\[\],]/.test(text);
  }

  function transformText(text, mathOnly) {
    var out = '';
    var index = 0;
    var changed = false;
    while (index < text.length) {
      var close = null;
      var openLen = 1;
      var display = false;
      if (text.startsWith('\\[', index)) { close = '\\]'; openLen = 2; display = true; }
      else if (text.startsWith('\\(', index)) { close = '\\)'; openLen = 2; }
      else if (!mathOnly && text.startsWith('$$', index)) { close = '$$'; openLen = 2; display = true; }
      else if (!mathOnly && text.charAt(index) === '$') { close = '$'; }
      if (close === null) {
        out += escapeHtml(text.charAt(index));
        index++;
        continue;
      }
      var end = text.indexOf(close, index + openLen);
      if (end < 0) {
        out += escapeHtml(text.slice(index));
        break;
      }
      var body = text.slice(index + openLen, end);
      if (close === '$' && !looksLikeMath(body)) {
        out += escapeHtml('$');
        index++;
        continue;
      }
      var parsed = new MathParser(body).parse();
      out += display
        ? '<span class="mj-display">' + parsed + '</span>'
        : '<span class="mj">' + parsed + '</span>';
      changed = true;
      index = end + close.length;
    }
    return { html: out, changed: changed };
  }

  function renderMath(root) {
    if (!root) { return; }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue || '';
      var parent = node.parentElement;
      if (parent && parent.closest('script, style, textarea, .samples, .mj')) {
        continue;
      }
      var mathOnly = Boolean(parent && parent.closest('pre, code'));
      if (mathOnly) {
        if (value.indexOf('\\(') < 0 && value.indexOf('\\[') < 0) {
          continue;
        }
      } else if (value.indexOf('$') < 0 && value.indexOf('\\(') < 0 && value.indexOf('\\[') < 0) {
        continue;
      }
      nodes.push(node);
    }
    for (var i = 0; i < nodes.length; i++) {
      var parent = nodes[i].parentElement;
      var mathOnly = Boolean(parent && parent.closest('pre, code'));
      var result = transformText(nodes[i].nodeValue || '', mathOnly);
      if (!result.changed) { continue; }
      var wrapper = document.createElement('span');
      wrapper.innerHTML = result.html;
      if (nodes[i].parentNode) {
        nodes[i].parentNode.replaceChild(wrapper, nodes[i]);
      }
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => vscode.postMessage({ type: 'copied' }),
        () => vscode.postMessage({ type: 'copy', text: text })
      );
    } else {
      vscode.postMessage({ type: 'copy', text: text });
    }
  }
  document.addEventListener('click', function (event) {
    const description = event.target.closest('[data-description]');
    if (description) {
      event.preventDefault();
      vscode.postMessage({ type: 'description', id: Number(description.getAttribute('data-description')) });
      return;
    }
    const action = event.target.closest('[data-command]');
    if (action) {
      event.preventDefault();
      if (action.disabled) { return; }
      vscode.postMessage({ type: 'command', command: action.getAttribute('data-command') });
      return;
    }
    const copy = event.target.closest('[data-copy-target]');
    if (copy) {
      event.preventDefault();
      const target = document.querySelector(copy.getAttribute('data-copy-target'));
      if (target) { copyText(target.textContent || ''); }
      return;
    }
    const fileAction = event.target.closest('[data-vj-action]');
    if (fileAction) {
      event.preventDefault();
      const card = fileAction.closest('.vj-file');
      if (card) {
        vscode.postMessage({
          type: 'file',
          action: fileAction.getAttribute('data-vj-action'),
          url: card.getAttribute('data-vj-url') || '',
          index: Number(card.getAttribute('data-vj-index') || 0),
        });
      }
      return;
    }
    const anchor = event.target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') { return; }
      event.preventDefault();
      let url;
      try { url = new URL(href, document.baseURI).toString(); } catch (e) { return; }
      vscode.postMessage({ type: 'openLink', href: url });
    }
  });
  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'toast') {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = message.text;
        toast.hidden = false;
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(function () { toast.hidden = true; }, 2000);
      }
    }
  });
  renderMath(document.querySelector('main'));
})();
`;

const TOAST_STYLE = `
#toast {
  position: fixed; right: 16px; bottom: 16px; padding: 6px 12px; border-radius: 4px;
  background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground);
  border: 1px solid var(--vscode-notifications-border); font-size: .9em; z-index: 20;
}
`;

export class StatementPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private current?: ProblemRef;
  private requestId = 0;
  private descriptions: DescriptionRef[] = [];
  private descriptionId?: number;
  private readonly disposables: vscode.Disposable[] = [];
  onCommand?: (command: StatementCommand, ref: ProblemRef) => void | Promise<void>;

  constructor(private readonly session: Session) {}

  async show(ref: ProblemRef): Promise<void> {
    this.current = ref;
    this.descriptions = [];
    this.descriptionId = undefined;
    const title = ref.title?.trim() || `${ref.oj}-${ref.probNum}`;
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        'vjudge.statement',
        title,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          enableFindWidget: true,
        },
      );
      this.panel = panel;
      const panelDisposables: vscode.Disposable[] = [];
      panel.onDidDispose(
        () => {
          for (const disposable of panelDisposables) {
            disposable.dispose();
          }
          if (this.panel === panel) {
            this.panel = undefined;
            this.current = undefined;
          }
        },
        undefined,
        this.disposables,
      );
      panel.webview.onDidReceiveMessage(
        (message: {
          type?: string;
          command?: string;
          href?: string;
          text?: string;
          id?: number;
          url?: string;
          action?: string;
          index?: number;
        }) => {
          void this.handleMessage(message);
        },
        undefined,
        panelDisposables,
      );
    } else {
      this.panel.title = title;
    }

    this.panel.reveal(undefined, false);
    this.panel.webview.html = this.shell(
      title,
      this.subtitle(ref),
      '<p class="hint">正在加载题面…</p>',
      false,
      randomBytes(16).toString('base64'),
    );
    await this.render(false);
  }

  async refresh(): Promise<void> {
    await this.render(true);
  }

  private async handleMessage(message: {
    type?: string;
    command?: string;
    href?: string;
    text?: string;
    id?: number;
    url?: string;
    action?: string;
    index?: number;
  }): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'file' && typeof message.url === 'string') {
      await this.handleFileAction(message.url, message.action, message.index);
      return;
    }
    if (message.type === 'description' && typeof message.id === 'number') {
      await this.selectDescription(message.id);
      return;
    }
    if (message.type === 'openLink' && typeof message.href === 'string') {
      await this.openLink(message.href);
      return;
    }
    if (message.type === 'copy' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      void this.panel?.webview.postMessage({ type: 'toast', text: '已复制' });
      return;
    }
    if (message.type === 'copied') {
      void this.panel?.webview.postMessage({ type: 'toast', text: '已复制' });
      return;
    }
    if (message.type !== 'command' || !message.command) {
      return;
    }
    if (message.command === 'refresh') {
      await this.refresh();
      return;
    }
    if (this.current && this.onCommand) {
      await this.onCommand(message.command as StatementCommand, this.current);
    }
  }

  private async selectDescription(id: number): Promise<void> {
    if (!Number.isFinite(id) || id <= 0 || id === this.descriptionId) {
      return;
    }
    if (!this.descriptions.some((item) => item.id === id)) {
      return;
    }
    const ref = this.current;
    const panel = this.panel;
    if (!ref || !panel) {
      return;
    }
    this.descriptionId = id;
    panel.webview.html = this.shell(
      panel.title,
      this.subtitle(ref),
      `${this.descriptionsHtml(id)}<p class="hint">正在加载题面…</p>`,
      false,
      randomBytes(16).toString('base64'),
    );
    await this.render(false);
  }

  private async handleFileAction(url: string, action?: string, index?: number): Promise<void> {
    if (action === 'preview') {
      await this.openLink(url);
      return;
    }
    if (action !== 'download') {
      return;
    }
    const ref = this.current;
    const title = ref?.title?.trim() || (ref ? `${ref.oj}-${ref.probNum}` : '题面附件');
    const number = Number.isFinite(index) ? Math.max(0, Number(index)) + 1 : 1;
    try {
      await downloadStatementFile(url, `${title}-附件${number}.pdf`);
    } catch (error) {
      void vscode.window.showErrorMessage(`下载文件失败：${describeError(error)}`);
    }
  }

  private async openLink(href: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      void vscode.window.showErrorMessage('无法打开该链接。');
      return;
    }
    if (uri.scheme !== 'http' && uri.scheme !== 'https') {
      return;
    }
    await vscode.env.openExternal(uri);
  }

  private async render(force: boolean): Promise<void> {
    const ref = this.current;
    const panel = this.panel;
    if (!ref || !panel) {
      return;
    }
    const requestId = ++this.requestId;
    if (force) {
      panel.webview.html = this.shell(
        panel.title,
        this.subtitle(ref),
        `${this.descriptionsHtml(this.descriptionId)}<p class="hint">正在刷新题面…</p>`,
        false,
        randomBytes(16).toString('base64'),
      );
    }
    try {
      const statement = await fetchStatement(this.session, ref, force, this.descriptionId);
      if (requestId !== this.requestId || !this.panel || this.current !== ref) {
        return;
      }
      this.descriptions = statement.descriptions ?? this.descriptions;
      this.descriptionId = statement.descriptionId ?? this.descriptionId;
      const title = statement.title?.trim() || panel.title;
      this.panel.title = title;
      this.panel.webview.html = this.statementHtml(statement, ref, title);
    } catch (error) {
      if (requestId !== this.requestId || !this.panel || this.current !== ref) {
        return;
      }
      const message = escapeHtml(describeError(error));
      const body = `${this.descriptionsHtml(this.descriptionId)}<div class="error-box">获取题面失败：${message}</div>
<p class="hint">请确认已登录 VJudge，且该题目包含公开题面。若浏览器能正常打开，可点击上方「在浏览器打开」确认题面状态，然后稍后刷新重试。</p>`;
      this.panel.webview.html = this.shell(
        panel.title,
        this.subtitle(ref),
        body,
        false,
        randomBytes(16).toString('base64'),
      );
    }
  }

  private subtitle(ref: ProblemRef): string {
    const parts = [`${ref.oj}-${ref.probNum}`];
    if (ref.contestId !== undefined) {
      parts.push(`比赛 #${ref.contestId}${ref.contestNum ? ` · 第 ${ref.contestNum} 题` : ''}`);
    }
    return escapeHtml(parts.join('  ·  '));
  }

  private statementHtml(statement: Statement, ref: ProblemRef, title: string): string {
    const hasSamples = statement.samples.length > 0;
    const sanitized = sanitizeStatementHtml(statement.html);
    const content = hasSamples
      ? sanitized.replace(
          /<table\b[^>]*class=["'][^"']*(?:vjudge_sample|sample[-_ ]?test)[^"']*["'][^>]*>[\s\S]*?<\/table>/gi,
          '',
        )
      : sanitized;
    const samples = hasSamples ? this.renderSamples(statement) : '';
    const body = `${this.descriptionsHtml(this.descriptionId)}<article class="statement">${content}</article>${samples}`;
    return this.shell(
      title,
      this.subtitle(ref),
      body,
      true,
      randomBytes(16).toString('base64'),
    );
  }

  private descriptionsHtml(activeId?: number): string {
    if (this.descriptions.length < 2) {
      return '';
    }
    const items = this.descriptions
      .map((item) => {
        const author = this.descriptionAuthor(item);
        const lang = item.langDisplay?.trim() || item.lang?.trim() || '默认题面';
        const date = this.descriptionDate(item);
        const active = item.id === activeId ? ' active' : '';
        const official = item.official ? '<span class="desc-badge">官方</span>' : '';
        const title = item.remarks ? ` title="${escapeHtml(item.remarks)}"` : '';
        return `<button type="button" class="desc-item${active}" data-description="${item.id}"${title}>
  <span class="desc-author">${escapeHtml(author)}</span>${official}
  <span class="desc-lang">${escapeHtml(lang)}</span>
  ${date ? `<span class="desc-date">${escapeHtml(date)}</span>` : ''}
</button>`;
      })
      .join('\n');
    return `<section class="descriptions" aria-label="题面列表">
  <div class="descriptions-head">题面列表 <span class="hint">（${this.descriptions.length}）</span></div>
  <div class="description-list">
${items}
  </div>
</section>`;
  }

  private descriptionAuthor(item: DescriptionRef): string {
    const author = item.author?.trim();
    if (author && author !== '0') {
      return author;
    }
    return item.official ? 'System' : 'VJudge';
  }

  private descriptionDate(item: DescriptionRef): string {
    const date = item.updateDate?.trim();
    if (date) {
      return date.slice(0, 10);
    }
    if (item.version > 1e11) {
      return new Date(item.version).toISOString().slice(0, 10);
    }
    return '';
  }

  private renderSamples(statement: Statement): string {
    const blocks = statement.samples
      .map((sample, index) => {
        const number = index + 1;
        return `<div class="sample">
  <div class="sample-head">
    <span>样例 ${number}</span>
    <span class="spacer"></span>
    <button class="secondary" data-copy-target="#sample-${number}-input">复制输入</button>
    <button class="secondary" data-copy-target="#sample-${number}-output">复制输出</button>
  </div>
  <div class="sample-grid">
    <div>
      <h4>输入</h4>
      <pre id="sample-${number}-input">${escapeHtml(sample.input)}</pre>
    </div>
    <div>
      <h4>输出</h4>
      <pre id="sample-${number}-output">${escapeHtml(sample.output)}</pre>
    </div>
  </div>
</div>`;
      })
      .join('\n');
    return `<section class="samples">
  <h2>样例（${statement.samples.length}）</h2>
  ${blocks}
</section>`;
  }

  private shell(
    title: string,
    subtitle: string,
    body: string,
    ready: boolean,
    nonce: string,
  ): string {
    const safeTitle = escapeHtml(title);
    const buttons = TOOLBAR.map((item) => {
      const alwaysAvailable = item.command === 'refresh' || item.command === 'openBrowser' || item.command === 'copyLink';
      const disabled = ready || alwaysAvailable ? '' : ' disabled';
      const cls = item.secondary ? ' class="secondary"' : '';
      return `<button${cls}${disabled} data-command="${item.command}">${item.label}</button>`;
    }).join('\n        ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:; script-src 'nonce-${nonce}'; base-uri https://vjudge.net/;">
<base href="https://vjudge.net/">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<style>${STYLES}${TOAST_STYLE}</style>
</head>
<body>
<header class="toolbar">
  <div class="toolbar-title">
    <h1>${safeTitle}</h1>
    <span class="subtitle">${subtitle}</span>
  </div>
  <div class="toolbar-actions">
        ${buttons}
  </div>
</header>
<main>${body}</main>
<div id="toast" hidden></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
