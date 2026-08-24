"use strict";

const assert = require("node:assert/strict");
const PVQR = require("./protocol.js");

function invert3x3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (Math.abs(determinant) < 1e-9) throw new Error("singular camera geometry");
  return [A, B, C, D, E, F, G, H, I].map((value) => value / determinant);
}

function squareToQuad(corners) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const determinant = dx1 * dy2 - dx2 * dy1;
  const projectiveX = (dx3 * dy2 - dx2 * dy3) / determinant;
  const projectiveY = (dx1 * dy3 - dx3 * dy1) / determinant;
  return [
    x1 - x0 + projectiveX * x1,
    x3 - x0 + projectiveY * x3,
    x0,
    y1 - y0 + projectiveX * y1,
    y3 - y0 + projectiveY * y3,
    y0,
    projectiveX,
    projectiveY,
    1,
  ];
}

function noiseAt(x, y, seed) {
  let value = Math.imul(x + 1, 0x45D9F3B) ^ Math.imul(y + 1, 0x119DE1F3) ^ seed;
  value ^= value >>> 16;
  value = Math.imul(value, 0x45D9F3B);
  value ^= value >>> 16;
  return ((value >>> 0) / 0xFFFFFFFF) * 2 - 1;
}

function cameraFrame(matrix, options) {
  const source = PVQR.renderMatrixToRgba(matrix);
  const { width, height, corners, gains, offsets, noise, quantization, blockNoise } = options;
  const inverse = invert3x3(squareToQuad(corners));
  const output = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const outputOffset = (y * width + x) * 4;
      const denominator = inverse[6] * x + inverse[7] * y + inverse[8];
      const u = (inverse[0] * x + inverse[1] * y + inverse[2]) / denominator;
      const v = (inverse[3] * x + inverse[4] * y + inverse[5]) / denominator;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) {
        output[outputOffset] = 9;
        output[outputOffset + 1] = 11;
        output[outputOffset + 2] = 14;
        output[outputOffset + 3] = 255;
        continue;
      }

      const sourceX = Math.min(source.width - 1, Math.floor(u * source.width));
      const sourceY = Math.min(source.height - 1, Math.floor(v * source.height));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const vignette = 1 - 0.22 * ((u - 0.5) ** 2 + (v - 0.5) ** 2);
      const grain = noiseAt(x, y, 0x13579BDF) * noise;
      const block = noiseAt(x >> 3, y >> 3, 0x2468ACE0) * blockNoise;
      for (let channel = 0; channel < 3; channel += 1) {
        let value = source.data[sourceOffset + channel] * gains[channel] * vignette
          + offsets[channel] + grain + block;
        value = Math.round(value / quantization) * quantization;
        output[outputOffset + channel] = Math.max(0, Math.min(255, value));
      }
      output[outputOffset + 3] = 255;
    }
  }
  return { imageData: { width, height, data: output }, corners };
}

const source = new Uint8Array(4096);
for (let index = 0; index < source.length; index += 1) source[index] = (index * 29 + 7) & 0xFF;
const encoded = PVQR.splitTransfer(source);
const testMatrix = PVQR.packetToMatrix(encoded[4]);

const scenarios = [
  {
    name: "daylight perspective",
    width: 640,
    height: 480,
    corners: [[64, 48], [574, 27], [606, 435], [42, 455]],
    gains: [0.78, 0.92, 1.04],
    offsets: [18, 8, -3],
    noise: 7,
    quantization: 8,
    blockNoise: 3,
  },
  {
    name: "dim warm camera",
    width: 480,
    height: 360,
    corners: [[51, 33], [430, 50], [455, 326], [28, 309]],
    gains: [0.68, 0.57, 0.48],
    offsets: [26, 19, 14],
    noise: 10,
    quantization: 12,
    blockNoise: 5,
  },
  {
    name: "small compressed frame",
    width: 360,
    height: 270,
    corners: [[31, 24], [330, 37], [341, 248], [18, 235]],
    gains: [0.74, 0.82, 0.69],
    offsets: [14, 11, 18],
    noise: 12,
    quantization: 16,
    blockNoise: 7,
  },
];

for (const scenario of scenarios) {
  const frame = cameraFrame(testMatrix, scenario);
  const scan = PVQR.sampleMatrix(frame.imageData, frame.corners);
  const decoded = PVQR.parsePacket(PVQR.matrixToPacket(scan.matrix));
  assert.deepEqual(decoded.payload, source.slice(4 * PVQR.PAYLOAD_SIZE, 5 * PVQR.PAYLOAD_SIZE), scenario.name);
  assert.ok(scan.minimumSeparation > 35, scenario.name);
}

const collector = new PVQR.TransferCollector();
let cameraFrameIndex = 0;
for (let loop = 0; loop < 2; loop += 1) {
  for (let displayFrame = 0; displayFrame < encoded.length * 5; displayFrame += 1) {
    if (displayFrame % 2 !== 0) continue; // 60 Hz display sampled by a 30 fps camera.
    const chunkIndex = Math.floor(displayFrame / 5);
    if (loop === 0 && chunkIndex % 5 === 1) continue; // A fixed obstruction loses some symbols.
    if ((cameraFrameIndex++ * 17 + 3) % 13 === 0) continue; // Additional isolated frame drops.
    collector.add(PVQR.parsePacket(encoded[chunkIndex]));
  }
  if (loop === 0) assert.equal(collector.complete, false);
}
assert.equal(collector.complete, true);
assert.deepEqual(collector.assemble(), source);

console.log(`ok: ${scenarios.length} camera distortions, 30 fps sampling, loop recovery`);
