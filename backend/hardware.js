/**
 * hardware.js — the machine as ONE number, and the model that fits it.
 *
 * Hardware-matched local model recommendation (grill 2026-10-27; revives the
 * ladder removed with the ADR-0008 amendment of 2026-07-25, now keyed on the
 * memory a model may occupy instead of on RAM):
 *
 *   NVIDIA / AMD  → dedicated VRAM (nvidia-smi / rocm-smi)          basis 'vram'
 *   Apple Silicon → ~70 % of unified memory (the rest is macOS')    basis 'unified'
 *   no GPU        → 0 usable GB; the smallest model is offered as a
 *                   "runs on the CPU, slower" fallback                basis 'cpu'
 *
 * The recommendation itself reads the Ollama models of the registry
 * (registry.json, decision 6): each carries `minMemoryGb` (the rung it
 * belongs to) and `fitsGb` (weights + KV cache at 32k + buffer). A model is
 * offered only when BOTH hold (decision 5: no partial offload — a model half
 * in RAM is slower than the next rung down entirely on the GPU).
 *
 * Everything that touches the machine is injectable so tests never do.
 */

const os = require('os');
const { spawnSync } = require('child_process');

const GB = 1024 * 1024 * 1024;
const UNIFIED_SHARE = 0.7;

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Runs a tool and hands back its exit status and stdout; a missing binary is
// just a non-zero status, never an exception.
function runTool(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  if (r.error) return { status: 127, stdout: '' };
  return { status: r.status, stdout: r.stdout || '' };
}

function nvidiaGpu(exec) {
  const r = exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (r.status !== 0) return null;
  // One line per GPU: "<name>, <MiB>" — the first (primary) card counts.
  const line = r.stdout.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const comma = line.lastIndexOf(',');
  if (comma < 0) return null;
  const mib = parseInt(line.slice(comma + 1).trim(), 10);
  if (!Number.isFinite(mib) || mib <= 0) return null;
  return { vendor: 'nvidia', name: line.slice(0, comma).trim(), vramGb: round1(mib / 1024) };
}

function amdGpu(exec) {
  const r = exec('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
  if (r.status !== 0) return null;
  // CSV: device,VRAM Total Memory (B),VRAM Total Used Memory (B)
  const rows = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const data = rows.find((l) => /^card\d/i.test(l));
  if (!data) return null;
  const bytes = parseInt(data.split(',')[1], 10);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return { vendor: 'amd', name: data.split(',')[0], vramGb: round1(bytes / GB) };
}

/**
 * The machine's facts. `system` is injectable: { platform, arch, totalmem, exec }.
 */
function detectHardware(system = {}) {
  const platform = system.platform || process.platform;
  const arch = system.arch || process.arch;
  const totalmem = system.totalmem || os.totalmem;
  const exec = system.exec || runTool;
  const totalMemGb = Math.round(totalmem() / GB);

  if (platform === 'darwin' && arch === 'arm64') {
    const usableGb = round1(totalMemGb * UNIFIED_SHARE);
    return {
      platform,
      totalMemGb,
      gpu: { vendor: 'apple', name: 'Apple Silicon', vramGb: usableGb },
      usableGb,
      basis: 'unified',
    };
  }

  const gpu = nvidiaGpu(exec) || amdGpu(exec);
  if (gpu) {
    return { platform, totalMemGb, gpu, usableGb: gpu.vramGb, basis: 'vram' };
  }
  return { platform, totalMemGb, gpu: null, usableGb: 0, basis: 'cpu' };
}

/**
 * The model to offer for `usableGb`, from the registry's Ollama models.
 * Returns { model, fits, alsoFits }: the highest rung whose model fits
 * completely (list order breaks ties, so a rung's first model beats its
 * `alternative`), or the smallest model flagged `fits: false` when nothing
 * fits (the CPU case). `alsoFits` are the remaining models that would fit,
 * for the library's secondary list.
 */
function recommendModel(usableGb, models) {
  const fitting = models.filter((m) => m.minMemoryGb <= usableGb && m.fitsGb <= usableGb);
  if (fitting.length === 0) {
    const smallest = [...models].sort((a, b) => a.fitsGb - b.fitsGb)[0] || null;
    return { model: smallest, fits: false, alsoFits: [] };
  }
  let best = fitting[0];
  for (const m of fitting) {
    if (m.minMemoryGb > best.minMemoryGb) best = m;
  }
  return {
    model: best,
    fits: true,
    alsoFits: fitting.filter((m) => m !== best),
  };
}

module.exports = { detectHardware, recommendModel };
