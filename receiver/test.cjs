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
equalBytes(decodedFirst.payload, source.slice(0, PVQR.PAYLOAD_SIZE));

const collector = new PVQR.TransferCollector();
for (const packet of [...encoded].reverse()) {
  const decoded = PVQR.parsePacket(packet);
  collector.add(decoded);
  collector.add(decoded);
}
assert.equal(collector.complete, true);
equalBytes(collector.assemble(), source);

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
