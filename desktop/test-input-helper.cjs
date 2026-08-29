'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('windows-input-helper-test-skipped')
  process.exit(0)
}

const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const script = path.join(__dirname, 'windows-input-helper.ps1')
const source = readFileSync(script, 'utf8')
assert.match(source, /IsPhysicalMouseAction\(wParam\)/, 'mouse hook must filter passive mouse movement')
assert.match(source, /value == 0x0201L[\s\S]*value == 0x020EL/, 'mouse hook must watch clicks and wheel actions')
assert.match(source, /IsPhysicalKeyboardAction\(wParam\)/, 'keyboard hook must filter key-up events')
assert.match(source, /TimeSpan\.TicksPerMillisecond \* 800/, 'local input watch needs a startup grace period')
assert.match(source, /RemoteInputMarker = new UIntPtr\(0x44534852u\)/, 'remote input needs an explicit identifying marker')
assert.match(source, /!value\.extra\.Equals\(RemoteInputMarker\)/, 'local input hooks must ignore marked remote input')
assert.match(source, /extra=RemoteInputMarker/, 'injected input must carry the remote marker')
assert.match(source, /SetThreadDpiAwarenessContext\(IntPtr context\)/, 'input helper must opt into a physical-pixel DPI context')
assert.match(source, /PerMonitorAwareV2 = new IntPtr\(-4\)/, 'input helper must use per-monitor v2 DPI awareness')
assert.match(source, /public static void Move\(int x, int y\) \{\s*SetThreadDpiAwarenessContext\(PerMonitorAwareV2\)/, 'pointer mapping must read virtual screen metrics in the physical-pixel DPI context')
assert.match(source, /ConfigureDpiAwareness\(\); \[DshRemoteInput\]::StartLocalInputWatch\(\)/, 'DPI awareness must be configured before the input watcher starts')
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
