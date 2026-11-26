#!/usr/bin/env node
// #4 regression: dsh-purge must never hand an unregistered prompt variable to the host.
//
// DSH >= 0.2.1 registers only `provider` / `model` in the agent-loop; the working
// directory arrives as runtime context from the working-directory service. Any
// section/context still containing `{{cwd}}` makes `interpolate()` throw
//   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"
// before the model request is ever sent, so every session dies at startup.
//
// Run: node test/cwd-variable.test.mjs   (or: npm test)
import { rewritePromptAssembly } from "../lib/identity.js";

const OFFICIAL =
  "You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness. Your working directory is {{cwd}}.";
const CWD_ONLY = "Your working directory is {{cwd}}.";

// 0.2.1-rc.2 agent-loop registrations, verbatim.
const VARS_NEW = { provider: "deepseek", model: "deepseek-v4" };
// Legacy host that still shipped a cwd variable.
const VARS_OLD = { provider: "deepseek", model: "deepseek-v4", cwd: "D:\\work" };

const CASES = [
  {
    name: "old official identity sentence + empty suffix (new host)",
    variables: VARS_NEW,
    sections: [
      { name: "harness:identity", text: OFFICIAL, order: 0 },
      { name: "deployment:persona-suffix", text: "", order: 10 },
    ],
    expectEmptySuffix: false,
  },
  {
    name: "suffix is a bare cwd sentence (new host)",
    variables: VARS_NEW,
    sections: [{ name: "deployment:persona-suffix", text: CWD_ONLY, order: 10 }],
  },
  {
    name: "no suffix section at all (new host)",
    variables: VARS_NEW,
    sections: [{ name: "harness:identity", text: OFFICIAL, order: 0 }],
    expectSuffix: true,
  },
  {
    name: "user inject text carrying {{cwd}} (new host)",
    variables: VARS_NEW,
    sections: [{ name: "dsh-purge", text: "Operator prompt. cwd is {{cwd}}." }],
    inject: "Operator prompt. cwd is {{cwd}}.",
  },
  {
    name: "third-party section carrying [cwd] and {{cwd}} (new host)",
    variables: VARS_NEW,
    sections: [{ name: "someone:else", text: "Work in [cwd]. Also {{cwd}}." }],
  },
  {
    name: "custom suffix text must survive untouched",
    variables: VARS_NEW,
    sections: [{ name: "deployment:persona-suffix", text: "Be terse and concrete.", order: 10 }],
    expectCustom: "Be terse and concrete.",
  },
  {
    name: "legacy host that still registers cwd",
    variables: VARS_OLD,
    sections: [{ name: "deployment:persona-suffix", text: "", order: 10 }],
    expectVariableSuffixOk: true,
  },
];

const REGISTERED_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

function unregistered(text, variables) {
  const names = Object.keys(variables);
  const bad = [];
  for (const m of String(text).matchAll(REGISTERED_RE)) {
    if (!names.includes(m[1])) bad.push(m[1]);
  }
  // A lone `{{` left over is a "malformed reference" in the host's eyes.
  if (/\{\{(?!\s*[a-z][a-z0-9_]*\s*\}\})/.test(String(text))) bad.push("malformed");
  return bad;
}

let failures = 0;
for (const testCase of CASES) {
  const assembled = {
    variables: { ...testCase.variables },
    sections: testCase.sections.map((s) => ({ ...s })),
    contexts: [],
    tools: [],
  };
  const before = JSON.stringify(assembled);
  let out;
  try {
    out = rewritePromptAssembly(assembled, testCase.inject || "", { context: {} });
  } catch (err) {
    console.log(`FAIL  ${testCase.name}\n      rewrite threw: ${err.message}`);
    failures += 1;
    continue;
  }
  const problems = [];
  if (JSON.stringify(assembled) !== before) problems.push("input assembly was mutated in place");
  for (const section of out.sections || []) {
    for (const name of unregistered(section.text, testCase.variables)) {
      problems.push(`section "${section.name}" still references ${name === "malformed" ? "a malformed reference" : `{{${name}}}`}`);
    }
  }
  for (const context of out.contexts || []) {
    for (const name of unregistered(context.text, testCase.variables)) {
      problems.push(`context "${context.name}" still references ${name === "malformed" ? "a malformed reference" : `{{${name}}}`}`);
    }
  }
  const suffixes = (out.sections || []).filter((s) => s.name === "deployment:persona-suffix");
  if (testCase.expectSuffix && suffixes.length !== 1) problems.push("expected exactly one injected persona-suffix");
  if (testCase.expectCustom && !String(suffixes[0]?.text || "").includes(testCase.expectCustom)) {
    problems.push(`custom suffix was rewritten to ${JSON.stringify(suffixes[0]?.text)}`);
  }
  if (testCase.expectVariableSuffixOk) {
    const text = String(suffixes[0]?.text || "");
    if (!text.trim()) problems.push("legacy host lost its suffix text");
  }
  if (problems.length) {
    failures += 1;
    console.log(`FAIL  ${testCase.name}`);
    for (const p of problems) console.log(`      ${p}`);
  } else {
    console.log(`ok    ${testCase.name}`);
  }
}

console.log(failures === 0 ? "\nall cwd-variable tests passed" : `\n${failures} failing case(s)`);
process.exit(failures === 0 ? 0 : 1);
