/**
 * tests/hardware.test.js
 *
 * Hardware-matched local model recommendation (grill 2026-10-27, decisions
 * 2, 3 and 5): the machine is reduced to ONE number — the memory a model may
 * occupy — and the recommendation is the biggest registry model that fits
 * into it completely (weights + KV cache at 32k, no offload). Nothing here
 * touches the real machine: platform, RAM and the GPU tools are injected.
 */

const { detectHardware, recommendModel } = require('../hardware');

const GB = 1024 * 1024 * 1024;

// A tool runner that answers like the named command would on this machine.
function fakeExec(answers) {
  return (cmd) => {
    const a = answers[cmd];
    if (!a) return { status: 127, stdout: '' };
    return { status: 0, stdout: a };
  };
}

// The registry rungs as the ladder sees them (decision 3) — the real
// registry.json carries more fields; these are the ones the ladder reads.
const MODELS = [
  { name: 'qwen3.5:4b', minMemoryGb: 0, fitsGb: 6.8 },
  { name: 'qwen3.5:9b', minMemoryGb: 8, fitsGb: 10.1 },
  { name: 'gemma4:12b', minMemoryGb: 8, fitsGb: 11.5, alternative: true },
  { name: 'qwen3.8:27b', minMemoryGb: 20, fitsGb: 21.5 },
  { name: 'gemma4:31b', minMemoryGb: 30, fitsGb: 23.5 },
];

describe('detectHardware — one number per machine', () => {
  it('reads the dedicated VRAM of an NVIDIA card on Linux', () => {
    const hw = detectHardware({
      platform: 'linux',
      totalmem: () => 62 * GB,
      exec: fakeExec({ 'nvidia-smi': 'NVIDIA GeForce RTX 5080 Laptop GPU, 16303\n' }),
    });
    expect(hw.gpu).toEqual({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080 Laptop GPU', vramGb: 15.9 });
    expect(hw.usableGb).toBe(15.9);
    expect(hw.basis).toBe('vram');
    expect(hw.totalMemGb).toBe(62);
  });

  it('counts ~70 % of unified memory on Apple Silicon', () => {
    const hw = detectHardware({
      platform: 'darwin',
      arch: 'arm64',
      totalmem: () => 24 * GB,
      exec: fakeExec({}),
    });
    expect(hw.basis).toBe('unified');
    expect(hw.usableGb).toBe(16.8);
    expect(hw.gpu).toEqual({ vendor: 'apple', name: 'Apple Silicon', vramGb: 16.8 });
  });

  it('falls to the CPU basis with zero usable GPU memory when no GPU tool answers', () => {
    const hw = detectHardware({
      platform: 'linux',
      totalmem: () => 16 * GB,
      exec: fakeExec({}),
    });
    expect(hw.gpu).toBeNull();
    expect(hw.basis).toBe('cpu');
    expect(hw.usableGb).toBe(0);
  });

  it('reads an AMD card through rocm-smi when nvidia-smi is absent', () => {
    const hw = detectHardware({
      platform: 'linux',
      totalmem: () => 32 * GB,
      exec: fakeExec({
        'rocm-smi': 'device,VRAM Total Memory (B),VRAM Total Used Memory (B)\ncard0,25753026560,1234\n',
      }),
    });
    expect(hw.gpu.vendor).toBe('amd');
    expect(hw.usableGb).toBe(24);
    expect(hw.basis).toBe('vram');
  });
});

describe('recommendModel — the biggest model that fits completely', () => {
  it('picks the 8–20 GB rung for a 16 GB card, preferring the first rung model over its alternative', () => {
    const r = recommendModel(15.9, MODELS);
    expect(r.model.name).toBe('qwen3.5:9b');
    expect(r.fits).toBe(true);
  });

  it('never recommends a model whose full footprint exceeds the usable memory (decision 5)', () => {
    // 20 GB usable: the 20-GB rung's model needs 21.5 GB → not offered.
    const r = recommendModel(20, MODELS);
    expect(r.model.name).toBe('qwen3.5:9b');
  });

  it('steps up when both the rung and the footprint allow it', () => {
    expect(recommendModel(24, MODELS).model.name).toBe('qwen3.8:27b');
    expect(recommendModel(36, MODELS).model.name).toBe('gemma4:31b');
  });

  it('falls back to the smallest model, flagged as not fitting, on a machine without GPU memory', () => {
    const r = recommendModel(0, MODELS);
    expect(r.model.name).toBe('qwen3.5:4b');
    expect(r.fits).toBe(false);
  });

  it('lists the other models that would also fit, for the library', () => {
    const r = recommendModel(15.9, MODELS);
    expect(r.alsoFits.map((m) => m.name)).toEqual(['qwen3.5:4b', 'gemma4:12b']);
  });
});
