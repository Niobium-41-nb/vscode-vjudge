export interface LanguageTemplate {
  extension: string;
  fileName?: string;
  content: string;
}

const CPP = `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`;

const C = `#include <stdio.h>

int main(void) {
    return 0;
}
`;

const PYTHON = `import sys


def main() -> None:
    data = sys.stdin.buffer.read().split()


if __name__ == "__main__":
    main()
`;

const JAVA = `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));

    }
}
`;

const GO = `package main

import (
    "bufio"
    "fmt"
    "os"
)

func main() {
    reader := bufio.NewReader(os.Stdin)
    _ = reader
    _ = fmt.Print
    _ = os.Stdout
}
`;

const RUST = `use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
}
`;

const JAVASCRIPT = `const fs = require('fs');

const input = fs.readFileSync(0, 'utf8');
`;

const TYPESCRIPT = `import { readFileSync } from 'fs';

const input = readFileSync(0, 'utf8');
`;

const KOTLIN = `import java.util.*

fun main() {
    val scanner = Scanner(System.in)
}
`;

const CSHARP = `using System;
using System.Linq;

class Program {
    static void Main() {
        var input = Console.In.ReadToEnd();
    }
}
`;

const RUBY = `input = $stdin.read
`;

const PHP = `<?php

$input = stream_get_contents(STDIN);
`;

const PASCAL = `program main;
begin
end.
`;

const HASKELL = `main :: IO ()
main = do
    input <- getContents
    return ()
`;

const SWIFT = `import Foundation

let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
`;

const EMPTY = '';

interface TemplateRule {
  pattern: RegExp;
  template: LanguageTemplate;
}

const RULES: TemplateRule[] = [
  { pattern: /typescript|tsc\b|deno\s*ts/i, template: { extension: 'ts', content: TYPESCRIPT } },
  { pattern: /javascript|node\.?js|ecmascript/i, template: { extension: 'js', content: JAVASCRIPT } },
  { pattern: /c#|csharp/i, template: { extension: 'cs', content: CSHARP } },
  { pattern: /f#|fsharp/i, template: { extension: 'fs', content: EMPTY } },
  { pattern: /vb\.?net|visual\s*basic/i, template: { extension: 'vb', content: EMPTY } },
  { pattern: /c\+\+|cpp|g\+\+|clang\+\+|cxx/i, template: { extension: 'cpp', content: CPP } },
  { pattern: /objective-c|\bobjc\b/i, template: { extension: 'm', content: EMPTY } },
  { pattern: /python|pypy/i, template: { extension: 'py', content: PYTHON } },
  { pattern: /java\b/i, template: { extension: 'java', fileName: 'Main.java', content: JAVA } },
  { pattern: /kotlin/i, template: { extension: 'kt', content: KOTLIN } },
  { pattern: /scala/i, template: { extension: 'scala', content: EMPTY } },
  { pattern: /golang|\bgo\b/i, template: { extension: 'go', content: GO } },
  { pattern: /rust/i, template: { extension: 'rs', content: RUST } },
  { pattern: /pascal|delphi|fpc/i, template: { extension: 'pas', content: PASCAL } },
  { pattern: /ruby/i, template: { extension: 'rb', content: RUBY } },
  { pattern: /php/i, template: { extension: 'php', content: PHP } },
  { pattern: /\bghc\b|haskell/i, template: { extension: 'hs', content: HASKELL } },
  { pattern: /swift/i, template: { extension: 'swift', content: SWIFT } },
  { pattern: /prolog/i, template: { extension: 'pl', content: EMPTY } },
  { pattern: /perl/i, template: { extension: 'pl', content: EMPTY } },
  { pattern: /lua/i, template: { extension: 'lua', content: EMPTY } },
  { pattern: /julia/i, template: { extension: 'jl', content: EMPTY } },
  { pattern: /fortran/i, template: { extension: 'f90', content: EMPTY } },
  { pattern: /ocaml/i, template: { extension: 'ml', content: EMPTY } },
  { pattern: /elixir/i, template: { extension: 'ex', content: EMPTY } },
  { pattern: /erlang/i, template: { extension: 'erl', content: EMPTY } },
  { pattern: /clojure/i, template: { extension: 'clj', content: EMPTY } },
  { pattern: /groovy/i, template: { extension: 'groovy', content: EMPTY } },
  { pattern: /nim\b/i, template: { extension: 'nim', content: EMPTY } },
  { pattern: /zig\b/i, template: { extension: 'zig', content: EMPTY } },
  { pattern: /dart\b/i, template: { extension: 'dart', content: EMPTY } },
  { pattern: /\badb\b|\bada\b/i, template: { extension: 'adb', content: EMPTY } },
  { pattern: /\btcl\b/i, template: { extension: 'tcl', content: EMPTY } },
  { pattern: /\bsql\b/i, template: { extension: 'sql', content: EMPTY } },
  { pattern: /\bbash\b|\bshell\b/i, template: { extension: 'sh', content: EMPTY } },
  { pattern: /^r\b/i, template: { extension: 'r', content: EMPTY } },
  { pattern: /^\s*text\s*$/i, template: { extension: 'txt', content: EMPTY } },
  { pattern: /\bd\b/i, template: { extension: 'd', content: EMPTY } },
  { pattern: /^c$|gcc|clang|gnu\s*c\d*|c11|c17|c99/i, template: { extension: 'c', content: C } },
];

export function templateForLanguage(language: string): LanguageTemplate & { recognized: boolean } {
  for (const rule of RULES) {
    if (rule.pattern.test(language)) {
      return { ...rule.template, recognized: true };
    }
  }
  return { extension: 'txt', content: EMPTY, recognized: false };
}

function normalizeTemplateKey(key: string): string {
  return key.trim().replace(/^\./, '').toLowerCase();
}

export function templateSettingValue(
  settings: Record<string, string>,
  candidates: string[],
): string | undefined {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'string' && value.trim()) {
      entries.set(normalizeTemplateKey(key), value.trim());
    }
  }
  for (const candidate of candidates) {
    const found = entries.get(normalizeTemplateKey(candidate));
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function applyTemplateVariables(
  content: string,
  variables: { title: string; oj: string; probNum: string },
): string {
  return content
    .replace(/\$\{title\}/g, variables.title)
    .replace(/\$\{oj\}/g, variables.oj)
    .replace(/\$\{probNum\}/g, variables.probNum);
}

const DEFAULT_HEADERS: Record<string, string> = {
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\n',
  c: '#include <stdio.h>\n\n',
  py: 'import sys\n\n\n',
  java: 'import java.io.*;\nimport java.util.*;\n\n',
  go: 'import (\n    "bufio"\n    "fmt"\n    "os"\n)\n\n',
  rs: 'use std::io::{self, Read};\n\n',
  js: "const fs = require('fs');\n\n",
  ts: "import { readFileSync } from 'fs';\n\n",
  kt: 'import java.util.*\n\n',
  cs: 'using System;\nusing System.Linq;\n\n',
  swift: 'import Foundation\n\n',
};

function headerLineKey(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

export function applyLanguageHeader(
  template: LanguageTemplate & { recognized: boolean },
  headers: string,
): LanguageTemplate & { recognized: boolean } {
  const value = headers.replace(/\r\n?/g, '\n').trimEnd();
  if (!value) {
    return template;
  }
  const content = template.content.replace(/\r\n?/g, '\n');
  const defaultHeader = DEFAULT_HEADERS[template.extension.toLowerCase()];
  if (defaultHeader && content.includes(defaultHeader)) {
    return {
      ...template,
      content: content.replace(defaultHeader, `${value}\n\n`),
    };
  }

  const headerKeys = new Set(value.split('\n').map(headerLineKey).filter(Boolean));
  if (headerKeys.size === 0) {
    return template;
  }
  const lines = content.split('\n');
  const contentKeys = new Set(lines.map(headerLineKey));
  if ([...headerKeys].every((key) => contentKeys.has(key))) {
    return template;
  }

  let anchor = 0;
  if (lines.length > 0 && /^(?:\/\/|#|--)\s/.test(lines[0])) {
    anchor = 1;
  }
  let end = anchor;
  while (end < lines.length && headerKeys.has(headerLineKey(lines[end]))) {
    end += 1;
  }
  if (end > anchor) {
    const rest = lines.slice(end).join('\n').replace(/^\n+/, '');
    const head = lines.slice(0, anchor).join('\n');
    return {
      ...template,
      content: head ? `${head}\n${value}\n\n${rest}` : `${value}\n\n${rest}`,
    };
  }
  if (anchor > 0) {
    return {
      ...template,
      content: `${lines[0]}\n${value}\n\n${lines.slice(1).join('\n')}`,
    };
  }
  return { ...template, content: `${value}\n\n${content}` };
}

export interface BuiltinHeaderFile {
  extension: string;
  fileName: string;
  content: string;
}

export function builtinHeaderFiles(): BuiltinHeaderFile[] {
  const files = Object.entries(DEFAULT_HEADERS).map(([extension, header]) => ({
    extension,
    fileName: `${extension}.txt`,
    content: header.trimEnd(),
  }));
  files.sort((a, b) => a.extension.localeCompare(b.extension));
  return files;
}

function withTitleComment(extension: string, content: string, title: string): string {
  if (!content) {
    return `// ${title}\n`;
  }
  if (extension === 'php') {
    return content.replace('<?php\n', `<?php\n// ${title}\n`);
  }
  if (extension === 'py' || extension === 'rb' || extension === 'pl') {
    return `# ${title}\n${content}`;
  }
  if (extension === 'hs') {
    return `-- ${title}\n${content}`;
  }
  return `// ${title}\n${content}`;
}

export function buildCodeTemplate(language: string, title: string): LanguageTemplate & { recognized: boolean } {
  const template = templateForLanguage(language);
  return { ...template, content: withTitleComment(template.extension, template.content, title) };
}

export interface BuiltinTemplateFile {
  extension: string;
  fileName: string;
  content: string;
}

const TEMPLATE_FILE_NAMES: Record<string, string> = { java: 'Main.java' };

let builtinFiles: BuiltinTemplateFile[] | undefined;

export function builtinTemplateFiles(): BuiltinTemplateFile[] {
  if (builtinFiles) {
    return builtinFiles;
  }
  const seen = new Set<string>();
  const files: BuiltinTemplateFile[] = [];
  for (const rule of RULES) {
    const extension = rule.template.extension.toLowerCase();
    if (extension === 'txt' || seen.has(extension)) {
      continue;
    }
    seen.add(extension);
    files.push({
      extension,
      fileName: TEMPLATE_FILE_NAMES[extension] ?? `main.${extension}`,
      content: withTitleComment(extension, rule.template.content, '${title}'),
    });
  }
  files.sort((a, b) => a.extension.localeCompare(b.extension));
  builtinFiles = files;
  return files;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeFileBase(input: string, fallback: string): string {
  let name = input
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  if (!name) {
    name = fallback.replace(/[\\/:*?"<>|\s]+/g, '-');
  }
  if (RESERVED.test(name)) {
    name = `${name}-problem`;
  }
  return name || 'solution';
}
