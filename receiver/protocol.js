(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PVQR = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAGIC = [0x50, 0x56, 0x51, 0x31];
  const VERSION = 1;
  const GRID_WIDTH = 40;
  const GRID_HEIGHT = 30;
  const MODULE_SIZE = 8;
  const PACKET_SIZE = 346;
  const HEADER_SIZE = 24;
  const CRC_SIZE = 4;
  const PAYLOAD_SIZE = PACKET_SIZE - HEADER_SIZE - CRC_SIZE;
  const PACKET_BITS = PACKET_SIZE * 8;
  const WHITEN_SEED = 0xC001D00D;
  const TRANSFER_XOR = 0x50565152;
  const FLAG_LZSS = 0x01;
  const KNOWN_FLAGS = FLAG_LZSS;
  const LZSS_WINDOW_SIZE = 4096;
  const LZSS_MIN_MATCH = 3;
  const LZSS_MAX_MATCH = 18;
  const TIMING_ROW = 8;
  const TIMING_COLUMN = 8;
  const FINDERS = [[2, 2], [GRID_WIDTH - 7, 2], [2, GRID_HEIGHT - 7]];
  const PALETTE_RGB = [
    [0, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
    [0, 255, 255],
    [255, 0, 0],
    [255, 0, 255],
    [255, 255, 0],
    [255, 255, 255],
  ];

  class ProtocolError extends Error {}

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return Uint8Array.from(value);
  }

  function crc32(value) {
    const data = asBytes(value);
    let crc = 0xFFFFFFFF;
    for (const byte of data) {
      crc = (crc ^ byte) >>> 0;
      for (let bit = 0; bit < 8; bit += 1) {
        const mask = -(crc & 1);
        crc = ((crc >>> 1) ^ (0xEDB88320 & mask)) >>> 0;
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function xorshift32(state) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ ((state << 5) >>> 0)) >>> 0;
    return state >>> 0;
  }

  function whiten(value) {
    const input = asBytes(value);
    const output = new Uint8Array(input.length);
    let state = WHITEN_SEED;
    for (let index = 0; index < input.length; index += 1) {
      state = xorshift32(state);
      output[index] = input[index] ^ (state & 0xFF);
    }
    return output;
  }

  function transferIdFor(value) {
    const data = asBytes(value);
    return (crc32(data) ^ data.length ^ TRANSFER_XOR) >>> 0;
  }

  function lzssHash(input, offset) {
    return (input[offset] * 251 + input[offset + 1] * 17 + input[offset + 2])
      & (LZSS_WINDOW_SIZE - 1);
  }

  function lzssEncode(value) {
    const input = asBytes(value);
    const positions = new Int32Array(LZSS_WINDOW_SIZE);
    positions.fill(-1);
    const output = [];
    let inputOffset = 0;

    while (inputOffset < input.length) {
      const flagOffset = output.length;
      output.push(0);
      let flags = 0;

      for (let token = 0; token < 8 && inputOffset < input.length; token += 1) {
        let previous = -1;
        let matchLength = 0;
        if (inputOffset + 2 < input.length) {
          const hash = lzssHash(input, inputOffset);
          previous = positions[hash];
          positions[hash] = inputOffset;
          if (previous >= 0 && inputOffset - previous <= LZSS_WINDOW_SIZE) {
            const maximum = Math.min(LZSS_MAX_MATCH, input.length - inputOffset);
            while (matchLength < maximum
              && input[previous + matchLength] === input[inputOffset + matchLength]) {
              matchLength += 1;
            }
          }
        }

        if (matchLength >= LZSS_MIN_MATCH) {
          const encodedDistance = inputOffset - previous - 1;
          output.push(
            encodedDistance & 0xFF,
            ((matchLength - LZSS_MIN_MATCH) << 4) | (encodedDistance >>> 8),
          );
          for (let matchedOffset = 1; matchedOffset < matchLength; matchedOffset += 1) {
            const position = inputOffset + matchedOffset;
            if (position + 2 < input.length) positions[lzssHash(input, position)] = position;
          }
          inputOffset += matchLength;
        } else {
          flags |= 1 << token;
          output.push(input[inputOffset]);
          inputOffset += 1;
        }
      }
      output[flagOffset] = flags;
    }
    return Uint8Array.from(output);
  }

  function lzssDecode(value, outputSize) {
    const input = asBytes(value);
    if (!Number.isInteger(outputSize) || outputSize < 1) {
      throw new ProtocolError("invalid LZSS output size");
    }
    const output = new Uint8Array(outputSize);
    let inputOffset = 0;
    let outputOffset = 0;

    while (inputOffset < input.length && outputOffset < output.length) {
      const flags = input[inputOffset++];
      let tokens = 0;
      for (let token = 0; token < 8 && outputOffset < output.length; token += 1) {
        if (inputOffset >= input.length) break;
        tokens += 1;
        if (flags & (1 << token)) {
          output[outputOffset++] = input[inputOffset++];
        } else {
          if (inputOffset + 1 >= input.length) throw new ProtocolError("truncated LZSS match");
          const low = input[inputOffset++];
          const high = input[inputOffset++];
          const distance = (((high & 0x0F) << 8) | low) + 1;
          const length = (high >>> 4) + LZSS_MIN_MATCH;
          if (distance > outputOffset || outputOffset + length > output.length) {
            throw new ProtocolError("invalid LZSS match");
          }
          for (let index = 0; index < length; index += 1) {
            output[outputOffset] = output[outputOffset - distance];
            outputOffset += 1;
          }
        }
      }
      if (tokens === 0) throw new ProtocolError("empty LZSS flag group");
    }
    if (inputOffset !== input.length || outputOffset !== output.length) {
      throw new ProtocolError("LZSS size mismatch");
    }
    return output;
  }

  function buildPacket(payloadValue, fields) {
    const payload = asBytes(payloadValue);
    if (payload.length > PAYLOAD_SIZE) throw new ProtocolError("payload is too large");
    if (fields.chunkCount < 1 || fields.chunkCount > 0xFFFF || fields.chunkIndex >= fields.chunkCount) {
      throw new ProtocolError("invalid chunk index/count");
    }

    const raw = new Uint8Array(PACKET_SIZE);
    raw.set(MAGIC, 0);
    raw[4] = VERSION;
    raw[5] = fields.flags || 0;
    if (raw[5] & ~KNOWN_FLAGS) throw new ProtocolError("unknown transfer flags");
    const view = new DataView(raw.buffer);
    view.setUint32(6, fields.transferId >>> 0, true);
    view.setUint16(10, fields.chunkIndex, true);
    view.setUint16(12, fields.chunkCount, true);
    view.setUint32(14, fields.totalSize >>> 0, true);
    view.setUint32(18, fields.imageCrc32 >>> 0, true);
    view.setUint16(22, payload.length, true);
    raw.set(payload, HEADER_SIZE);
    view.setUint32(PACKET_SIZE - CRC_SIZE, crc32(raw.subarray(0, PACKET_SIZE - CRC_SIZE)), true);
    return whiten(raw);
  }

  function parsePacket(encodedValue) {
    const encoded = asBytes(encodedValue);
    if (encoded.length !== PACKET_SIZE) throw new ProtocolError("unexpected packet size");
    const raw = whiten(encoded);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const receivedCrc = view.getUint32(PACKET_SIZE - CRC_SIZE, true);
    const actualCrc = crc32(raw.subarray(0, PACKET_SIZE - CRC_SIZE));
    if (receivedCrc !== actualCrc) throw new ProtocolError("frame CRC32 mismatch");
    for (let index = 0; index < MAGIC.length; index += 1) {
      if (raw[index] !== MAGIC[index]) throw new ProtocolError("unknown frame magic");
    }
    if (raw[4] !== VERSION) throw new ProtocolError("unknown protocol version");
    if (raw[5] & ~KNOWN_FLAGS) throw new ProtocolError("unknown transfer flags");

    const payloadSize = view.getUint16(22, true);
    const chunkIndex = view.getUint16(10, true);
    const chunkCount = view.getUint16(12, true);
    if (payloadSize > PAYLOAD_SIZE || chunkCount < 1 || chunkIndex >= chunkCount) {
      throw new ProtocolError("invalid frame header");
    }
    return {
      flags: raw[5],
      transferId: view.getUint32(6, true),
      chunkIndex,
      chunkCount,
      totalSize: view.getUint32(14, true),
      imageCrc32: view.getUint32(18, true),
      payload: raw.slice(HEADER_SIZE, HEADER_SIZE + payloadSize),
    };
  }

  function splitTransfer(value, options = {}) {
    const data = asBytes(value);
    if (!data.length) throw new ProtocolError("cannot transfer an empty file");
    let encoded = data;
    let flags = 0;
    if (options.compress !== false) {
      const compressed = lzssEncode(data);
      if (compressed.length < data.length) {
        encoded = compressed;
        flags = FLAG_LZSS;
      }
    }
    const chunkCount = Math.ceil(encoded.length / PAYLOAD_SIZE);
    if (chunkCount > 0xFFFF) throw new ProtocolError("input is too large");
    const imageCrc32 = crc32(data);
    const transferId = transferIdFor(data);
    const output = [];
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const start = chunkIndex * PAYLOAD_SIZE;
      output.push(buildPacket(encoded.slice(start, start + PAYLOAD_SIZE), {
        transferId,
        chunkIndex,
        chunkCount,
        totalSize: data.length,
        imageCrc32,
        flags,
      }));
    }
    return output;
  }

  function inFinder(x, y) {
    return FINDERS.some(([x0, y0]) => x >= x0 && x < x0 + 5 && y >= y0 && y < y0 + 5);
  }

  function isReserved(x, y) {
    return x === 0 || y === 0 || x === GRID_WIDTH - 1 || y === GRID_HEIGHT - 1
      || inFinder(x, y) || y === TIMING_ROW || x === TIMING_COLUMN;
  }

  function newMatrix() {
    return Array.from({ length: GRID_HEIGHT }, () => new Uint8Array(GRID_WIDTH));
  }

  function drawFinder(matrix, x0, y0) {
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const edge = x === 0 || x === 4 || y === 0 || y === 4;
        const center = x === 2 && y === 2;
        matrix[y0 + y][x0 + x] = edge || center ? 0 : 7;
      }
    }
  }

  function referenceMatrix() {
    const matrix = newMatrix();
    for (const [x, y] of FINDERS) drawFinder(matrix, x, y);
    for (let x = 1; x < GRID_WIDTH - 1; x += 1) matrix[TIMING_ROW][x] = x & 7;
    for (let y = 1; y < GRID_HEIGHT - 1; y += 1) matrix[y][TIMING_COLUMN] = y & 7;
    return matrix;
  }

  const DATA_POSITIONS = [];
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!isReserved(x, y)) DATA_POSITIONS.push([x, y]);
    }
  }
  if (DATA_POSITIONS.length * 3 < PACKET_BITS) throw new Error("grid capacity is too small");

  function packetToMatrix(packetValue) {
    const packet = asBytes(packetValue);
    if (packet.length !== PACKET_SIZE) throw new ProtocolError("unexpected packet size");
    const matrix = referenceMatrix();
    let bitIndex = 0;
    for (const [x, y] of DATA_POSITIONS) {
      let symbol = 0;
      for (let component = 0; component < 3; component += 1) {
        let bit;
        if (bitIndex < PACKET_BITS) {
          bit = (packet[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
        } else {
          bit = (bitIndex - PACKET_BITS) & 1;
        }
        symbol = (symbol << 1) | bit;
        bitIndex += 1;
      }
      matrix[y][x] = symbol;
    }
    return matrix;
  }

  function matrixToPacket(matrix) {
    if (!Array.isArray(matrix) || matrix.length !== GRID_HEIGHT) {
      throw new ProtocolError("unexpected matrix height");
    }
    const packet = new Uint8Array(PACKET_SIZE);
    let bitIndex = 0;
    for (const [x, y] of DATA_POSITIONS) {
      const symbol = matrix[y][x] & 7;
      for (let component = 2; component >= 0 && bitIndex < PACKET_BITS; component -= 1) {
        const bit = (symbol >>> component) & 1;
        packet[bitIndex >>> 3] |= bit << (7 - (bitIndex & 7));
        bitIndex += 1;
      }
      if (bitIndex >= PACKET_BITS) break;
    }
    return packet;
  }

  function solveLinear(rows, values) {
    const size = values.length;
    const augmented = rows.map((row, index) => [...row, values[index]]);
    for (let column = 0; column < size; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < size; row += 1) {
        if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if (Math.abs(augmented[pivot][column]) < 1e-10) throw new ProtocolError("invalid corner geometry");
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      const divisor = augmented[column][column];
      for (let item = column; item <= size; item += 1) augmented[column][item] /= divisor;
      for (let row = 0; row < size; row += 1) {
        if (row === column) continue;
        const factor = augmented[row][column];
        for (let item = column; item <= size; item += 1) {
          augmented[row][item] -= factor * augmented[column][item];
        }
      }
    }
    return augmented.map((row) => row[size]);
  }

  function homography(source, destination) {
    const rows = [];
    const values = [];
    for (let index = 0; index < 4; index += 1) {
      const [x, y] = source[index];
      const [u, v] = destination[index];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      values.push(u);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      values.push(v);
    }
    const h = solveLinear(rows, values);
    return [...h, 1];
  }

  function mapPoint(h, x, y) {
    const scale = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / scale, (h[3] * x + h[4] * y + h[5]) / scale];
  }

  function pixelRgb(imageData, x, y) {
    const width = imageData.width;
    const height = imageData.height;
    x = Math.max(0, Math.min(width - 1.001, x));
    y = Math.max(0, Math.min(height - 1.001, y));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const fx = x - x0;
    const fy = y - y0;
    const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
    const offsets = [(y0 * width + x0) * 4, (y0 * width + x1) * 4, (y1 * width + x0) * 4, (y1 * width + x1) * 4];
    const rgb = [0, 0, 0];
    for (let sample = 0; sample < 4; sample += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[channel] += imageData.data[offsets[sample] + channel] * weights[sample];
      }
    }
    return rgb;
  }

  function finderScore(imageData, transform, origin, shiftX, shiftY) {
    let blackSum = 0;
    let blackSquareSum = 0;
    let blackCount = 0;
    let whiteSum = 0;
    let whiteSquareSum = 0;
    let whiteCount = 0;
    const offsets = [-0.38, 0, 0.38];

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const black = x === 0 || x === 4 || y === 0 || y === 4 || (x === 2 && y === 2);
        for (const offsetY of offsets) {
          for (const offsetX of offsets) {
            const [px, py] = mapPoint(
              transform,
              (origin[0] + x + 0.5 + offsetX) * MODULE_SIZE,
              (origin[1] + y + 0.5 + offsetY) * MODULE_SIZE,
            );
            const rgb = pixelRgb(imageData, px + shiftX, py + shiftY);
            const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
            if (black) {
              blackSum += luma;
              blackSquareSum += luma * luma;
              blackCount += 1;
            } else {
              whiteSum += luma;
              whiteSquareSum += luma * luma;
              whiteCount += 1;
            }
          }
        }
      }
    }

    const blackMean = blackSum / blackCount;
    const whiteMean = whiteSum / whiteCount;
    const contrast = whiteMean - blackMean;
    const blackVariance = Math.max(0, blackSquareSum / blackCount - blackMean * blackMean);
    const whiteVariance = Math.max(0, whiteSquareSum / whiteCount - whiteMean * whiteMean);
    const noise = Math.sqrt((blackVariance + whiteVariance) / 2);
    return { score: contrast / (noise + 8), contrast };
  }

  function findMarker(imageData, transform, origin, options) {
    const centerX = (origin[0] + 2.5) * MODULE_SIZE;
    const centerY = (origin[1] + 2.5) * MODULE_SIZE;
    const predicted = mapPoint(transform, centerX, centerY);
    const xNeighbor = mapPoint(transform, centerX + MODULE_SIZE, centerY);
    const yNeighbor = mapPoint(transform, centerX, centerY + MODULE_SIZE);
    const basisX = [xNeighbor[0] - predicted[0], xNeighbor[1] - predicted[1]];
    const basisY = [yNeighbor[0] - predicted[0], yNeighbor[1] - predicted[1]];
    const radius = options.searchRadiusCells;
    const coarseStep = 0.25;
    let best = { score: -Infinity, contrast: -Infinity, dx: 0, dy: 0 };

    function evaluate(dx, dy) {
      const shiftX = dx * basisX[0] + dy * basisY[0];
      const shiftY = dx * basisX[1] + dy * basisY[1];
      const result = finderScore(imageData, transform, origin, shiftX, shiftY);
      if (result.score > best.score) best = { ...result, dx, dy, shiftX, shiftY };
    }

    const coarseCount = Math.ceil(radius / coarseStep);
    for (let y = -coarseCount; y <= coarseCount; y += 1) {
      for (let x = -coarseCount; x <= coarseCount; x += 1) {
        const dx = x * coarseStep;
        const dy = y * coarseStep;
        if (Math.abs(dx) <= radius && Math.abs(dy) <= radius) evaluate(dx, dy);
      }
    }

    const coarseBest = best;
    const fineStep = coarseStep / 4;
    for (let y = -4; y <= 4; y += 1) {
      for (let x = -4; x <= 4; x += 1) {
        const dx = coarseBest.dx + x * fineStep;
        const dy = coarseBest.dy + y * fineStep;
        if (Math.abs(dx) <= radius && Math.abs(dy) <= radius) evaluate(dx, dy);
      }
    }

    if (best.contrast < options.minimumContrast || best.score < options.minimumScore) {
      throw new ProtocolError("finder tracking failed");
    }
    return {
      predicted,
      observed: [predicted[0] + best.shiftX, predicted[1] + best.shiftY],
      score: best.score,
      contrast: best.contrast,
    };
  }

  function affineTransform(source, destination) {
    const rows = [];
    const values = [];
    for (let index = 0; index < 3; index += 1) {
      const [x, y] = source[index];
      const [u, v] = destination[index];
      rows.push([x, y, 1, 0, 0, 0]);
      values.push(u);
      rows.push([0, 0, 0, x, y, 1]);
      values.push(v);
    }
    return solveLinear(rows, values);
  }

  function mapAffine(transform, point) {
    return [
      transform[0] * point[0] + transform[1] * point[1] + transform[2],
      transform[3] * point[0] + transform[4] * point[1] + transform[5],
    ];
  }

  function trackCorners(imageData, suppliedCorners, suppliedOptions = {}) {
    if (!Array.isArray(suppliedCorners) || suppliedCorners.length !== 4) {
      throw new ProtocolError("four corners are required for tracking");
    }
    const options = {
      searchRadiusCells: Math.max(0.5, Math.min(4, suppliedOptions.searchRadiusCells ?? 1.25)),
      minimumContrast: suppliedOptions.minimumContrast ?? 35,
      minimumScore: suppliedOptions.minimumScore ?? 1.4,
      smoothing: Math.max(0, Math.min(1, suppliedOptions.smoothing ?? 0.75)),
    };
    const sourceCorners = [[0, 0], [320, 0], [320, 240], [0, 240]];
    const transform = homography(sourceCorners, suppliedCorners);
    const markers = FINDERS.map((origin) => findMarker(imageData, transform, origin, options));
    const correction = affineTransform(
      markers.map((marker) => marker.predicted),
      markers.map((marker) => marker.observed),
    );
    const corrected = suppliedCorners.map((corner) => mapAffine(correction, corner));
    const corners = suppliedCorners.map((corner, index) => [
      corner[0] + (corrected[index][0] - corner[0]) * options.smoothing,
      corner[1] + (corrected[index][1] - corner[1]) * options.smoothing,
    ]);
    return {
      corners,
      markers,
      minimumContrast: Math.min(...markers.map((marker) => marker.contrast)),
      minimumScore: Math.min(...markers.map((marker) => marker.score)),
    };
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length & 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function sampleMatrix(imageData, suppliedCorners) {
    const corners = suppliedCorners || [
      [0, 0],
      [imageData.width - 1, 0],
      [imageData.width - 1, imageData.height - 1],
      [0, imageData.height - 1],
    ];
    if (corners.length !== 4) throw new ProtocolError("four corners are required");
    const source = [[0, 0], [320, 0], [320, 240], [0, 240]];
    const transform = homography(source, corners);
    const samples = Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH));
    const offsets = [-0.18, 0, 0.18];

    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        const total = [0, 0, 0];
        let count = 0;
        for (const dy of offsets) {
          for (const dx of offsets) {
            const [px, py] = mapPoint(transform, (x + 0.5 + dx) * MODULE_SIZE, (y + 0.5 + dy) * MODULE_SIZE);
            const rgb = pixelRgb(imageData, px, py);
            for (let channel = 0; channel < 3; channel += 1) total[channel] += rgb[channel];
            count += 1;
          }
        }
        samples[y][x] = total.map((value) => value / count);
      }
    }

    const buckets = Array.from({ length: 8 }, () => []);
    for (let x = 1; x < GRID_WIDTH - 1; x += 1) buckets[x & 7].push(samples[TIMING_ROW][x]);
    for (let y = 1; y < GRID_HEIGHT - 1; y += 1) buckets[y & 7].push(samples[y][TIMING_COLUMN]);
    const palette = buckets.map((bucket) => [0, 1, 2].map((channel) => median(bucket.map((rgb) => rgb[channel]))));

    let minimumSeparation = Infinity;
    for (let left = 0; left < palette.length; left += 1) {
      for (let right = left + 1; right < palette.length; right += 1) {
        const distance = palette[left].reduce((sum, value, channel) => sum + (value - palette[right][channel]) ** 2, 0);
        minimumSeparation = Math.min(minimumSeparation, Math.sqrt(distance));
      }
    }
    if (minimumSeparation < 35) throw new ProtocolError("color palette is not separated enough");

    const matrix = newMatrix();
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        let best = 0;
        let bestDistance = Infinity;
        for (let color = 0; color < palette.length; color += 1) {
          const distance = samples[y][x].reduce((sum, value, channel) => sum + (value - palette[color][channel]) ** 2, 0);
          if (distance < bestDistance) {
            best = color;
            bestDistance = distance;
          }
        }
        matrix[y][x] = best;
      }
    }
    return { matrix, palette, minimumSeparation };
  }

  function renderMatrixToRgba(matrix, scale = MODULE_SIZE) {
    const width = GRID_WIDTH * scale;
    const height = GRID_HEIGHT * scale;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const color = PALETTE_RGB[matrix[Math.floor(y / scale)][Math.floor(x / scale)] & 7];
        const offset = (y * width + x) * 4;
        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = 255;
      }
    }
    return { width, height, data };
  }

  class TransferCollector {
    constructor() {
      this.identity = null;
      this.chunks = new Map();
    }

    get expected() { return this.identity ? this.identity.chunkCount : 0; }
    get received() { return this.chunks.size; }
    get complete() { return this.expected > 0 && this.received === this.expected; }
    get compressed() { return Boolean(this.identity && (this.identity.flags & FLAG_LZSS)); }

    add(packet) {
      const identity = {
        flags: packet.flags,
        transferId: packet.transferId,
        chunkCount: packet.chunkCount,
        totalSize: packet.totalSize,
        imageCrc32: packet.imageCrc32,
      };
      if (!this.identity) {
        this.identity = identity;
      } else if (Object.keys(identity).some((key) => identity[key] !== this.identity[key])) {
        return false;
      }
      const previous = this.chunks.get(packet.chunkIndex);
      if (previous && (previous.length !== packet.payload.length || previous.some((byte, index) => byte !== packet.payload[index]))) {
        throw new ProtocolError("conflicting duplicate chunk");
      }
      this.chunks.set(packet.chunkIndex, packet.payload);
      return !previous;
    }

    missing(limit = 12) {
      const output = [];
      for (let index = 0; index < this.expected && output.length < limit; index += 1) {
        if (!this.chunks.has(index)) output.push(index);
      }
      return output;
    }

    assemble() {
      if (!this.complete) throw new ProtocolError("transfer is incomplete");
      const encodedSize = [...this.chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);
      const encoded = new Uint8Array(encodedSize);
      let offset = 0;
      for (let index = 0; index < this.expected; index += 1) {
        const chunk = this.chunks.get(index);
        encoded.set(chunk, offset);
        offset += chunk.length;
      }
      const output = this.identity.flags & FLAG_LZSS
        ? lzssDecode(encoded, this.identity.totalSize)
        : encoded;
      if (output.length !== this.identity.totalSize || crc32(output) !== this.identity.imageCrc32) {
        throw new ProtocolError("whole-image CRC32 mismatch");
      }
      return output;
    }
  }

  return {
    ProtocolError,
    GRID_WIDTH,
    GRID_HEIGHT,
    MODULE_SIZE,
    PACKET_SIZE,
    PAYLOAD_SIZE,
    FLAG_LZSS,
    PALETTE_RGB,
    DATA_POSITIONS,
    crc32,
    lzssEncode,
    lzssDecode,
    whiten,
    buildPacket,
    parsePacket,
    splitTransfer,
    packetToMatrix,
    matrixToPacket,
    trackCorners,
    sampleMatrix,
    renderMatrixToRgba,
    TransferCollector,
  };
});
