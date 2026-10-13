"use strict";

/* ===== Tiny QR code generator (no library) =====
   Makes a QR code from any text (versions 1-10, error correction M).
   Usage:  QR.toSvg("upi://pay?pa=name@upi&am=100")  ->  SVG markup as a string. */

const QR = (function () {
  // Error-correction codewords per block, and number of blocks, for versions 1..10 (level M)
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS    = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VERSION = 10;

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function rawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(ver) {
    return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // ----- Reed-Solomon error correction -----
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    data.forEach((b) => {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  // ----- Build the data bytes (byte mode) -----
  function makeCodewords(bytes, ver) {
    const bits = [];
    const add = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };

    add(4, 4);                                   // byte mode
    add(bytes.length, ver < 10 ? 8 : 16);        // character count
    bytes.forEach((b) => add(b, 8));

    const capacityBits = dataCodewords(ver) * 8;
    add(0, Math.min(4, capacityBits - bits.length));   // terminator
    add(0, (8 - bits.length % 8) % 8);                 // pad to whole byte

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      data.push(byte);
    }
    for (let pad = 0xEC; data.length < dataCodewords(ver); pad ^= 0xEC ^ 0x11) data.push(pad);

    // Split into blocks, add error correction, then interleave
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - rawCodewords % numBlocks;
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
      });
    }
    return result;
  }

  // ----- Draw the grid -----
  function makeMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));

    let ver = 1;
    while (ver <= MAX_VERSION) {
      const needBits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (needBits <= dataCodewords(ver) * 8) break;
      ver++;
    }
    if (ver > MAX_VERSION) throw new Error("Text is too long for the QR code");

    const size = ver * 4 + 17;
    const modules = [];
    const isFn = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    function drawFormatBits(mask) {
      const data = (0 << 3) | mask;              // level M = 0
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
      setFn(8, 7, getBit(bits, 6));
      setFn(8, 8, getBit(bits, 7));
      setFn(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
      setFn(8, size - 8, true);
    }

    function drawVersion() {
      if (ver < 7) return;
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + i % 3;
        const b = Math.floor(i / 3);
        setFn(a, b, getBit(bits, i));
        setFn(b, a, getBit(bits, i));
      }
    }

    function drawFinder(cx, cy) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    }

    function drawAlignment(cx, cy) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // Function patterns
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    drawFinder(3, 3); drawFinder(size - 4, 3); drawFinder(3, size - 4);
    if (ver > 1) {
      const numAlign = Math.floor(ver / 7) + 2;
      const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
      const pos = [6];
      for (let p = size - 7; pos.length < numAlign; p -= step) pos.splice(1, 0, p);
      const last = numAlign - 1;
      for (let i = 0; i < numAlign; i++) {
        for (let j = 0; j < numAlign; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
          drawAlignment(pos[i], pos[j]);
        }
      }
    }
    drawFormatBits(0);
    drawVersion();

    // Place data bits in the zig-zag pattern
    const codewords = makeCodewords(bytes, ver);
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && bitIndex < codewords.length * 8) {
            modules[y][x] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let invert;
          switch (mask) {
            case 0: invert = (x + y) % 2 === 0; break;
            case 1: invert = y % 2 === 0; break;
            case 2: invert = x % 3 === 0; break;
            case 3: invert = (x + y) % 3 === 0; break;
            case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
            case 5: invert = x * y % 2 + x * y % 3 === 0; break;
            case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
            default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
          }
          if (!isFn[y][x] && invert) modules[y][x] = !modules[y][x];
        }
      }
    }

    // Simple penalty score: long runs, 2x2 blocks, and dark/light balance
    function penalty() {
      let score = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
          let run = 1;
          for (let b = 1; b < size; b++) {
            const cur = pass ? modules[b][a] : modules[a][b];
            const prev = pass ? modules[b - 1][a] : modules[a][b - 1];
            if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
            else run = 1;
          }
        }
      }
      let dark = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (modules[y][x]) dark++;
          if (x < size - 1 && y < size - 1) {
            const c = modules[y][x];
            if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
          }
        }
      }
      const percent = dark * 100 / (size * size);
      score += Math.floor(Math.abs(percent - 50) / 5) * 10;
      return score;
    }

    let bestMask = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      drawFormatBits(mask);
      applyMask(mask);
      const score = penalty();
      if (score < bestScore) { bestScore = score; bestMask = mask; }
      applyMask(mask);                           // undo
    }
    drawFormatBits(bestMask);
    applyMask(bestMask);
    return modules;
  }

  function toSvg(text) {
    const grid = makeMatrix(text);
    const border = 4;
    const full = grid.length + border * 2;
    let path = "";
    grid.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) path += "M" + (x + border) + "," + (y + border) + "h1v1h-1z";
      });
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + " " + full +
      '" shape-rendering="crispEdges" role="img" aria-label="UPI payment QR code">' +
      '<rect width="' + full + '" height="' + full + '" fill="#fff"/>' +
      '<path d="' + path + '" fill="#000"/></svg>';
  }

  return { matrix: makeMatrix, toSvg: toSvg };
})();

if (typeof module !== "undefined") module.exports = QR;
