"use strict";

const assert = require("node:assert/strict");
const PVQR = require("./protocol.js");

// NTSC-M values from ITU-R BT.470. Four samples per color-subcarrier cycle
// make the quadrature modulation deterministic without external DSP packages.
const COLOR_SUBCARRIER_HZ = 3579545;
const LINE_FREQUENCY_HZ = COLOR_SUBCARRIER_HZ * 2 / 455;
const SAMPLE_RATE_HZ = COLOR_SUBCARRIER_HZ * 4;
const ACTIVE_VIDEO_SECONDS = 52.66e-6;
const ACTIVE_SAMPLES = Math.round(SAMPLE_RATE_HZ * ACTIVE_VIDEO_SECONDS);
const SOURCE_WIDTH = PVQR.GRID_WIDTH * PVQR.MODULE_SIZE;
const SOURCE_HEIGHT = PVQR.GRID_HEIGHT * PVQR.MODULE_SIZE;
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function deterministicNoise(x, y, seed) {
  let value = Math.imul(x + 1, 0x45D9F3B) ^ Math.imul(y + 1, 0x119DE1F3) ^ seed;
  value ^= value >>> 16;
  value = Math.imul(value, 0x45D9F3B);
  value ^= value >>> 16;
  return ((value >>> 0) / 0xFFFFFFFF) * 2 - 1;
}

function lowPass(input, cutoffHz) {
  if (cutoffHz >= SAMPLE_RATE_HZ / 2) return Float64Array.from(input);
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoffHz / SAMPLE_RATE_HZ);
  const output = new Float64Array(input.length);
  let state = input[0];
  for (let index = 0; index < input.length; index += 1) {
    state += alpha * (input[index] - state);
    output[index] = state;
  }
  state = output[output.length - 1];
  for (let index = output.length - 1; index >= 0; index -= 1) {
    state += alpha * (output[index] - state);
    output[index] = state;
  }
  return output;
}

function rgbToYiq(red, green, blue) {
  return [
    0.299 * red + 0.587 * green + 0.114 * blue,
    0.596 * red - 0.274 * green - 0.322 * blue,
    0.211 * red - 0.523 * green + 0.312 * blue,
  ];
}

function yiqToRgb(y, i, q) {
  return [
    y + 0.956 * i + 0.621 * q,
    y - 0.272 * i - 0.647 * q,
    y - 1.106 * i + 1.703 * q,
  ];
}

function sourceRgbAt(source, x, y) {
  const left = Math.max(0, Math.min(SOURCE_WIDTH - 1, Math.floor(x)));
  const right = Math.min(SOURCE_WIDTH - 1, left + 1);
  const fraction = clamp(x - left);
  const row = Math.max(0, Math.min(SOURCE_HEIGHT - 1, y));
  const leftOffset = (row * SOURCE_WIDTH + left) * 4;
  const rightOffset = (row * SOURCE_WIDTH + right) * 4;
  return [0, 1, 2].map((channel) => (
    (source.data[leftOffset + channel] * (1 - fraction)
      + source.data[rightOffset + channel] * fraction) / 255
  ));
}

function encodeComposite(source, options, frameSeed) {
  const lines = [];
  const chromaScale = options.encoderSaturation ?? 1;
  for (let y = 0; y < SOURCE_HEIGHT; y += 1) {
    const luma = new Float64Array(ACTIVE_SAMPLES);
    const inPhase = new Float64Array(ACTIVE_SAMPLES);
    const quadrature = new Float64Array(ACTIVE_SAMPLES);
    for (let sample = 0; sample < ACTIVE_SAMPLES; sample += 1) {
      const sourceX = (sample + 0.5) * SOURCE_WIDTH / ACTIVE_SAMPLES - 0.5;
      const [red, green, blue] = sourceRgbAt(source, sourceX, y);
      [luma[sample], inPhase[sample], quadrature[sample]] = rgbToYiq(red, green, blue);
    }

    const filteredY = lowPass(luma, options.encoderLumaBandwidthHz);
    const filteredI = lowPass(inPhase, options.encoderChromaBandwidthHz);
    const filteredQ = lowPass(quadrature, options.encoderChromaBandwidthHz);
    const composite = new Float64Array(ACTIVE_SAMPLES);
    const encoderPhase = (options.encoderPhaseDegrees || 0) * Math.PI / 180;
    for (let sample = 0; sample < ACTIVE_SAMPLES; sample += 1) {
      const phase = sample * Math.PI / 2 + y * Math.PI + encoderPhase;
      composite[sample] = filteredY[sample]
        + chromaScale * (filteredI[sample] * Math.cos(phase) + filteredQ[sample] * Math.sin(phase));
    }

    const cable = lowPass(composite, options.cableBandwidthHz);
    const degraded = new Float64Array(ACTIVE_SAMPLES);
    const ghostDelay = options.ghostDelaySamples || 0;
    const ghostGain = options.ghostGain || 0;
    for (let sample = 0; sample < ACTIVE_SAMPLES; sample += 1) {
      const ghost = sample >= ghostDelay ? cable[sample - ghostDelay] * ghostGain : 0;
      const noise = deterministicNoise(sample, y, frameSeed) * options.compositeNoise;
      degraded[sample] = clamp(cable[sample] + ghost + noise, -0.4, 1.4);
    }
    lines.push(degraded);
  }
  return lines;
}

function separateLumaChroma(lines, lineIndex, mode) {
  const current = lines[lineIndex];
  const luma = new Float64Array(ACTIVE_SAMPLES);
  const chroma = new Float64Array(ACTIVE_SAMPLES);
  if (mode === "comb") {
    const neighborIndex = lineIndex > 0 ? lineIndex - 1 : lineIndex + 1;
    const neighbor = lines[neighborIndex];
    for (let sample = 0; sample < ACTIVE_SAMPLES; sample += 1) {
      luma[sample] = (current[sample] + neighbor[sample]) / 2;
      chroma[sample] = (current[sample] - neighbor[sample]) / 2;
    }
  } else {
    // A two-tap fsc notch: two 4*fsc samples represent a 180-degree shift.
    for (let sample = 0; sample < ACTIVE_SAMPLES; sample += 1) {
      const delayed = current[Math.max(0, sample - 2)];
      luma[sample] = (current[sample] + delayed) / 2;
      chroma[sample] = current[sample] - luma[sample];
    }
  }
  return { luma, chroma };
}

function decodeComposite(lines, options) {
  const decoded = [];
  const phaseError = options.decoderPhaseDegrees * Math.PI / 180;
  for (let y = 0; y < SOURCE_HEIGHT; y += 1) {
    const { luma, chroma } = separateLumaChroma(lines, y, options.decoder);
    const rawI = new Float64Array(ACTIVE_SAMPLES);
    const rawQ = new Float64Array(ACTIVE_SAMPLES);
    for (let sample = 0; sample < ACTIVE_SAMPLES; sample += 1) {
      const phase = sample * Math.PI / 2 + y * Math.PI + phaseError;
      rawI[sample] = 2 * chroma[sample] * Math.cos(phase);
      rawQ[sample] = 2 * chroma[sample] * Math.sin(phase);
    }
    const filteredY = lowPass(luma, options.decoderLumaBandwidthHz);
    const filteredI = lowPass(rawI, options.decoderChromaBandwidthHz);
    const filteredQ = lowPass(rawQ, options.decoderChromaBandwidthHz);
    decoded.push({ y: filteredY, i: filteredI, q: filteredQ });
  }
  return decoded;
}

function applyYuv420(imageData) {
  const { width, height, data } = imageData;
  const output = new Uint8ClampedArray(data.length);
  for (let y0 = 0; y0 < height; y0 += 2) {
    for (let x0 = 0; x0 < width; x0 += 2) {
      const samples = [];
      let cb = 0;
      let cr = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const x = Math.min(width - 1, x0 + dx);
          const y = Math.min(height - 1, y0 + dy);
          const offset = (y * width + x) * 4;
          const red = data[offset] / 255;
          const green = data[offset + 1] / 255;
          const blue = data[offset + 2] / 255;
          const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
          samples.push({ offset, luma });
          cb += (blue - luma) / 1.772;
          cr += (red - luma) / 1.402;
        }
      }
      cb /= 4;
      cr /= 4;
      for (const sample of samples) {
        const red = sample.luma + 1.402 * cr;
        const blue = sample.luma + 1.772 * cb;
        const green = (sample.luma - 0.299 * red - 0.114 * blue) / 0.587;
        output[sample.offset] = clamp(red) * 255;
        output[sample.offset + 1] = clamp(green) * 255;
        output[sample.offset + 2] = clamp(blue) * 255;
        output[sample.offset + 3] = 255;
      }
    }
  }
  return { width, height, data: output };
}

function captureFrame(matrix, options, frameSeed) {
  const source = PVQR.renderMatrixToRgba(matrix);
  const composite = encodeComposite(source, options, frameSeed);
  const decoded = decodeComposite(composite, options);
  const data = new Uint8ClampedArray(CAPTURE_WIDTH * CAPTURE_HEIGHT * 4);
  for (let captureY = 0; captureY < CAPTURE_HEIGHT; captureY += 1) {
    const sourceY = Math.min(SOURCE_HEIGHT - 1, Math.floor(captureY * SOURCE_HEIGHT / CAPTURE_HEIGHT));
    const nextY = Math.min(SOURCE_HEIGHT - 1, sourceY + 1);
    const jitter = deterministicNoise(sourceY, frameSeed & 255, 0x52434131) * options.lineJitterSamples;
    for (let captureX = 0; captureX < CAPTURE_WIDTH; captureX += 1) {
      const sample = clamp(
        (captureX + 0.5) * ACTIVE_SAMPLES / CAPTURE_WIDTH - 0.5 + jitter,
        0,
        ACTIVE_SAMPLES - 1.001,
      );
      const left = Math.floor(sample);
      const right = Math.min(ACTIVE_SAMPLES - 1, left + 1);
      const fraction = sample - left;
      const channel = (name) => {
        const current = decoded[sourceY][name][left] * (1 - fraction) + decoded[sourceY][name][right] * fraction;
        const adjacent = decoded[nextY][name][left] * (1 - fraction) + decoded[nextY][name][right] * fraction;
        return current * (1 - options.verticalBlend) + adjacent * options.verticalBlend;
      };
      const y = channel("y") * options.lumaGain + options.lumaOffset;
      const i = channel("i") * options.decoderSaturation;
      const q = channel("q") * options.decoderSaturation;
      const rgb = yiqToRgb(y, i, q);
      const offset = (captureY * CAPTURE_WIDTH + captureX) * 4;
      const captureNoise = deterministicNoise(captureX, captureY, frameSeed ^ 0x55AA7733)
        * options.captureNoise;
      for (let component = 0; component < 3; component += 1) {
        const quantized = Math.round(clamp(rgb[component] + captureNoise) * 255 / options.quantization)
          * options.quantization;
        data[offset + component] = clamp(quantized, 0, 255);
      }
      data[offset + 3] = 255;
    }
  }
  const imageData = { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, data };
  return options.yuv420 ? applyYuv420(imageData) : imageData;
}

const scenarios = [
  {
    name: "short RCA cable and comb decoder",
    encoderLumaBandwidthHz: 4200000,
    encoderChromaBandwidthHz: 1300000,
    encoderSaturation: 0.92,
    encoderPhaseDegrees: 0,
    cableBandwidthHz: 4200000,
    compositeNoise: 0.002,
    ghostDelaySamples: 0,
    ghostGain: 0,
    decoder: "comb",
    decoderLumaBandwidthHz: 4200000,
    decoderChromaBandwidthHz: 1000000,
    decoderPhaseDegrees: 2,
    decoderSaturation: 0.95,
    lineJitterSamples: 0.15,
    verticalBlend: 0.04,
    lumaGain: 0.98,
    lumaOffset: 0.01,
    captureNoise: 0.002,
    quantization: 2,
    yuv420: true,
  },
  {
    name: "consumer TV notch decoder",
    encoderLumaBandwidthHz: 3800000,
    encoderChromaBandwidthHz: 600000,
    encoderSaturation: 0.88,
    encoderPhaseDegrees: 1,
    cableBandwidthHz: 3400000,
    compositeNoise: 0.005,
    ghostDelaySamples: 5,
    ghostGain: 0.025,
    decoder: "notch",
    decoderLumaBandwidthHz: 3000000,
    decoderChromaBandwidthHz: 600000,
    decoderPhaseDegrees: 7,
    decoderSaturation: 0.86,
    lineJitterSamples: 0.45,
    verticalBlend: 0.10,
    lumaGain: 0.96,
    lumaOffset: 0.015,
    captureNoise: 0.004,
    quantization: 4,
    yuv420: true,
  },
  {
    name: "cheap USB capture and long RCA cable",
    encoderLumaBandwidthHz: 3400000,
    encoderChromaBandwidthHz: 600000,
    encoderSaturation: 0.86,
    encoderPhaseDegrees: 2,
    cableBandwidthHz: 2700000,
    compositeNoise: 0.009,
    ghostDelaySamples: 7,
    ghostGain: 0.055,
    decoder: "notch",
    decoderLumaBandwidthHz: 2400000,
    decoderChromaBandwidthHz: 450000,
    decoderPhaseDegrees: 12,
    decoderSaturation: 0.75,
    lineJitterSamples: 0.8,
    verticalBlend: 0.20,
    lumaGain: 0.93,
    lumaOffset: 0.025,
    captureNoise: 0.008,
    quantization: 6,
    yuv420: true,
  },
];

const fullTransfer = process.argv.includes("--full");
const source = new Uint8Array(fullTransfer ? 512 * 1024 : 4096);
for (let index = 0; index < source.length; index += 1) source[index] = (index * 29 + 7) & 0xFF;
const encoded = PVQR.splitTransfer(source);
const results = [];
const selectedScenarios = fullTransfer ? [scenarios[scenarios.length - 1]] : scenarios;

for (let scenarioIndex = 0; scenarioIndex < selectedScenarios.length; scenarioIndex += 1) {
  const scenario = selectedScenarios[scenarioIndex];
  const collector = new PVQR.TransferCollector();
  let rejected = 0;
  let minimumPaletteSeparation = Infinity;
  for (let loop = 0; loop < 2 && !collector.complete; loop += 1) {
    for (let chunkIndex = 0; chunkIndex < encoded.length; chunkIndex += 1) {
      const matrix = PVQR.packetToMatrix(encoded[chunkIndex]);
      const frameSeed = 0x12340000 ^ (scenarioIndex << 16) ^ (loop << 12) ^ chunkIndex;
      const captured = captureFrame(matrix, scenario, frameSeed);
      try {
        const scan = PVQR.sampleMatrix(captured);
        minimumPaletteSeparation = Math.min(minimumPaletteSeparation, scan.minimumSeparation);
        collector.add(PVQR.parsePacket(PVQR.matrixToPacket(scan.matrix)));
      } catch (error) {
        if (!(error instanceof PVQR.ProtocolError)) throw error;
        rejected += 1;
      }
    }
  }
  assert.equal(collector.complete, true, scenario.name);
  assert.deepEqual(collector.assemble(), source, scenario.name);
  results.push({
    name: scenario.name,
    recovered: collector.received,
    rejected,
    minimumPaletteSeparation: Number(minimumPaletteSeparation.toFixed(1)),
  });
}

if (!fullTransfer) {
  const destructive = {
    ...scenarios[scenarios.length - 1],
    name: "destructive negative control",
    cableBandwidthHz: 1300000,
    compositeNoise: 0.03,
    decoderChromaBandwidthHz: 150000,
    decoderPhaseDegrees: 38,
    decoderSaturation: 0.18,
    lineJitterSamples: 2.5,
    verticalBlend: 0.42,
    captureNoise: 0.025,
    quantization: 16,
  };
  const captured = captureFrame(PVQR.packetToMatrix(encoded[4]), destructive, 0xBADCAFE);
  assert.throws(() => {
    const scan = PVQR.sampleMatrix(captured);
    PVQR.parsePacket(PVQR.matrixToPacket(scan.matrix));
  }, PVQR.ProtocolError);
}

assert.equal(Math.round(LINE_FREQUENCY_HZ), 15734);
console.log(JSON.stringify({
  standard: {
    colorSubcarrierHz: COLOR_SUBCARRIER_HZ,
    lineFrequencyHz: Number(LINE_FREQUENCY_HZ.toFixed(2)),
    sampleRateHz: SAMPLE_RATE_HZ,
    activeSamplesPerLine: ACTIVE_SAMPLES,
  },
  bytes: source.length,
  chunks: encoded.length,
  negativeControlRejected: fullTransfer ? null : true,
  scenarios: results,
}, null, 2));
