"use strict";

const assert = require("node:assert/strict");
const PVQR = require("./protocol.js");

function equalBytes(actual, expected) {
  assert.deepEqual(Array.from(actual), Array.from(expected));
}

const source = new Uint8Array(4096);
for (let index = 0; index < source.length; index += 1) source[index] = (index * 29 + 7) & 0xFF;

const encoded = PVQR.splitTransfer(source);
const decodedFirst = PVQR.parsePacket(PVQR.matrixToPacket(PVQR.packetToMatrix(encoded[0])));
assert.equal(decodedFirst.flags, PVQR.FLAG_LZSS);
equalBytes(decodedFirst.payload, PVQR.parsePacket(encoded[0]).payload);

const collector = new PVQR.TransferCollector();
for (const packet of [...encoded].reverse()) {
  const decoded = PVQR.parsePacket(packet);
  collector.add(decoded);
  collector.add(decoded);
}
assert.equal(collector.complete, true);
equalBytes(collector.assemble(), source);

const compressed = PVQR.lzssEncode(source);
assert.ok(compressed.length < source.length);
equalBytes(PVQR.lzssDecode(compressed, source.length), source);
assert.throws(() => PVQR.lzssDecode(compressed.slice(0, -1), source.length), PVQR.ProtocolError);

const lzssVector = Uint8Array.from({ length: 512 }, (_, index) => index & 15);
const lzssVectorEncoded = PVQR.lzssEncode(lzssVector);
assert.equal(lzssVectorEncoded.length, 78);
assert.equal(PVQR.crc32(lzssVectorEncoded), 0x1435CB12);

const noisy = new Uint8Array(1024);
let noiseState = 0x12345678;
for (let index = 0; index < noisy.length; index += 1) {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  noisy[index] = noiseState & 0xFF;
}
const rawPackets = PVQR.splitTransfer(noisy);
assert.equal(PVQR.parsePacket(rawPackets[0]).flags, 0);
const rawCollector = new PVQR.TransferCollector();
for (const packet of rawPackets) rawCollector.add(PVQR.parsePacket(packet));
equalBytes(rawCollector.assemble(), noisy);

const matrix = PVQR.packetToMatrix(encoded[0]);
const [badX, badY] = PVQR.DATA_POSITIONS[100];
matrix[badY][badX] = (matrix[badY][badX] + 1) & 7;
assert.throws(() => PVQR.parsePacket(PVQR.matrixToPacket(matrix)), PVQR.ProtocolError);

const cleanMatrix = PVQR.packetToMatrix(encoded[0]);
const rgba = PVQR.renderMatrixToRgba(cleanMatrix);
const sampled = PVQR.sampleMatrix(rgba);
assert.ok(sampled.minimumSeparation > 200);
equalBytes(PVQR.matrixToPacket(sampled.matrix), encoded[0]);

console.log(`ok: ${encoded.length} frames, ${PVQR.PAYLOAD_SIZE} payload bytes/frame`);
