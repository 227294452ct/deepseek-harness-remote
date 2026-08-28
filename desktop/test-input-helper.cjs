'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawn } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('windows-input-helper-test-skipped')
  process.exit(0)
}

const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const script = path.join(__dirname, 'windows-input-helper.ps1')
const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun'], {
  windowsHide: true,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe']
})
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
child.stdin.end([
  { type: 'pointer', action: 'click', button: 'left', x: 100, y: 100 },
  { type: 'key', action: 'press', codes: [17, 67] },
  { type: 'text', text: '中文 test' },
  { type: 'release-all' },
  { type: 'shutdown' }
].map(value => JSON.stringify(value)).join('\n') + '\n')
child.once('exit', code => {
  assert.equal(code, 0, stderr)
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(lines.map(value => value.type), ['pointer', 'key', 'text', 'release-all', 'shutdown'])
  console.log('windows-input-helper-dry-run-test-ok')
})
