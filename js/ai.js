/*!
 * ai.js — 五子棋 AI 引擎（纯浏览器经典脚本，无依赖、无网络、无 DOM）
 *
 * 设计目标
 *   - 完全同步、纯函数式对外接口：GomokuAI.create(difficultyKey, options)
 *   - 五档难度有清晰实力梯度：入口随机 → 静态评估 → Alpha-Beta → VCF 算杀
 *   - 确定性：同种子 + 同局面 + 同参数 ⇒ 同落子（内部不用 Math.random）
 *   - 合法性：任何局面都只返回棋盘内的空点
 *
 * 坐标/棋盘约定与 js/core.js 保持一致（若 GomokuCore 已加载则优先复用其常量）：
 *   - 15x15，Uint8Array(225)，index = y*15 + x
 *   - 0 = 空，1 = 黑（先手），2 = 白（后手）
 *
 * 对外 API
 *   GomokuAI.VERSION
 *   GomokuAI.DIFFICULTIES  // 五档中文文案，供 UI 渲染
 *   GomokuAI.create(difficultyKey, { seed, timeBudgetMs }) -> instance
 *   instance.chooseMove(board, player, { moveCount, timeBudgetMs }) -> { x, y, ... } | null
 *   instance.reset(seed)
 */
(function (global) {
  'use strict';

  /* ================================================================== *
   * 0. 基础常量（若 core.js 已加载则完全复用，否则使用内置 fallback）
   * ================================================================== */

  var CORE = global && global.GomokuCore ? global.GomokuCore : null;

  var SIZE = CORE && CORE.SIZE ? CORE.SIZE : 15;
  var N = SIZE * SIZE;
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;
  var DIRS = (CORE && CORE.DIRS) ? CORE.DIRS : [[1, 0], [0, 1], [1, 1], [1, -1]];

  var VERSION = '1.0.0';
  var DEFAULT_SEED = 20240521;

  /** 评估权重（数值仅需保持相对关系，方便调参） */
  var SC_FIVE = 10000000;
  var SC_OPEN_FOUR = 1000000;
  var SC_FOUR = 100000;
  var SC_OPEN_THREE = 12000;
  var SC_THREE = 1500;
  var SC_OPEN_TWO = 200;
  var SC_TWO = 40;
  var SC_OPEN_ONE = 5;
  var SC_ONE = 1;

  var WIN_SCORE = 100000000;
  var INF = 1e15;
  /** 防守权重：不低于进攻（略偏防守，避免被双威胁速杀） */
  var DEF_WEIGHT = 1.06;

  /** 方向线窗口里“连续/成型”长度的粗排序分（用于候选点预筛） */
  var RUN_SCORE = [0, 1, 4, 20, 120, 50000];

  /* ================================================================== *
   * 1. 预计算表：方向线、邻域、Zobrist、九格模式评分表
   * ================================================================== */

  var LINE_COUNT = 0;
  var LINE_CELLS = null;   // Int16Array，所有方向线的格子按线拼接
  var LINE_START = null;   // Int16Array(LINE_COUNT+1)
  var LINE_LEN = null;     // Int16Array(LINE_COUNT)
  var CELL_LINES = null;   // Int16Array(N*4)，每个格子四个方向的线 id（-1 = 该线不足 5 格）
  var NEIGH9 = null;       // Int16Array(N*4*9)，九格窗口的格子下标，-1 = 出界
  var NEAR_IDX = null;     // Int16Array(N*24)，切比雪夫距离 <= 2 的邻格（不含自身）
  var RING8 = null;        // Int16Array(N*8)，八邻域
  var ZOB1 = null;         // Int32Array(N*2)，Zobrist 哈希
  var ZOB2 = null;

  var DIR_SCORE = null;    // Float64Array(3^9)，某方向九格窗口（中心为我方子）的模式分
  var DIR_FLAG = null;     // Uint8Array(3^9)，bit0 成五 / bit1 活四 / bit2 冲四 / bit3 活三

  var _five = false;       // quickScan 输出：该点落子能否成五
  var _sc = 0, _f4 = 0, _of4 = 0, _ot3 = 0; // scoreBuf 输出

  var _pmScore = 0, _poScore = 0;
  var _pmFive = 0, _pmFour = 0, _pmOpenThree = 0;
  var _poFive = 0, _poFour = 0, _poOpenThree = 0;

  function buildLineTables() {
    var lines = [];
    var x, y, k, cells;

    // 横（dir 0）
    for (y = 0; y < SIZE; y++) {
      cells = [];
      for (x = 0; x < SIZE; x++) cells.push(y * SIZE + x);
      lines.push({ cells: cells, dir: 0 });
    }
    // 竖（dir 1）
    for (x = 0; x < SIZE; x++) {
      cells = [];
      for (y = 0; y < SIZE; y++) cells.push(y * SIZE + x);
      lines.push({ cells: cells, dir: 1 });
    }
    // 主对角 x - y = cd（dir 2）
    for (var cd = -(SIZE - 1); cd <= SIZE - 1; cd++) {
      cells = [];
      for (x = 0; x < SIZE; x++) {
        y = x - cd;
        if (y >= 0 && y < SIZE) cells.push(y * SIZE + x);
      }
      if (cells.length >= 5) lines.push({ cells: cells, dir: 2 });
    }
    // 副对角 x + y = cs（dir 3）
    for (var cs = 0; cs <= 2 * (SIZE - 1); cs++) {
      cells = [];
      for (x = 0; x < SIZE; x++) {
        y = cs - x;
        if (y >= 0 && y < SIZE) cells.push(y * SIZE + x);
      }
      if (cells.length >= 5) lines.push({ cells: cells, dir: 3 });
    }

    LINE_COUNT = lines.length;
    LINE_START = new Int16Array(LINE_COUNT + 1);
    LINE_LEN = new Int16Array(LINE_COUNT);
    CELL_LINES = new Int16Array(N * 4);
    for (k = 0; k < N * 4; k++) CELL_LINES[k] = -1;

    var total = 0;
    for (var i = 0; i < LINE_COUNT; i++) {
      LINE_START[i] = total;
      LINE_LEN[i] = lines[i].cells.length;
      total += lines[i].cells.length;
    }
    LINE_START[LINE_COUNT] = total;
    LINE_CELLS = new Int16Array(total);

    for (i = 0; i < LINE_COUNT; i++) {
      var line = lines[i];
      var start = LINE_START[i];
      for (k = 0; k < line.cells.length; k++) {
        var cell = line.cells[k];
        LINE_CELLS[start + k] = cell;
        CELL_LINES[cell * 4 + line.dir] = i;
      }
    }
  }

  function buildNeighborhoods() {
    NEIGH9 = new Int16Array(N * 36);
    NEAR_IDX = new Int16Array(N * 24);
    RING8 = new Int16Array(N * 8);

    for (var i = 0; i < N; i++) {
      var x = i % SIZE;
      var y = (i - x) / SIZE;
      var base36 = i * 36;
      var d, k, dx, dy, nx, ny, j;

      for (d = 0; d < 4; d++) {
        dx = DIRS[d][0];
        dy = DIRS[d][1];
        for (k = -4; k <= 4; k++) {
          nx = x + dx * k;
          ny = y + dy * k;
          var valid = nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE;
          NEIGH9[base36 + d * 9 + (k + 4)] = valid ? ny * SIZE + nx : -1;
        }
      }

      var base24 = i * 24;
      var cnt = 0;
      for (dy = -2; dy <= 2; dy++) {
        for (dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) continue;
          nx = x + dx;
          ny = y + dy;
          var ok = nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE;
          NEAR_IDX[base24 + cnt] = ok ? ny * SIZE + nx : -1;
          cnt++;
        }
      }

      var base8 = i * 8;
      var c8 = 0;
      for (dy = -1; dy <= 1; dy++) {
        for (dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          nx = x + dx;
          ny = y + dy;
          var ok8 = nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE;
          RING8[base8 + c8] = ok8 ? ny * SIZE + nx : -1;
          c8++;
        }
      }
    }
  }

  function buildZobrist() {
    ZOB1 = new Int32Array(N * 2);
    ZOB2 = new Int32Array(N * 2);
    var rnd = mulberry32(0x9e3779b9);
    for (var i = 0; i < N * 2; i++) {
      var a = (rnd() * 4294967296) | 0;
      var b = (rnd() * 4294967296) | 0;
      if (a === 0) a = 0x1234567;
      if (b === 0) b = 0x7654321;
      ZOB1[i] = a;
      ZOB2[i] = b;
    }
  }

  /**
   * 预计算“九格窗口中心落我子”的模式评分表。
   * 中心固定为 1，其余 8 格取 0/1/2（2 表示对手或棋盘外）。
   * 九格窗口内所有长度 5 的窗口都包含中心，因此表中的“四/活三”都是指
   * 由中心这一手新形成的棋型，不含与中心无关的既有棋型。
   */
  function buildDirTable() {
    DIR_SCORE = new Float64Array(19683);
    DIR_FLAG = new Uint8Array(19683);
    var d = new Uint8Array(9);
    var code, k, s, j, ones, twos, lo, ro, e, e0;

    for (code = 0; code < 19683; code++) {
      var c = code;
      for (k = 8; k >= 0; k--) {
        d[k] = c % 3;
        c = (c / 3) | 0;
      }
      if (d[4] !== 1) continue;

      var score = 0;
      var flag = 0;
      var openFours = 0, fours = 0, openThrees = 0;

      for (s = 0; s <= 4; s++) {
        ones = 0;
        twos = 0;
        for (j = s; j < s + 5; j++) {
          if (d[j] === 1) ones++;
          else if (d[j] === 2) twos++;
        }
        if (twos > 0) continue;

        lo = s > 0 && d[s - 1] === 0;
        ro = s + 5 < 9 && d[s + 5] === 0;

        if (ones === 5) {
          flag |= 1;
          score += SC_FIVE;
        } else if (ones === 4) {
          e = -1;
          for (j = s; j < s + 5; j++) {
            if (d[j] === 0) { e = j; break; }
          }
          if ((e === s && ro) || (e === s + 4 && lo)) {
            openFours++;
            flag |= 2;
            score += SC_OPEN_FOUR * 0.8;
          } else {
            fours++;
            flag |= 4;
            score += SC_FOUR * 0.8;
          }
        } else if (ones === 3) {
          if (lo && ro) {
            openThrees++;
            flag |= 8;
            score += SC_OPEN_THREE * 0.8;
          } else if (lo || ro) {
            score += SC_THREE * 0.8;
          }
        } else if (ones === 2) {
          if (lo && ro) score += SC_OPEN_TWO * 0.5;
          else if (lo || ro) score += SC_TWO * 0.5;
        } else if (ones === 1) {
          if (lo && ro) score += SC_OPEN_ONE * 0.5;
        }
      }

      if (openFours > 0) flag |= 2;
      if (fours > 0 || openFours > 0) flag |= 4;
      if (openThrees > 0) flag |= 8;

      DIR_SCORE[code] = score;
      DIR_FLAG[code] = flag;
    }
  }

  function buildAllTables() {
    buildLineTables();
    buildNeighborhoods();
    buildZobrist();
    buildDirTable();
  }

  /* ================================================================== *
   * 2. 小工具
   * ================================================================== */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mixSeed(a, b) {
    var h = (a ^ Math.imul(b, 2654435761)) | 0;
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function boardHash(board, player) {
    var h = (2166136261 ^ player) | 0;
    for (var i = 0; i < N; i++) {
      h ^= board[i];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function now() {
    return Date.now();
  }

  /** 该空点落 p 子后能否成五（>=5 连） */
  function quickScan(board, i, p) {
    var x = i % SIZE;
    var y = (i - x) / SIZE;
    var s = 0;
    var five = false;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var b = 0, nx, ny;
      while (b < 4) {
        nx = x - dx * (b + 1);
        ny = y - dy * (b + 1);
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
        if (board[ny * SIZE + nx] !== p) break;
        b++;
      }
      var f = 0;
      while (f < 4) {
        nx = x + dx * (f + 1);
        ny = y + dy * (f + 1);
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
        if (board[ny * SIZE + nx] !== p) break;
        f++;
      }
      var run = b + f + 1;
      if (run >= 5) five = true;
      s += RUN_SCORE[run > 5 ? 5 : run];
    }
    _five = five;
    return s;
  }

  /**
   * 对一条方向线的缓冲区做静态评分，结果写入 _sc/_f4/_of4/_ot3。
   * 只统计长度 5 的窗口；窗口里没有对手子才计分。
   */
  function scoreBuf(vals, len, p, o) {
    var s = 0, fours = 0, openFours = 0, openThrees = 0;
    for (var i = 0; i + 4 < len; i++) {
      var c = 0, oc = 0, k, v;
      for (k = 0; k < 5; k++) {
        v = vals[i + k];
        if (v === p) c++;
        else if (v === o) oc++;
      }
      if (oc > 0) continue;

      var lo = i > 0 && vals[i - 1] === 0;
      var ro = i + 5 < len && vals[i + 5] === 0;

      if (c === 5) {
        s += SC_FIVE;
        continue;
      }
      if (c === 4) {
        var e0;
        if (vals[i] === 0) e0 = 0;
        else if (vals[i + 1] === 0) e0 = 1;
        else if (vals[i + 2] === 0) e0 = 2;
        else if (vals[i + 3] === 0) e0 = 3;
        else e0 = 4;
        if ((e0 === 0 && ro) || (e0 === 4 && lo)) {
          s += SC_OPEN_FOUR;
          openFours++;
        } else {
          s += SC_FOUR;
          fours++;
        }
      } else if (c === 3) {
        if (lo && ro) { s += SC_OPEN_THREE; openThrees++; }
        else if (lo || ro) { s += SC_THREE; }
      } else if (c === 2) {
        if (lo && ro) s += SC_OPEN_TWO;
        else if (lo || ro) s += SC_TWO;
      } else if (c === 1) {
        if (lo && ro) s += SC_OPEN_ONE;
        else if (lo || ro) s += SC_ONE;
      }
    }
    _sc = s;
    _f4 = fours + openFours;
    _of4 = openFours;
    _ot3 = openThrees;
  }

  var _lineBuf = new Uint8Array(15);

  /* ================================================================== *
   * 3. Searcher：单次 chooseMove 的工作区（棋盘副本 + 增量评估 + 搜索）
   * ================================================================== */

  function Searcher(board) {
    this.board = new Uint8Array(N);
    this.near = new Int16Array(N);
    this.stoneCount = 0;

    this.sc = new Float64Array(LINE_COUNT * 2); // 每条线每个玩家的静态分
    this.fc = new Float64Array(LINE_COUNT * 2); // 每条线每个玩家的“四”窗口数
    this.tc = new Float64Array(LINE_COUNT * 2); // 每条线每个玩家的“活三”窗口数
    this.total = new Float64Array(2);
    this.fours = new Float64Array(2);           // 全局四窗口数（威胁度）
    this.openThrees = new Float64Array(2);      // 全局活三窗口数（威胁度）

    this.h1 = 0;
    this.h2 = 0;

    this.nodes = 0;
    this.nodeLimit = 0;
    this.aborted = false;
    this.ttMap = new Map();
    this.killer1 = new Int16Array(48);
    this.killer2 = new Int16Array(48);
    for (var kk = 0; kk < 48; kk++) { this.killer1[kk] = -1; this.killer2[kk] = -1; }

    this.pool = new Int16Array(N);
    this.poolCount = 0;
    this.cand = new Int16Array(48);
    this.candCount = 0;
    this.myFiveMove = -1;
    this.oppFiveCount = 0;
    this.oppFiveArr = new Int16Array(8);
    this.cheapArr = new Float64Array(N);

    this.selIdx = new Int16Array(24);
    this.selKey = new Float64Array(24);
    this.ordKey = new Float64Array(24);

    this.candPM4 = new Int16Array(24);
    this.candPO4 = new Int16Array(24);
    this.candPM3 = new Int16Array(24);
    this.candPO3 = new Int16Array(24);

    this.rootM = 20;
    this.midM = 14;
    this.candNBase = 12;

    this.thrOpp = new Int16Array(8);
    this.thrMy = new Int16Array(8);
    this.thrMyFour = new Int16Array(8);
    this.thrOppN = 0;
    this.thrMyN = 0;
    this.thrMyFourN = 0;

    this.vcfCand = new Int16Array(32);
    this.vcfUsed = new Uint8Array(N);
    this.vcfNodes = 0;
    this.vcfLimit = 0;
    this.wpBuf = new Int16Array(4);

    // 宗师档：VCT（连续威胁算杀）工作区
    this.vctCand = new Int16Array(32);
    this.vctStack = new Int16Array(32 * 24);  // 按 ply 分层保存候选，避免递归互相覆盖
    this.vctBuf = new Int16Array(16);
    this.vctNodes = 0;
    this.vctLimit = 0;
    this.pvs = false;      // 主变例搜索（Principal Variation Search）
    this.rootHint = -1;    // VCT 找到但复核未通过的着法，仅用于根节点排序

    this._init(board);
  }

  Searcher.prototype._init = function (src) {
    var i, k;
    for (i = 0; i < N; i++) {
      var v = src[i];
      if (v !== 0) {
        this.board[i] = v === 2 ? WHITE : BLACK;
        this.stoneCount++;
      }
    }

    // 哈希
    var h1 = 0, h2 = 0;
    for (i = 0; i < N; i++) {
      var p = this.board[i];
      if (p !== 0) {
        var z = i * 2 + (p - 1);
        h1 ^= ZOB1[z];
        h2 ^= ZOB2[z];
      }
    }
    this.h1 = h1;
    this.h2 = h2;

    // 邻域计数（切比雪夫距离 <= 2）
    var near = this.near, NEAR = NEAR_IDX;
    for (i = 0; i < N; i++) {
      if (this.board[i] === 0) continue;
      var base = i * 24;
      for (k = 0; k < 24; k++) {
        var j = NEAR[base + k];
        if (j >= 0) near[j]++;
      }
    }

    // 全量评估
    this.total[0] = 0;
    this.total[1] = 0;
    this.fours[0] = 0;
    this.fours[1] = 0;
    this.openThrees[0] = 0;
    this.openThrees[1] = 0;
    for (i = 0; i < LINE_COUNT; i++) {
      this.sc[i * 2] = 0;
      this.sc[i * 2 + 1] = 0;
      this.fc[i * 2] = 0;
      this.fc[i * 2 + 1] = 0;
      this.tc[i * 2] = 0;
      this.tc[i * 2 + 1] = 0;
    }
    for (i = 0; i < LINE_COUNT; i++) this._updateLine(i);
  };

  Searcher.prototype._updateLine = function (id) {
    var start = LINE_START[id];
    var len = LINE_LEN[id];
    var cells = LINE_CELLS;
    var board = this.board;
    var buf = _lineBuf;
    var k;
    for (k = 0; k < len; k++) buf[k] = board[cells[start + k]];

    scoreBuf(buf, len, BLACK, WHITE);
    var s1 = _sc, f1 = _f4, t1 = _ot3;
    scoreBuf(buf, len, WHITE, BLACK);
    var s2 = _sc, f2 = _f4, t2 = _ot3;

    var idx = id * 2;
    var sc = this.sc;
    this.total[0] += s1 - sc[idx];
    this.total[1] += s2 - sc[idx + 1];
    sc[idx] = s1;
    sc[idx + 1] = s2;

    var fc = this.fc, fours = this.fours;
    fours[0] += f1 - fc[idx];
    fours[1] += f2 - fc[idx + 1];
    fc[idx] = f1;
    fc[idx + 1] = f2;

    var tc = this.tc, ot = this.openThrees;
    ot[0] += t1 - tc[idx];
    ot[1] += t2 - tc[idx + 1];
    tc[idx] = t1;
    tc[idx + 1] = t2;
  };

  Searcher.prototype._nearAdd = function (i, delta) {
    var base = i * 24;
    var NEAR = NEAR_IDX;
    var near = this.near;
    for (var k = 0; k < 24; k++) {
      var j = NEAR[base + k];
      if (j >= 0) near[j] += delta;
    }
  };

  Searcher.prototype.winAt = function (i, p) {
    var x = i % SIZE;
    var y = (i - x) / SIZE;
    var board = this.board;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var b = 0, nx, ny;
      while (b < 5) {
        nx = x - dx * (b + 1);
        ny = y - dy * (b + 1);
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
        if (board[ny * SIZE + nx] !== p) break;
        b++;
      }
      var f = 0;
      while (f < 5) {
        nx = x + dx * (f + 1);
        ny = y + dy * (f + 1);
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) break;
        if (board[ny * SIZE + nx] !== p) break;
        f++;
      }
      if (b + f + 1 >= 5) return true;
    }
    return false;
  };

  Searcher.prototype.place = function (i, p) {
    this.board[i] = p;
    this.stoneCount++;
    this._nearAdd(i, 1);
    var z = i * 2 + (p - 1);
    this.h1 ^= ZOB1[z];
    this.h2 ^= ZOB2[z];
    var cl = CELL_LINES, id;
    id = cl[i * 4]; if (id >= 0) this._updateLine(id);
    id = cl[i * 4 + 1]; if (id >= 0) this._updateLine(id);
    id = cl[i * 4 + 2]; if (id >= 0) this._updateLine(id);
    id = cl[i * 4 + 3]; if (id >= 0) this._updateLine(id);
    return this.winAt(i, p);
  };

  Searcher.prototype.remove = function (i) {
    var p = this.board[i];
    this.board[i] = 0;
    this.stoneCount--;
    this._nearAdd(i, -1);
    var z = i * 2 + (p - 1);
    this.h1 ^= ZOB1[z];
    this.h2 ^= ZOB2[z];
    var cl = CELL_LINES, id;
    id = cl[i * 4]; if (id >= 0) this._updateLine(id);
    id = cl[i * 4 + 1]; if (id >= 0) this._updateLine(id);
    id = cl[i * 4 + 2]; if (id >= 0) this._updateLine(id);
    id = cl[i * 4 + 3]; if (id >= 0) this._updateLine(id);
  };

  /** VCF 专用的轻量落子/撤销（不维护评估和哈希，仅棋盘） */
  Searcher.prototype.placeRaw = function (i, p) {
    this.board[i] = p;
  };
  Searcher.prototype.removeRaw = function (i) {
    this.board[i] = 0;
  };

  Searcher.prototype.hashKey = function () {
    return (this.h1 & 2097151) * 4294967296 + (this.h2 >>> 0);
  };

  Searcher.prototype.evalFor = function (p) {
    var o = 3 - p;
    var dw = this.defWeight || DEF_WEIGHT;
    var score = this.total[p - 1] - this.total[o - 1] * dw;

    // 威胁组合：单看线分低估“双四/四三/双活三”这类必胜/近必胜结构
    var myF = this.fours[p - 1], opF = this.fours[o - 1];
    var my3 = this.openThrees[p - 1], op3 = this.openThrees[o - 1];

    if (opF >= 2) score -= 600000;
    else if (opF >= 1 && op3 >= 2) score -= 380000;
    if (op3 >= 2) score -= 130000;
    if (myF >= 2) score += 600000;
    else if (myF >= 1 && my3 >= 2) score += 380000;
    if (my3 >= 2) score += 130000;

    return score;
  };

  /**
   * 九格窗口模式评估：假设在 i 落 p 子，计算我方与对手棋型分/威胁方向数。
   * 输出到 _pmScore/_poScore/_pmFive/_pmFour/_pmOpenThree/_poFive/_poFour/_poOpenThree。
   */
  Searcher.prototype.pointEval = function (i, p) {
    var o = 3 - p;
    var board = this.board;
    var NB = NEIGH9;
    var base = i * 36;
    var sm = 0, so = 0;
    var pmFive = 0, pmFour = 0, pmOpenThree = 0;
    var poFive = 0, poFour = 0, poOpenThree = 0;
    var d, k, ni, v, cm, co, flag;

    for (d = 0; d < 4; d++) {
      cm = 0;
      co = 0;
      var off = base + d * 9;
      for (k = 0; k < 9; k++) {
        ni = NB[off + k];
        if (ni < 0) {
          cm = cm * 3 + 2;
          co = co * 3 + 2;
        } else if (k === 4) {
          cm = cm * 3 + 1;
          co = co * 3 + 1;
        } else {
          v = board[ni];
          if (v === 0) {
            cm = cm * 3;
            co = co * 3;
          } else if (v === p) {
            cm = cm * 3 + 1;
            co = co * 3 + 2;
          } else {
            cm = cm * 3 + 2;
            co = co * 3 + 1;
          }
        }
      }
      sm += DIR_SCORE[cm];
      so += DIR_SCORE[co];
      flag = DIR_FLAG[cm];
      if (flag & 1) pmFive++;
      if (flag & 6) pmFour++;
      if (flag & 8) pmOpenThree++;
      flag = DIR_FLAG[co];
      if (flag & 1) poFive++;
      if (flag & 6) poFour++;
      if (flag & 8) poOpenThree++;
    }

    _pmScore = sm;
    _poScore = so;
    _pmFive = pmFive;
    _pmFour = pmFour;
    _pmOpenThree = pmOpenThree;
    _poFive = poFive;
    _poFour = poFour;
    _poOpenThree = poOpenThree;
  };

  /**
   * 生成候选着法（按启发式排序）。
   * 返回可用着法数，填充 this.cand / this.candCount；
   * 同时设置 this.myFiveMove（我有立即成五点，-1 表示没有）
   * 与 this.oppFiveCount（对手能立即成五的点数）。
   */
  Searcher.prototype.genMoves = function (p, maxN, isRoot) {
    var board = this.board;
    var near = this.near;
    var pool = this.pool;
    var np = 0;
    var i, k;
    for (i = 0; i < N; i++) {
      if (board[i] === 0 && near[i] > 0) pool[np++] = i;
    }
    this.poolCount = np;
    this.myFiveMove = -1;
    this.oppFiveCount = 0;
    this.candCount = 0;
    if (np === 0) return 0;

    var o = 3 - p;
    var cheap = this.cheapArr;
    var occ = this.oppFiveArr;
    var occN = 0;

    for (k = 0; k < np; k++) {
      i = pool[k];
      var sm = quickScan(board, i, p);
      var mf = _five;
      var so = quickScan(board, i, o);
      var of = _five;
      if (mf && this.myFiveMove < 0) this.myFiveMove = i;
      if (of && occN < 8) occ[occN++] = i;
      cheap[i] = sm + so * 0.9 + near[i] * 0.3;
    }
    this.oppFiveCount = occN;

    if (this.myFiveMove >= 0) return 0;

    // 对手有立即成五点：只有堵这些点（或自己成五，已排除）才有意义
    if (occN > 0) {
      for (k = 0; k < occN; k++) this.cand[k] = occ[k];
      this.candCount = occN;
      return occN;
    }

    var M = isRoot ? this.rootM : this.midM;
    if (np < M) M = np;

    // 用廉价分挑出前 M 个（插入式选择）
    var sel = this.selIdx;
    var key = this.selKey;
    var m = 0, j;
    for (k = 0; k < np; k++) {
      i = pool[k];
      var v = cheap[i];
      if (m < M) {
        j = m - 1;
        while (j >= 0 && key[j] < v) {
          key[j + 1] = key[j];
          sel[j + 1] = sel[j];
          j--;
        }
        key[j + 1] = v;
        sel[j + 1] = i;
        m++;
      } else if (v > key[M - 1]) {
        j = M - 2;
        while (j >= 0 && key[j] < v) {
          key[j + 1] = key[j];
          sel[j + 1] = sel[j];
          j--;
        }
        key[j + 1] = v;
        sel[j + 1] = i;
      }
    }

    // 对前 M 个做精确九格模式评分
    var pm4 = this.candPM4, po4 = this.candPO4, pm3 = this.candPM3, po3 = this.candPO3;
    var fpm = _fpmBuf, fpo = _fpoBuf;
    var ordKey = this.ordKey;
    for (k = 0; k < m; k++) {
      i = sel[k];
      this.pointEval(i, p);
      var order = _pmScore + _poScore * 0.9;
      if (_pmFive > 0) order += 6000000;            // 我能成五
      if (_poFive > 0) order += 5000000;            // 必须堵对手成五
      if (_pmFour >= 2) order += 900000;            // 双四
      if (_pmFour >= 1) order += 300000;            // 冲四
      if (_poFour >= 2) order += 850000;            // 对手双四
      if (_poFour >= 1) order += 250000;
      if (_pmOpenThree >= 2) order += 160000;       // 双活三
      if (_poOpenThree >= 2) order += 150000;       // 挡对手双活三
      if (_pmFour >= 1 && _pmOpenThree >= 1) order += 120000; // 四三
      if (_poFour >= 1 && _poOpenThree >= 1) order += 110000;
      ordKey[k] = order;
      fpm[k] = _pmScore;
      fpo[k] = _poScore;
      pm4[k] = _pmFour;
      po4[k] = _poFour;
      pm3[k] = _pmOpenThree;
      po3[k] = _poOpenThree;
    }

    // 按 order 降序排序（M 很小，插入排序），并把棋型附加分带过去
    var slots = m;
    for (k = 1; k < slots; k++) {
      var kk = ordKey[k], ii = sel[k], a = fpm[k], b = fpo[k], c4 = pm4[k], d4 = po4[k], e3 = pm3[k], g3 = po3[k];
      j = k - 1;
      while (j >= 0 && ordKey[j] < kk) {
        ordKey[j + 1] = ordKey[j];
        sel[j + 1] = sel[j];
        fpm[j + 1] = fpm[j];
        fpo[j + 1] = fpo[j];
        pm4[j + 1] = pm4[j];
        po4[j + 1] = po4[j];
        pm3[j + 1] = pm3[j];
        po3[j + 1] = po3[j];
        j--;
      }
      ordKey[j + 1] = kk;
      sel[j + 1] = ii;
      fpm[j + 1] = a;
      fpo[j + 1] = b;
      pm4[j + 1] = c4;
      po4[j + 1] = d4;
      pm3[j + 1] = e3;
      po3[j + 1] = g3;
    }

    // 关键：候选表必须包含“对手威胁点”（对手在此落子会成四/双三），
    // 否则搜索会误判我方必胜——因为对手的抵挡手根本没进入它的候选表。
    var take = 0;
    var q, cell, dup;
    for (k = 0; k < m && take < 8; k++) {
      if (po4[k] >= 1 || po3[k] >= 2 || pm4[k] >= 1) {
        this.cand[take++] = sel[k];
      }
    }
    for (k = 0; k < m && take < maxN; k++) {
      cell = sel[k];
      dup = false;
      for (q = 0; q < take; q++) {
        if (this.cand[q] === cell) { dup = true; break; }
      }
      if (!dup) this.cand[take++] = cell;
    }
    this.candCount = take;
    return take;
  };

  var _fpmBuf = new Float64Array(24);
  var _fpoBuf = new Float64Array(24);

  /** 该点落 p 子后能成五的空点（最多返回 2 个，写 wpBuf，返回数量） */
  Searcher.prototype.winPointsAfter = function (c, p) {
    var board = this.board;
    var buf = this.wpBuf;
    var x = c % SIZE;
    var y = (c - x) / SIZE;
    var n = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      for (var off = -4; off <= 4; off++) {
        if (off === 0) continue;
        var nx = x + dx * off;
        var ny = y + dy * off;
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
        var j = ny * SIZE + nx;
        if (board[j] !== 0) continue;
        board[j] = p;
        var win = this.winAt(j, p);
        board[j] = 0;
        if (win) {
          var dup = false;
          for (var q = 0; q < n; q++) if (buf[q] === j) { dup = true; break; }
          if (!dup) {
            buf[n++] = j;
            if (n >= 2) return n;
          }
        }
      }
    }
    return n;
  };

  /* ---------- 搜索 ---------- */

  /**
   * 根节点威胁扫描：找出“一步就能制造双活三 / 四三 / 双四”的关键点。
   * 这是人下棋最直觉的判断（“对手这里一落就双活三了”），静态评估看不见，
   * 靠它把 normal 以上的防守拉到人级别。只在根节点调用一次，开销可忽略。
   *
   * 结果写入：
   *   thrOppN / thrOpp   对手的双威胁点（双活三、四三、双四）
   *   thrMyN  / thrMy    我方的双威胁点
   *   thrMyFourN / thrMyFour 我方的冲四/活四点（强制手）
   */
  Searcher.prototype.threatScan = function (p) {
    var o = 3 - p;
    var board = this.board;
    var near = this.near;
    var opp = this.thrOpp, my = this.thrMy, myFour = this.thrMyFour;
    var oppN = 0, myN = 0, myFourN = 0;
    for (var i = 0; i < N; i++) {
      if (board[i] !== 0 || near[i] === 0) continue;

      this.pointEval(i, o);            // 对手在这个点落子会怎样
      if ((_pmOpenThree >= 2) || (_pmFour >= 1 && _pmOpenThree >= 1) || (_pmFour >= 2)) {
        if (oppN < 8) opp[oppN++] = i;
      }

      this.pointEval(i, p);            // 我方在这个点落子会怎样
      if ((_pmOpenThree >= 2) || (_pmFour >= 1 && _pmOpenThree >= 1) || (_pmFour >= 2)) {
        if (myN < 8) my[myN++] = i;
      }
      if (_pmFour >= 1 && myFourN < 8) myFour[myFourN++] = i;
    }
    this.thrOppN = oppN;
    this.thrMyN = myN;
    this.thrMyFourN = myFourN;
  };

  Searcher.prototype.candLimit = function (depth) {
    var base = this.candNBase;
    if (depth >= 5) return base;
    if (depth >= 3) return base - 1;
    if (depth === 2) return base - 2;
    var v = base - 4;
    return v < 8 ? 8 : v;
  };

  Searcher.prototype.negamax = function (depth, alpha, beta, p, ply, ext) {
    this.nodes++;
    if (this.nodes > this.nodeLimit) {
      this.aborted = true;
      return 0;
    }

    var key = this.hashKey();
    var tt = this.ttMap.get(key);
    if (tt !== undefined && tt.d >= depth) {
      /* f: 0=上界(fail-low) 1=精确 2=下界(fail-high)。
         严格模式（宗师档开启）按标准语义使用置换表：旧写法对 f===0 无条件返回，
         会把某条线的“高上界”（甚至必胜分）当成当前节点必然能达到的值，产生假必胜。
         其余五档保持旧语义以维持既有强度基线（见 bench-results.md）。 */
      if (this.ttStrict) {
        if (tt.f === 1) return tt.s;
        if (tt.f === 2) { if (tt.s >= beta) return tt.s; }
        else if (tt.s <= alpha) return tt.s;
      } else {
        if (tt.f === 0) return tt.s;
        if (tt.f === 1 && tt.s <= alpha) return tt.s;
        if (tt.f === 2 && tt.s >= beta) return tt.s;
      }
    }

    if (depth <= 0) return this.evalFor(p);

    var n = this.genMoves(p, this.candLimit(depth), false);
    if (this.myFiveMove >= 0) return WIN_SCORE - ply;
    if (this.oppFiveCount > 1) return -(WIN_SCORE - ply - 1);
    if (n === 0) return this.evalFor(p);

    // TT 着法 / 杀手着法优先
    var cand = this.cand;
    var k;
    var ttMove = tt !== undefined ? tt.m : -1;
    var k1 = this.killer1[ply], k2 = this.killer2[ply];
    if (ttMove >= 0) {
      for (k = 0; k < n; k++) {
        if (cand[k] === ttMove) {
          var tmp = cand[0]; cand[0] = cand[k]; cand[k] = tmp;
          break;
        }
      }
    }
    if (k1 >= 0) {
      for (k = 1; k < n; k++) {
        if (cand[k] === k1) {
          var t2 = cand[1]; cand[1] = cand[k]; cand[k] = t2;
          break;
        }
      }
    }
    if (k2 >= 0) {
      for (k = 2; k < n; k++) {
        if (cand[k] === k2) {
          var t3 = cand[2]; cand[2] = cand[k]; cand[k] = t3;
          break;
        }
      }
    }

    var best = -INF;
    var bestMove = -1;
    var a0 = alpha;
    var o = 3 - p;
    // PVS：首个着法用完整窗口，其余先用零窗口试探，超出 alpha 再重搜。
    // 只对 cfg.pvs 的档位生效（宗师），保证其余档位行为不变。
    var usePVS = this.pvs && beta - alpha > 1;

    for (k = 0; k < n; k++) {
      var mv = cand[k];
      var win = this.place(mv, p);
      var val;
      if (win) {
        val = WIN_SCORE - ply;
      } else if (usePVS && k > 0 && alpha > -INF) {
        // 说明：早期版本在这里“只要有冲四就加深一层”，但与置换表同深度复用
        // 会产生互相矛盾的边界值（实测出现过假的必胜分），因此改为固定深度，
        // 由评估函数里的四/活三组合威胁项承担战术敏锐度，VCF/VCT 负责强制杀。
        val = -this.negamax(depth - 1, -alpha - 1, -alpha, o, ply + 1, ext);
        if (val > alpha && val < beta && !this.aborted) {
          val = -this.negamax(depth - 1, -beta, -alpha, o, ply + 1, ext);
        }
      } else {
        val = -this.negamax(depth - 1, -beta, -alpha, o, ply + 1, ext);
      }
      this.remove(mv);
      if (this.aborted) return best;

      if (val > best) {
        best = val;
        bestMove = mv;
      }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (k1 !== mv) {
          this.killer2[ply] = k1;
          this.killer1[ply] = mv;
        }
        break;
      }
    }

    this.ttMap.set(key, {
      s: best,
      d: depth,
      f: best <= a0 ? 0 : (best >= beta ? 2 : 1),
      m: bestMove
    });
    return best;
  };

  /* ---------- VCF：连续冲四算杀 ---------- */

  Searcher.prototype.findFiveMove = function (p) {
    var board = this.board;
    for (var i = 0; i < N; i++) {
      if (board[i] !== p) continue;
      var base = i * 8;
      for (var k = 0; k < 8; k++) {
        var j = RING8[base + k];
        if (j < 0 || board[j] !== 0) continue;
        quickScan(board, j, p);
        if (_five) return j;
      }
    }
    return -1;
  };

  /**
   * VCF 搜索：只走“冲四/活四”强制手，对手被迫挡，再继续。
   * 返回本层可取胜的着法下标，找不到返回 -1。
   */
  Searcher.prototype.vcfSearch = function (p, depth, ply) {
    if (depth <= 0) return -1;
    if (++this.vcfNodes > this.vcfLimit) return -1;

    var o = 3 - p;
    var board = this.board;
    var i, k, j;

    // 1) 我能成五：直接赢
    var five = this.findFiveMove(p);
    if (five >= 0) return five;
    // 2) 对手能成五：我已被叫杀，VCF 无法继续
    if (this.findFiveMove(o) >= 0) return -1;

    // 3) 收集我方子力八邻域内的空点
    var cand = this.vcfCand;
    var used = this.vcfUsed;
    var nc = 0;
    for (i = 0; i < N; i++) {
      if (board[i] !== p) continue;
      var base = i * 8;
      for (k = 0; k < 8; k++) {
        j = RING8[base + k];
        if (j < 0 || board[j] !== 0 || used[j]) continue;
        used[j] = 1;
        if (nc < 24) cand[nc++] = j;
      }
    }
    for (k = 0; k < nc; k++) used[cand[k]] = 0;

    // 4) 逐个尝试“冲四”手
    for (k = 0; k < nc; k++) {
      i = cand[k];
      this.pointEval(i, p);
      if (_pmFour <= 0) continue;

      this.placeRaw(i, p);
      var wn = this.winPointsAfter(i, p);
      if (wn >= 2) {
        this.removeRaw(i);
        return i;
      }
      if (wn === 1) {
        var blk = this.wpBuf[0];
        this.placeRaw(blk, o);
        var res = -1;
        // 对手堵点如果同时成五，则我这一冲四失败
        if (!this.winAt(blk, o)) res = this.vcfSearch(p, depth - 1, ply + 2);
        this.removeRaw(blk);
        if (res >= 0) {
          this.removeRaw(i);
          return i;
        }
      }
      this.removeRaw(i);
      if (this.vcfNodes > this.vcfLimit) break;
    }
    return -1;
  };

  /* ---------- VCT：连续威胁算杀（冲四 + 活三/双威胁链） ---------- */

  /**
   * 对手是否有“一步成四”的点（成四后下一手就能成五）。
   * 用来判断对手能否用反冲四打断我方的活三链：
   * 若对手有成四点，我方做活三会被对手反冲四抢先，故这条链不成立。
   */
  Searcher.prototype.defenderFourThreat = function (o) {
    var board = this.board;
    for (var i = 0; i < N; i++) {
      if (board[i] !== 0 || this.near[i] === 0) continue;
      this.pointEval(i, o);
      if (_pmFour >= 1) return i;
    }
    return -1;
  };

  /**
   * 落 c 之后，c 所在方向上「刚好三连且两端皆空」的活三，返回两端挡点（写入 vctBuf）。
   * 对手若不堵这两端之一，我方下一手就能做出活四 → 必胜。
   */
  Searcher.prototype.vctOpenThreeEnds = function (c, p) {
    var board = this.board;
    var buf = this.vctBuf;
    var n = 0;
    var x = c % SIZE;
    var y = (c - x) / SIZE;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0];
      var dy = DIRS[d][1];
      var f = 0, bx = x + dx, by = y + dy;
      while (bx >= 0 && bx < SIZE && by >= 0 && by < SIZE && board[by * SIZE + bx] === p) {
        f++; bx += dx; by += dy;
      }
      var b = 0, ax = x - dx, ay = y - dy;
      while (ax >= 0 && ax < SIZE && ay >= 0 && ay < SIZE && board[ay * SIZE + ax] === p) {
        b++; ax -= dx; ay -= dy;
      }
      if (f + b + 1 !== 3) continue;   // 只处理「正三」（含 c 的连续三子）
      if (bx < 0 || bx >= SIZE || by < 0 || by >= SIZE) continue;
      if (ax < 0 || ax >= SIZE || ay < 0 || ay >= SIZE) continue;
      var e1 = by * SIZE + bx;
      var e2 = ay * SIZE + ax;
      if (board[e1] !== 0 || board[e2] !== 0) continue;   // 一端被堵 → 不是活三
      if (n < 14) buf[n++] = e1;
      if (n < 14) buf[n++] = e2;
    }
    return n;
  };

  /**
   * VCT 搜索：交替走「冲四」与「活三」等强制手，对手只能被动应对，
   * 直到我方做出双四/活四（必杀）或用连续威胁把对手耗死。
   * 返回本层可取胜的着法下标，找不到返回 -1。
   *
   * 与 VCF 的区别：VCF 只算连续冲四；VCT 允许插入活三（对手必须堵一端），
   * 因此能覆盖「活三 → 冲四 → 冲四 → 成五」这类更长的强制胜。
   *
   * 正确性说明：所有“对手只能堵这里”的判断都是保守的——
   *   · 对手能立即成五 → 直接判失败；
   *   · 对手有反冲四 → 活三这条路不成立（对手会先成五）；
   *   · 只有「两端皆空」的正三才被当作强制手（宁可漏算，也不造出假杀）。
   */
  Searcher.prototype.vctSearch = function (p, depth, ply) {
    if (depth <= 0) return -1;
    if (++this.vctNodes > this.vctLimit) return -1;

    var o = 3 - p;
    var board = this.board;
    var i, k, j;

    var five = this.findFiveMove(p);
    if (five >= 0) return five;
    if (this.findFiveMove(o) >= 0) return -1;   // 对手先成五，此路失败

    // 候选：我方子力八邻域内的空点，按 ply 分层保存（递归不会互相覆盖）
    var base = ply * 24;
    if (base + 24 > this.vctStack.length) return -1;
    var used = this.vcfUsed;
    var nc = 0;
    for (i = 0; i < N; i++) {
      if (board[i] !== p) continue;
      var b8 = i * 8;
      for (k = 0; k < 8; k++) {
        j = RING8[b8 + k];
        if (j < 0 || board[j] !== 0 || used[j]) continue;
        used[j] = 1;
        if (nc < 24) this.vctStack[base + nc++] = j;
      }
    }
    for (k = 0; k < nc; k++) used[this.vctStack[base + k]] = 0;
    if (nc === 0) return -1;

    // 两轮：先冲四（绝对强制），再活三（对手必须堵一端）
    for (var pass = 0; pass < 2; pass++) {
      for (k = 0; k < nc; k++) {
        if (this.vctNodes > this.vctLimit) return -1;
        i = this.vctStack[base + k];
        if (board[i] !== 0) continue;
        this.pointEval(i, p);
        var isFour = _pmFour >= 1;
        var isThree = _pmOpenThree >= 1;
        if (pass === 0) {
          if (!isFour) continue;
        } else {
          if (isFour || !isThree) continue;
        }
        if (this.vctTry(p, o, i, depth, ply)) return i;
      }
    }
    return -1;
  };

  /** 尝试 VCT 的一手棋：冲四/活三 → 对手被迫应对 → 递归。成功返回 true。 */
  Searcher.prototype.vctTry = function (p, o, c, depth, ply) {
    this.placeRaw(c, p);

    // 对手能立即成五 → 这一手不够快
    if (this.findFiveMove(o) >= 0) { this.removeRaw(c); return false; }

    var wn = this.winPointsAfter(c, p);
    if (wn >= 2) { this.removeRaw(c); return true; }   // 双四 / 活四：必杀

    if (wn === 1) {
      // 冲四：对手必须挡
      var blk = this.wpBuf[0];
      this.placeRaw(blk, o);
      var ok = false;
      if (!this.winAt(blk, o)) ok = this.vctSearch(p, depth - 1, ply + 2) >= 0;
      this.removeRaw(blk);
      this.removeRaw(c);
      return ok;
    }

    // 活三 / 双活三：对手必须堵一端；对手能反冲四则此路不成立
    if (depth >= 2 && this.defenderFourThreat(o) < 0) {
      var ne = this.vctOpenThreeEnds(c, p);
      if (ne > 0) {
        // 挡点复制到本层专用槽位（ply*24+24），递归覆盖不到
        var sb = ply * 24 + 24;
        for (var q = 0; q < ne; q++) this.vctStack[sb + q] = this.vctBuf[q];
        var all = true;
        for (q = 0; q < ne; q++) {
          var r = this.vctStack[sb + q];
          if (this.board[r] !== 0) continue;
          this.placeRaw(r, o);
          var bad = this.winAt(r, o) || this.vctSearch(p, depth - 1, ply + 2) < 0;
          this.removeRaw(r);
          if (bad) { all = false; break; }
        }
        this.removeRaw(c);
        return all;
      }
    }
    this.removeRaw(c);
    return false;
  };

  /**
   * 用正常的 alpha-beta 复核 VCT 找到的杀招（防止启发式挡点集合漏算导致假杀）。
   * 只有复核确认是必胜才直接采用；否则只把它当根节点排序提示。
   */
  Searcher.prototype.verifyWinAt = function (p, mv, depth, nodeLimit) {
    if (depth <= 0) return false;
    var o = 3 - p;
    var savedLimit = this.nodeLimit;
    var savedNodes = this.nodes;
    var savedTT = this.ttMap;
    var savedAborted = this.aborted;

    this.nodeLimit = nodeLimit;
    this.nodes = 0;
    this.ttMap = new Map();
    this.aborted = false;

    this.place(mv, p);
    var v = this.negamax(depth - 1, -INF, INF, o, 1, 0);
    this.remove(mv);

    var ok = !this.aborted && v >= WIN_SCORE - 1000;
    this.nodeLimit = savedLimit;
    this.nodes = savedNodes;
    this.ttMap = savedTT;
    this.aborted = savedAborted;
    return ok;
  };

  /* ---------- 迭代加深根搜索 ---------- */

  Searcher.prototype.searchRoot = function (p, rootN, maxDepth) {
    var n = this.genMoves(p, rootN, true);
    var i, k;

    if (this.myFiveMove >= 0) return { move: this.myFiveMove, score: WIN_SCORE, depth: 0 };
    if (this.oppFiveCount > 0) {
      return { move: this._pickBlock(p), score: 0, depth: 0 };
    }
    if (n === 0) return { move: -1, score: 0, depth: 0 };

    var moves = this._rootMoves;
    for (k = 0; k < n; k++) moves[k] = this.cand[k];
    var moveCount = n;
    var scores = _rootScores;

    // VCT 找到但复核未通过的杀招：塞进根候选，至少让深搜优先验证它
    if (this.rootHint >= 0) {
      var hint = this.rootHint;
      var found = false;
      for (k = 0; k < moveCount; k++) if (moves[k] === hint) { found = true; break; }
      if (!found && moveCount < 46 && this.board[hint] === 0) moves[moveCount++] = hint;
    }

    // 深度 1：静态评估
    var bestMove = moves[0];
    var bestScore = -INF;
    for (k = 0; k < moveCount; k++) {
      var mv = moves[k];
      this.place(mv, p);
      var sc = this.evalFor(p);
      this.remove(mv);
      scores[k] = sc;
      if (sc > bestScore) { bestScore = sc; bestMove = mv; }
    }
    this._sortRoot(moves, scores, moveCount);
    var bestDepth = 1;

    var o = 3 - p;
    for (var depth = 2; depth <= maxDepth; depth++) {
      var alpha = -INF;
      var iterBest = -1;
      var iterScore = -INF;
      var abortedNow = false;
      for (k = 0; k < moveCount; k++) {
        var mv2 = moves[k];
        var win = this.place(mv2, p);
        var val;
        if (win) {
          val = WIN_SCORE - 1;
        } else {
          val = -this.negamax(depth - 1, -INF, -alpha, o, 1, 0);
        }
        this.remove(mv2);
        if (this.aborted) { abortedNow = true; break; }
        scores[k] = val;
        if (val > iterScore) { iterScore = val; iterBest = mv2; }
        if (val > alpha) alpha = val;
      }
      if (abortedNow) break;
      this._sortRoot(moves, scores, moveCount);
      bestMove = iterBest;
      bestScore = iterScore;
      bestDepth = depth;
      if (bestScore >= WIN_SCORE - 1000 || bestScore <= -(WIN_SCORE - 1000)) break;
      if (this.nodes > this.nodeLimit * 0.95) break;
    }
    return { move: bestMove, score: bestScore, depth: bestDepth };
  };

  Searcher.prototype._pickBlock = function (p) {
    var best = this.oppFiveArr[0];
    if (this.oppFiveCount <= 1) return best;
    var bestSc = -INF;
    for (var k = 0; k < this.oppFiveCount; k++) {
      var i = this.oppFiveArr[k];
      this.pointEval(i, p);
      var sc = _pmScore - _poScore;
      if (sc > bestSc) { bestSc = sc; best = i; }
    }
    return best;
  };

  Searcher.prototype._rootMoves = new Int16Array(48);
  var _rootScores = new Float64Array(48);

  Searcher.prototype._sortRoot = function (moves, scores, n) {
    for (var k = 1; k < n; k++) {
      var mv = moves[k], sc = scores[k];
      var j = k - 1;
      while (j >= 0 && scores[j] < sc) {
        moves[j + 1] = moves[j];
        scores[j + 1] = scores[j];
        j--;
      }
      moves[j + 1] = mv;
      scores[j + 1] = sc;
    }
  };

  /* ================================================================== *
   * 4. 五档难度配置
   * ================================================================== */

  var DIFFICULTIES = {
    novice: {
      key: 'novice',
      label: '入门',
      stars: 1,
      emoji: '🐣',
      desc: '刚学会规则，经常看不出两三步后的杀招。',
      budgetMs: 60
    },
    easy: {
      key: 'easy',
      label: '简单',
      stars: 2,
      emoji: '🙂',
      desc: '会挡四、会做简单的活三，但常被你抢先成五。',
      budgetMs: 150
    },
    normal: {
      key: 'normal',
      label: '普通',
      stars: 3,
      emoji: '😎',
      desc: '攻守均衡，能算到三四步之后，值得认真对待。',
      budgetMs: 350
    },
    hard: {
      key: 'hard',
      label: '困难',
      stars: 4,
      emoji: '🧠',
      desc: '会算杀、会防守双威胁，走错一步就会被抓住。',
      budgetMs: 800
    },
    master: {
      key: 'master',
      label: '大师',
      stars: 5,
      emoji: '👑',
      desc: '接近人类强手：连续冲四算杀 + Alpha-Beta 深搜，很难赢。',
      budgetMs: 1800
    },
    grandmaster: {
      key: 'grandmaster',
      label: '宗师',
      stars: 6,
      emoji: '🔥',
      desc: '全力算杀：VCT 连续威胁搜索 + 超深 Alpha-Beta，人类几乎无法取胜。',
      budgetMs: 2400
    }
  };

  var DIFFICULTY_KEYS = ['novice', 'easy', 'normal', 'hard', 'master', 'grandmaster'];

  /**
   * 内部搜索参数。
   * nodes / budgetMs 决定“节点预算 = nodes * timeBudget / budgetMs”，
   * 用确定性节点数而不是墙钟时间做停手条件，保证同局面同种子可复现。
   */
  var LEVELS = {
    novice: {
      nodes: 600, maxDepth: 1, rootN: 8, candN: 8,
      vcfDepth: 0, vcfNodes: 0, defense: false,
      randomRate: 0.30, fiveProb: 0.95, blockProb: 0.60
    },
    easy: {
      nodes: 1200, maxDepth: 1, rootN: 10, candN: 10,
      vcfDepth: 0, vcfNodes: 0, defense: false,
      randomRate: 0.10
    },
    normal: {
      nodes: 4000, maxDepth: 4, rootN: 14, candN: 11,
      vcfDepth: 0, vcfNodes: 0, defense: true
    },
    hard: {
      nodes: 40000, maxDepth: 6, rootN: 20, candN: 13,
      vcfDepth: 10, vcfNodes: 600, defense: true
    },
    master: {
      nodes: 60000, maxDepth: 8, rootN: 20, candN: 13,
      vcfDepth: 12, vcfNodes: 700, defense: true
    },
    /*
     * 宗师：比大师更深的主搜索 + VCT（连续威胁算杀）+ 主变例搜索（PVS）。
     * nodes 是“默认预算下的 negamax 节点上限”，实际节点数按
     * timeBudgetMs / budgetMs 线性缩放（保证确定性）；VCT 节点预算同样缩放。
     */
    grandmaster: {
      nodes: 60000, maxDepth: 12, rootN: 16, candN: 11,
      vcfDepth: 14, vcfNodes: 800, defense: true,
      vctDepth: 12, vctNodes: 900, vctVerifyDepth: 8, vctDefense: true,
      pvs: true,
      ttStrict: true
    }
  };

  /* ================================================================== *
   * 5. 各难度决策
   * ================================================================== */

  function openingMove(inst, rng) {
    // 大师/宗师/困难/普通固定天元；入门/简单在中心 5x5 随机
    if (inst.key === 'grandmaster' || inst.key === 'master' ||
        inst.key === 'hard' || inst.key === 'normal') {
      return 7 * SIZE + 7;
    }
    var r1 = rng();
    var r2 = rng();
    var x = 5 + ((r1 * 5) | 0);
    var y = 5 + ((r2 * 5) | 0);
    if (x > SIZE - 1) x = SIZE - 1;
    if (y > SIZE - 1) y = SIZE - 1;
    return y * SIZE + x;
  }

  function fallbackMove(board) {
    var center = 7 * SIZE + 7;
    if (board[center] === 0) return center;
    for (var i = 0; i < N; i++) if (board[i] === 0) return i;
    return -1;
  }

  function pickRandomFromPool(s, rng, maxCount) {
    var pool = s.pool;
    var np = s.poolCount;
    if (np <= 0) return -1;
    var lim = np < maxCount ? np : maxCount;
    return pool[(rng() * lim) | 0];
  }

  function noviceMove(s, p, cfg, rng) {
    s.genMoves(p, cfg.rootN, true);

    if (s.myFiveMove >= 0) {
      if (rng() < cfg.fiveProb) return s.myFiveMove;
    }
    if (s.oppFiveCount > 0) {
      if (rng() < cfg.blockProb) {
        return s.oppFiveArr[(rng() * s.oppFiveCount) | 0];
      }
    }
    // 30% 完全随机（附近空点）
    if (rng() < cfg.randomRate) {
      var r = pickRandomFromPool(s, rng, s.poolCount);
      if (r >= 0) return r;
    }
    // 简单启发式：在候选中带噪声地挑一个
    if (s.candCount > 0) {
      var lim = s.candCount < 5 ? s.candCount : 5;
      return s.cand[(rng() * lim) | 0];
    }
    return fallbackMove(s.board);
  }

  function easyMove(s, p, cfg, rng) {
    s.genMoves(p, cfg.rootN, true);

    if (s.myFiveMove >= 0) return s.myFiveMove;       // 100% 成五
    if (s.oppFiveCount > 0) {                          // 100% 挡冲四
      return s.oppFiveArr[0];
    }
    if (s.candCount === 0) return fallbackMove(s.board);

    // 10% 随机扰动，显得“业余”
    if (rng() < cfg.randomRate) {
      var limR = s.candCount < 6 ? s.candCount : 6;
      return s.cand[(rng() * limR) | 0];
    }

    // 深度 1 静态评估最优
    var best = s.cand[0];
    var bestSc = -INF;
    var n = s.candCount;
    for (var k = 0; k < n; k++) {
      var mv = s.cand[k];
      s.place(mv, p);
      var sc = s.evalFor(p);
      s.remove(mv);
      if (sc > bestSc) {
        bestSc = sc;
        best = mv;
      }
    }
    return best;
  }

  /** 困难/大师：先用 VCF 找自己的杀，再考虑对手 VCF 防守 */
  function strongDefenseFilter(s, p, cfg, rootN, nodeBudget, force) {
    var o = 3 - p;
    var k;
    if (!force) {
      var threat = false;
      // 快速危险性判断：对手是否有“做出双四/双活三”的候选点
      for (k = 0; k < s.candCount; k++) {
        if (s.candPO4[k] >= 2 || s.candPO3[k] >= 2) { threat = true; break; }
      }
      if (!threat) return null;
    }

    // 对手 VCF 威胁？
    s.vcfNodes = 0;
    s.vcfLimit = Math.max(force ? 900 : 60, Math.min(force ? 2400 : 500, nodeBudget >> 3));
    var oppVcf = s.vcfSearch(o, cfg.vcfDepth, 0);

    // 宗师：对手 VCT（连续威胁）算杀检查 —— 比 VCF 更长，必须优先化解
    var oppVct = -1;
    if (cfg.vctDefense && cfg.vctDepth > 0) {
      s.vctNodes = 0;
      s.vctLimit = Math.max(force ? 700 : 120, Math.min(force ? 2000 : 600, nodeBudget >> 4));
      oppVct = s.vctSearch(o, cfg.vctDepth - 2, 0);
    }

    if (oppVcf < 0 && oppVct < 0) return null;

    var safe = [];
    var tryN = s.candCount < (force ? 12 : 10) ? s.candCount : (force ? 12 : 10);
    for (k = 0; k < tryN; k++) {
      var mv = s.cand[k];
      s.place(mv, p);
      var ok = true;
      if (oppVcf >= 0) {
        s.vcfNodes = 0;
        s.vcfLimit = Math.max(force ? 300 : 40, Math.min(force ? 1200 : 300, nodeBudget >> 4));
        if (s.vcfSearch(o, cfg.vcfDepth - 2, 0) >= 0) ok = false;
      }
      if (ok && oppVct >= 0) {
        s.vctNodes = 0;
        s.vctLimit = Math.max(force ? 500 : 100, Math.min(force ? 1500 : 400, nodeBudget >> 5));
        if (s.vctSearch(o, cfg.vctDepth - 4, 0) >= 0) ok = false;
      }
      s.remove(mv);
      if (ok) safe.push(mv);
    }
    return safe.length > 0 ? safe : null;
  }

  function searchMove(s, p, cfg, rng) {
    s.candNBase = cfg.candN;
    s.rootM = cfg.rootN + 4;
    s.midM = cfg.candN + 4;
    if (s.rootM > 24) s.rootM = 24;
    if (s.midM > 20) s.midM = 20;
    s.pvs = !!cfg.pvs;
    s.defWeight = cfg.defWeight || DEF_WEIGHT;
    // 严格置换表探针：所有档位默认开启（旧探针把 fail-low 上界当精确值返回，会产生假必胜）
    s.ttStrict = (cfg.ttStrict !== undefined) ? !!cfg.ttStrict : true;
    s.rootHint = -1;

    var n = s.genMoves(p, cfg.rootN, true);
    if (s.myFiveMove >= 0) return { move: s.myFiveMove, score: WIN_SCORE, depth: 0 };
    if (s.oppFiveCount > 0) return { move: s._pickBlock(p), score: 0, depth: 0 };
    if (n === 0) return { move: -1, score: 0, depth: 0 };

    var nodeBudget = s.nodeLimit;

    // VCF 算杀
    if (cfg.vcfDepth > 0) {
      s.vcfNodes = 0;
      s.vcfLimit = cfg.vcfNodes;
      var vm = s.vcfSearch(p, cfg.vcfDepth, 0);
      if (vm >= 0) return { move: vm, score: WIN_SCORE, depth: 0, vcf: true };
    }

    // VCT 算杀（宗师）：覆盖「活三 → 冲四 → …」这种 VCF 算不到的更长强制胜。
    // 找到后先用 alpha-beta 复核，防止启发式挡点集合漏算造成假杀；
    // 复核没通过就只把它当作根节点排序提示。
    if (cfg.vctDepth > 0) {
      var vScale = cfg.nodes > 0 ? s.nodeLimit / cfg.nodes : 1;
      var vLimit = Math.round(cfg.vctNodes * vScale);
      if (vLimit < 120) vLimit = 120;
      s.vctNodes = 0;
      s.vctLimit = vLimit;
      var vt = s.vctSearch(p, cfg.vctDepth, 0);
      if (vt >= 0) {
        var vNodes = Math.round(cfg.nodes * vScale * 0.25);
        if (vNodes < 400) vNodes = 400;
        if (s.verifyWinAt(p, vt, cfg.vctVerifyDepth, vNodes)) {
          return { move: vt, score: WIN_SCORE, depth: cfg.vctVerifyDepth, vct: true };
        }
        s.rootHint = vt;
      }
    }

    // 威胁过滤（normal 及以上）：
    // 1) 对手存在“一步双活三/四三/双四”的点 → 必须处理，候选收窄到
    //    「堵这些点」+「我方冲四点」，避免搜索把防守手剪掉；
    // 2) 对手有 VCF 杀 → 再进一步用 VCF 复核，剔掉仍会输的着法。
    var restrict = null;
    if (cfg.defense) {
      s.threatScan(p);
      if (s.thrOppN > 0 && s.thrMyFourN === 0) {
        var allow = [];
        var k2;
        for (k2 = 0; k2 < s.thrOppN; k2++) allow.push(s.thrOpp[k2]);
        for (k2 = 0; k2 < s.thrMyFourN; k2++) {
          if (allow.indexOf(s.thrMyFour[k2]) < 0) allow.push(s.thrMyFour[k2]);
        }
        // 若我方也有双威胁点，先手更快，一并保留
        for (k2 = 0; k2 < s.thrMyN; k2++) {
          if (allow.indexOf(s.thrMy[k2]) < 0) allow.push(s.thrMy[k2]);
        }
        restrict = allow;
      } else {
        restrict = strongDefenseFilter(s, p, cfg, cfg.rootN, nodeBudget, false);
      }
    }

    s.ttMap = new Map();
    for (var kk = 0; kk < 48; kk++) { s.killer1[kk] = -1; s.killer2[kk] = -1; }
    s.nodes = 0;
    s.aborted = false;

    if (restrict && restrict.length > 0) {
      // 只搜索确认安全的着法
      var saved = [];
      for (var q = 0; q < restrict.length; q++) saved.push(restrict[q]);
      // 用临时候选表替换根候选
      var savedCand = s.cand.slice(0, s.candCount);
      var savedCount = s.candCount;
      for (q = 0; q < saved.length; q++) s.cand[q] = saved[q];
      s.candCount = saved.length;
      var res = s.searchRootRestricted(p, saved, cfg.maxDepth);
      s.cand.set(savedCand, 0);
      s.candCount = savedCount;
      return res;
    }

    return s.searchRoot(p, cfg.rootN, cfg.maxDepth);
  }

  Searcher.prototype.searchRootRestricted = function (p, movesArr, maxDepth) {
    var n = movesArr.length;
    if (n === 0) return { move: -1, score: 0, depth: 0 };
    var moves = this._rootMoves;
    var scores = _rootScores;
    var k;
    for (k = 0; k < n; k++) moves[k] = movesArr[k];

    var bestMove = moves[0];
    var bestScore = -INF;
    for (k = 0; k < n; k++) {
      var mv = moves[k];
      this.place(mv, p);
      var sc = this.evalFor(p);
      this.remove(mv);
      scores[k] = sc;
      if (sc > bestScore) { bestScore = sc; bestMove = mv; }
    }
    this._sortRoot(moves, scores, n);
    var bestDepth = 1;

    var o = 3 - p;
    for (var depth = 2; depth <= maxDepth; depth++) {
      var alpha = -INF;
      var iterBest = -1;
      var iterScore = -INF;
      var abortedNow = false;
      for (k = 0; k < n; k++) {
        var mv2 = moves[k];
        var win = this.place(mv2, p);
        var val;
        if (win) {
          val = WIN_SCORE - 1;
        } else {
          val = -this.negamax(depth - 1, -INF, -alpha, o, 1, 0);
        }
        this.remove(mv2);
        if (this.aborted) { abortedNow = true; break; }
        scores[k] = val;
        if (val > iterScore) { iterScore = val; iterBest = mv2; }
        if (val > alpha) alpha = val;
      }
      if (abortedNow) break;
      this._sortRoot(moves, scores, n);
      bestMove = iterBest;
      bestScore = iterScore;
      bestDepth = depth;
      if (bestScore >= WIN_SCORE - 1000 || bestScore <= -(WIN_SCORE - 1000)) break;
      if (this.nodes > this.nodeLimit * 0.95) break;
    }
    return { move: bestMove, score: bestScore, depth: bestDepth };
  };

  /* ================================================================== *
   * 6. 对外接口
   * ================================================================== */

  function chooseMove(inst, board, player, ctx) {
    var t0 = now();
    var p = player === WHITE ? WHITE : BLACK;

    if (!board || board.length !== N) return null;

    var cfg = LEVELS[inst.key] || LEVELS.normal;

    // 预算：ctx.timeBudgetMs > options.timeBudgetMs > 难度默认
    var budgetMs = inst._budgetMs || DIFFICULTIES[inst.key].budgetMs;
    if (ctx && typeof ctx.timeBudgetMs === 'number' && ctx.timeBudgetMs > 0) {
      budgetMs = ctx.timeBudgetMs;
    }
    var scale = budgetMs / DIFFICULTIES[inst.key].budgetMs;
    var nodes = Math.round(cfg.nodes * scale);
    if (nodes < 150) nodes = 150;
    if (nodes > cfg.nodes * 4) nodes = cfg.nodes * 4;

    var s = new Searcher(board);
    if (s.stoneCount >= N) return null;
    if (s.stoneCount === 0) {
      var openRng = mulberry32(mixSeed(inst._seed, 0x5eed));
      var om = openingMove(inst, openRng);
      return {
        x: om % SIZE,
        y: (om / SIZE) | 0,
        score: 0,
        depth: 0,
        nodes: 0,
        elapsedMs: now() - t0
      };
    }

    var rng = mulberry32(mixSeed(inst._seed, boardHash(board, p)));
    s.nodeLimit = nodes;

    var result;
    if (inst.key === 'novice') {
      result = { move: noviceMove(s, p, cfg, rng), depth: 0, score: 0 };
    } else if (inst.key === 'easy') {
      result = { move: easyMove(s, p, cfg, rng), depth: 1, score: 0 };
    } else {
      result = searchMove(s, p, cfg, rng);
    }

    var mv = result.move;

    // 保险：任何情况下都返回合法空点
    if (!(mv >= 0 && mv < N) || board[mv] !== 0) {
      mv = fallbackMove(board);
      if (mv < 0) return null;
    }

    return {
      x: mv % SIZE,
      y: (mv / SIZE) | 0,
      score: result.score || 0,
      depth: result.depth || 0,
      nodes: s.nodes,
      elapsedMs: now() - t0
    };
  }

  function create(difficultyKey, options) {
    var key = (difficultyKey === undefined || difficultyKey === null) ? 'normal' : String(difficultyKey);
    if (!LEVELS[key]) key = 'normal';
    var cfg = LEVELS[key];
    var opts = options || {};

    var inst = {
      key: key,
      label: DIFFICULTIES[key].label,
      stars: DIFFICULTIES[key].stars,
      emoji: DIFFICULTIES[key].emoji,
      desc: DIFFICULTIES[key].desc,
      budgetMs: DIFFICULTIES[key].budgetMs,
      difficulty: DIFFICULTIES[key],
      _seed: (opts.seed === undefined || opts.seed === null) ? DEFAULT_SEED : (opts.seed >>> 0),
      _budgetMs: (typeof opts.timeBudgetMs === 'number' && opts.timeBudgetMs > 0)
        ? opts.timeBudgetMs : 0,
      _lastError: null,
      chooseMove: function (board, player, ctx) {
        try {
          return chooseMove(inst, board, player, ctx);
        } catch (e) {
          inst._lastError = e;
          if (typeof console !== 'undefined' && console.error) {
            console.error('[GomokuAI] chooseMove error:', e);
          }
          try {
            var fb = fallbackMove(board);
            if (fb < 0) return null;
            return { x: fb % SIZE, y: (fb / SIZE) | 0, score: 0, depth: 0, nodes: 0, elapsedMs: 0 };
          } catch (e2) {
            return null;
          }
        }
      },
      reset: function (seed) {
        inst._seed = (seed === undefined || seed === null) ? DEFAULT_SEED : (seed >>> 0);
      }
    };
    return inst;
  }

  /* 构建全部静态表（加载时一次性完成） */
  buildAllTables();

  var GomokuAI = {
    VERSION: VERSION,
    DIFFICULTIES: DIFFICULTIES,
    DIFFICULTY_KEYS: DIFFICULTY_KEYS,
    DEFAULT_SEED: DEFAULT_SEED,
    create: create,
    /* 供测试/调试读取的内部信息（不属于稳定 API） */
    _levels: LEVELS,
    _size: SIZE,
    _boardHash: boardHash
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GomokuAI;
  }
  global.GomokuAI = GomokuAI;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
