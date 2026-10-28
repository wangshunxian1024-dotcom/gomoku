/*
 * harness.js — jsc 自测公共工具（仅供测试使用，不属于引擎）
 *
 * 用法（工作目录必须是 gomoku/）：
 *   load('test/ai/harness.js');
 *   var T = GomokuTest;     // 自动 load js/core.js + js/ai.js
 *
 * 约定：本文件只依赖 jsc 的 load()/print()，不依赖 node/require。
 */
var GomokuTest = (function () {
  'use strict';

  /* ---------- 加载被测代码 ---------- */
  function loadScript(path) {
    // jsc 提供全局 load()；浏览器/其他环境没有就直接跳过
    if (typeof load === 'function') load(path);
  }

  if (typeof GomokuCore === 'undefined') loadScript('js/core.js');
  if (typeof GomokuAI === 'undefined') loadScript('js/ai.js');

  var C = (typeof GomokuCore !== 'undefined') ? GomokuCore : null;
  var AI = (typeof GomokuAI !== 'undefined') ? GomokuAI : null;
  if (!C) throw new Error('GomokuCore 未加载：请在 gomoku/ 目录下运行 jsc test/ai/test.js');
  if (!AI) throw new Error('GomokuAI 未加载：js/ai.js 语法错误或未挂到全局');

  var SIZE = C.SIZE;
  var N = C.N;

  /* ---------- 基础坐标工具 ---------- */
  function idx(x, y) { return y * SIZE + x; }

  /** 简单确定性伪随机（harness 内部用，不参与引擎决策） */
  function lcg(a) {
    return function () {
      a = (Math.imul(a, 1664525) + 1013904223) | 0;
      return ((a >>> 0) / 4294967296);
    };
  }
  function nm(i) { return C.coordName(i % SIZE, (i / SIZE) | 0); }
  function nmOf(mv) { return C.coordName(mv.x, mv.y); }
  function xy(i) { return { x: i % SIZE, y: (i / SIZE) | 0 }; }

  /** stones: [[x, y, value], ...] */
  function mkBoard(stones) {
    var b = C.createBoard();
    for (var i = 0; i < stones.length; i++) {
      var s = stones[i];
      b[idx(s[0], s[1])] = s[2];
    }
    return b;
  }

  function stonesOf(board) {
    var out = [];
    for (var i = 0; i < N; i++) {
      if (board[i] !== 0) out.push([i % SIZE, (i / SIZE) | 0, board[i]]);
    }
    return out;
  }

  function countStones(board) { return C.countStones(board); }

  /* ---------- 断言/统计 ---------- */
  var passed = 0;
  var failed = 0;
  var failures = [];

  function ok(cond, msg, extra) {
    if (cond) {
      passed++;
      return true;
    }
    failed++;
    failures.push(msg + (extra === undefined ? '' : '  [' + extra + ']'));
    print('  ✗ FAIL: ' + msg + (extra === undefined ? '' : '  [' + extra + ']'));
    return false;
  }

  function section(title) {
    print('');
    print('▌ ' + title);
  }

  function summary(title) {
    print('');
    print('────────────────────────────────────────');
    print(title + '：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    if (failed > 0) {
      print('失败明细：');
      for (var i = 0; i < failures.length; i++) print('  - ' + failures[i]);
    }
    return failed;
  }

  /* ---------- 走子 ---------- */
  function pickMove(level, board, player, extra) {
    var opts = { seed: 20240521 };
    if (extra && extra.seed !== undefined) opts.seed = extra.seed;
    if (extra && extra.timeBudgetMs !== undefined) opts.timeBudgetMs = extra.timeBudgetMs;
    var ai = AI.create(level, opts);
    var ctx = { moveCount: countStones(board) };
    if (extra && extra.timeBudgetMs !== undefined) ctx.timeBudgetMs = extra.timeBudgetMs;
    return { ai: ai, mv: ai.chooseMove(board, player, ctx) };
  }

  /** 单步：返回 {mv, ms} */
  function timeMove(ai, board, player, extraCtx) {
    var ctx = { moveCount: countStones(board) };
    if (extraCtx) {
      if (extraCtx.timeBudgetMs !== undefined) ctx.timeBudgetMs = extraCtx.timeBudgetMs;
    }
    var t0 = Date.now();
    var mv = ai.chooseMove(board, player, ctx);
    return { mv: mv, ms: Date.now() - t0 };
  }

  /* ---------- 对局 ---------- */
  /**
   * 一场对局：keyA 执黑先手，keyB 执白后手。
   * 返回 { winner:'A'|'B'|'draw', moves, illegal, maxMs, sumMs, maxMsA, maxMsB, record }
   */
  function playGame(keyA, keyB, seed, budgetA, budgetB, opts) {
    var b = C.createBoard();
    var a = AI.create(keyA, { seed: seed, timeBudgetMs: budgetA });
    var w = AI.create(keyB, { seed: (seed + 7919) >>> 0, timeBudgetMs: budgetB });
    var byColor = {};
    byColor[1] = { ai: a, tag: 'A' };
    byColor[2] = { ai: w, tag: 'B' };

    var p = 1;
    var moves = 0;
    var maxMs = 0, sumMs = 0, maxMsA = 0, maxMsB = 0;
    var record = [];
    var recordMs = [];
    var maxMoves = (opts && opts.maxMoves) ? opts.maxMoves : N;

    // 可选：开局前 k 手随机落在中心 7x7，用来给“完全确定性的强档”制造不同开局，
    // 否则同色对局会退化成同一盘棋重复 N 次，样本没有意义。
    if (opts && opts.openRandom > 0) {
      var oRnd = lcg((seed ^ 0x9e3779b9) >>> 0);
      var kOpen = opts.openRandom | 0;
      for (var q = 0; q < kOpen && moves < maxMoves; q++) {
        var guard = 0;
        while (guard++ < 400) {
          var ox = 4 + ((oRnd() * 7) | 0);
          var oy = 4 + ((oRnd() * 7) | 0);
          var oi = idx(ox, oy);
          if (b[oi] !== 0) continue;
          b[oi] = p;
          record.push(oi);
          recordMs.push(0);
          moves++;
          if (C.checkWin(b, ox, oy)) {
            return {
              winner: (p === 1 ? 'A' : 'B'), moves: moves, illegal: false,
              maxMs: 0, sumMs: 0, maxMsA: 0, maxMsB: 0,
              record: record, recordMs: recordMs
            };
          }
          p = 3 - p;
          break;
        }
      }
    }

    while (moves < maxMoves) {
      var side = byColor[p];
      var t0 = Date.now();
      var mv = side.ai.chooseMove(b, p, { moveCount: moves });
      var dt = Date.now() - t0;
      if (dt > maxMs) maxMs = dt;
      if (side.tag === 'A') { if (dt > maxMsA) maxMsA = dt; }
      else { if (dt > maxMsB) maxMsB = dt; }
      sumMs += dt;

      if (!mv) break;
      var i = idx(mv.x, mv.y);
      if (!(mv.x >= 0 && mv.x < SIZE && mv.y >= 0 && mv.y < SIZE) || b[i] !== 0) {
        return {
          winner: 'illegal', moves: moves, illegal: true, maxMs: maxMs, sumMs: sumMs,
          maxMsA: maxMsA, maxMsB: maxMsB, record: record, recordMs: recordMs,
          badMove: mv
        };
      }
      b[i] = p;
      record.push(i);
      recordMs.push(dt);
      moves++;
      var win = C.checkWin(b, mv.x, mv.y);
      if (win) {
        return {
          winner: (p === 1 ? 'A' : 'B'), moves: moves, illegal: false,
          maxMs: maxMs, sumMs: sumMs, maxMsA: maxMsA, maxMsB: maxMsB,
          record: record, recordMs: recordMs
        };
      }
      p = 3 - p;
    }
    return {
      winner: 'draw', moves: moves, illegal: false, maxMs: maxMs, sumMs: sumMs,
      maxMsA: maxMsA, maxMsB: maxMsB, record: record, recordMs: recordMs
    };
  }

  /**
   * 多项对局：交替先后手，返回 A 视角的统计。
   * 偶数局 A 执黑，奇数局 B 执黑。
   */
  function match(keyA, keyB, games, budgetA, budgetB, seedBase) {
    var aWin = 0, bWin = 0, draw = 0, illegal = 0;
    var maxMs = 0, sumMs = 0, totalMoves = 0;
    var base = seedBase === undefined ? 1000 : seedBase;
    for (var g = 0; g < games; g++) {
      var r;
      var seed = (base + g * 17) >>> 0;
      if (g % 2 === 0) {
        r = playGame(keyA, keyB, seed, budgetA, budgetB);
      } else {
        r = playGame(keyB, keyA, (seed + 500000) >>> 0, budgetB, budgetA);
        // 交换标签：B 执黑
        if (r.winner === 'A') r.winner = 'B';
        else if (r.winner === 'B') r.winner = 'A';
      }
      if (r.illegal) illegal++;
      if (r.maxMs > maxMs) maxMs = r.maxMs;
      sumMs += r.sumMs;
      totalMoves += r.moves;
      if (r.winner === 'draw') draw++;
      else if (r.winner === 'A') aWin++;
      else if (r.winner === 'B') bWin++;
    }
    return {
      keyA: keyA, keyB: keyB, games: games,
      aWin: aWin, bWin: bWin, draw: draw, illegal: illegal,
      avgMs: Math.round(sumMs / Math.max(1, totalMoves)),
      maxMs: maxMs,
      avgMoves: Math.round(totalMoves / games)
    };
  }

  /* ---------- 耗时统计 ---------- */
  function percentile(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice(0).sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  function stats(arr) {
    if (!arr.length) return { n: 0, p50: 0, p95: 0, max: 0, avg: 0 };
    var sum = 0, max = 0;
    for (var i = 0; i < arr.length; i++) { sum += arr[i]; if (arr[i] > max) max = arr[i]; }
    return {
      n: arr.length,
      p50: Math.round(percentile(arr, 0.5)),
      p95: Math.round(percentile(arr, 0.95)),
      max: Math.round(max),
      avg: Math.round(sum / arr.length)
    };
  }

  /* ---------- 复用：生成一局真实中局棋盘 ---------- */
  /**
   * 用指定两档自对弈到 targetMoves 手，返回 {board, player, moveCount}。
   * 用于性能测试构造“真实中局”。
   */
  function midgamePosition(keyA, keyB, targetMoves, seed, budgetA, budgetB) {
    var b = C.createBoard();
    var a = AI.create(keyA, { seed: seed, timeBudgetMs: budgetA });
    var w = AI.create(keyB, { seed: (seed + 7919) >>> 0, timeBudgetMs: budgetB });
    var byColor = {};
    byColor[1] = a;
    byColor[2] = w;
    var p = 1, moves = 0;
    while (moves < targetMoves) {
      var mv = byColor[p].chooseMove(b, p, { moveCount: moves });
      if (!mv) break;
      var i = idx(mv.x, mv.y);
      if (b[i] !== 0) break;
      b[i] = p;
      moves++;
      if (C.checkWin(b, mv.x, mv.y)) return null; // 提前分出胜负，换一局
      p = 3 - p;
    }
    if (moves < targetMoves) return null;
    return { board: b, player: p, moveCount: moves };
  }

  /**
   * 合成中局：先真实走 baseMoves 手，再随机补子到 targetStones 手。
   * 补子时不允许形成五（否则局面已终局），最终要求局面"不烫手"
   * （双方都没有一步成五的点），这样测出来的是真实搜索耗时而不是秒杀。
   */
  function syntheticMidgame(baseMoves, targetStones, seed) {
    var pos = midgamePosition('normal', 'easy', baseMoves, seed, 120, 120);
    if (!pos) return null;
    var b = pos.board;
    var p = pos.player;
    var count = pos.moveCount;
    var state = (seed * 2654435761) >>> 0;
    function rnd() {
      state = (state + 0x6d2b79f5) | 0;
      var t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var guard = 0;
    while (count < targetStones && guard++ < 8000) {
      var i = (rnd() * N) | 0;
      if (b[i] !== 0) continue;
      b[i] = p;
      var win = C.checkWin(b, i % SIZE, (i / SIZE) | 0);
      if (win) { b[i] = 0; continue; }
      count++;
      p = 3 - p;
    }
    if (count < targetStones) return null;

    // 烫手检测：任一方有"一步成五"就作废
    for (var q = 0; q < N; q++) {
      if (b[q] !== 0) continue;
      var x = q % SIZE, y = (q / SIZE) | 0;
      b[q] = 1;
      var w1 = C.checkWin(b, x, y);
      b[q] = 0;
      if (w1) return null;
      b[q] = 2;
      var w2 = C.checkWin(b, x, y);
      b[q] = 0;
      if (w2) return null;
    }
    return { board: b, player: p, moveCount: count };
  }

  return {
    C: C,
    AI: AI,
    SIZE: SIZE,
    N: N,
    idx: idx,
    nm: nm,
    nmOf: nmOf,
    xy: xy,
    mkBoard: mkBoard,
    stonesOf: stonesOf,
    countStones: countStones,
    ok: ok,
    section: section,
    summary: summary,
    pickMove: pickMove,
    timeMove: timeMove,
    playGame: playGame,
    match: match,
    percentile: percentile,
    stats: stats,
    midgamePosition: midgamePosition,
    syntheticMidgame: syntheticMidgame,
    results: function () { return { passed: passed, failed: failed, failures: failures.slice(0) }; }
  };
})();
