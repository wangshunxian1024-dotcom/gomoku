/*!
 * app.js — 五子棋应用层：棋盘渲染、对局流程、AI 调度、回放与分享
 *
 * 依赖：window.GomokuCore（core.js）；window.GomokuAI（ai.js）
 * 若 ai.js 不可用，会退化到内置的简易 AI，保证页面仍能运行。
 */
(function (window, document) {
  'use strict';

  var C = window.GomokuCore;
  if (!C) {
    document.body.innerHTML = '<p style="padding:2rem;font:16px/1.6 sans-serif">缺少核心脚本 js/core.js，页面无法运行。</p>';
    return;
  }

  var SIZE = C.SIZE;
  var N = C.N;
  var BLACK = C.BLACK;
  var WHITE = C.WHITE;
  var EMPTY = C.EMPTY;

  var $ = function (id) { return document.getElementById(id); };

  /* ================================================================== *
   * 0. AI 适配层（缺省时提供简易引擎，保证可玩）
   * ================================================================== */

  var FALLBACK_AI = (function () {
    var meta = {
      novice: { key: 'novice', label: '入门', stars: 1, emoji: '🐣', desc: '刚学会规则，经常看不出两三步后的杀招。', budgetMs: 60 },
      easy: { key: 'easy', label: '简单', stars: 2, emoji: '🙂', desc: '会挡四、会做简单的活三，但常被你抢先成五。', budgetMs: 150 },
      normal: { key: 'normal', label: '普通', stars: 3, emoji: '😎', desc: '攻守均衡，能算到三四步之后，值得认真对待。', budgetMs: 350 },
      hard: { key: 'hard', label: '困难', stars: 4, emoji: '🧠', desc: '会算杀、会防守双威胁，走错一步就会被抓住。', budgetMs: 800 },
      master: { key: 'master', label: '大师', stars: 5, emoji: '👑', desc: '接近人类强手：连续冲四算杀 + 深搜，很难赢。', budgetMs: 1800 },
      grandmaster: { key: 'grandmaster', label: '宗师', stars: 6, emoji: '🔥', desc: '全力算杀：连续威胁搜索 + 超深搜，人类几乎无法取胜。', budgetMs: 2400 }
    };
    function legalMoves(board) {
      var list = [];
      for (var i = 0; i < N; i++) if (board[i] === EMPTY) list.push(i);
      return list;
    }
    function winningPoint(board, player) {
      for (var y = 0; y < SIZE; y++) {
        for (var x = 0; x < SIZE; x++) {
          if (board[C.idx(x, y)] !== EMPTY) continue;
          board[C.idx(x, y)] = player;
          var win = C.checkWin(board, x, y);
          board[C.idx(x, y)] = EMPTY;
          if (win) return { x: x, y: y };
        }
      }
      return null;
    }
    function create(key) {
      var level = meta[key] ? key : 'normal';
      function chooseMove(board, player) {
        if (C.isFull(board)) return null;
        var empty = C.countStones(board) === 0;
        if (empty) return { x: 7, y: 7 };
        var win = winningPoint(board, player);
        if (win) return win;
        var block = winningPoint(board, C.opponent(player));
        if (block && level !== 'novice') return block;
        var moves = legalMoves(board);
        var pick = moves[Math.floor(Math.random() * moves.length)];
        return { x: pick % SIZE, y: (pick / SIZE) | 0 };
      }
      return { key: level, label: meta[level].label, chooseMove: chooseMove, reset: function () {} };
    }
    return { VERSION: 'fallback', DIFFICULTIES: meta, create: create };
  })();

  var AI = (window.GomokuAI && typeof window.GomokuAI.create === 'function') ? window.GomokuAI : FALLBACK_AI;

  function difficultyMeta(key) {
    var source = (AI.DIFFICULTIES && AI.DIFFICULTIES[key]) || {};
    var fb = FALLBACK_AI.DIFFICULTIES[key] || { label: key, stars: 3, desc: '', emoji: '🤖' };
    return {
      key: key,
      label: source.label || fb.label,
      stars: typeof source.stars === 'number' ? source.stars : fb.stars,
      emoji: source.emoji || fb.emoji,
      desc: source.desc || fb.desc
    };
  }

  /* ================================================================== *
   * 1. 状态
   * ================================================================== */

  var state = {
    board: C.createBoard(),
    moves: [],            // [{x, y, player}]
    difficulty: 'normal',
    mode: 'pve',          // 'pve' | 'pvp'
    humanColor: BLACK,
    turn: BLACK,
    finished: false,
    winner: 0,
    draw: false,
    winLine: null,
    winDir: null,
    thinking: false,
    hintThinking: false,
    hint: null,           // {x, y}
    replayCursor: null,   // 数字 => 回放模式
    aiInstance: null,
    hintAI: null,
    aiSeed: 20240521,
    aiToken: 0,
    sound: true,
    theme: 'light',
    lastAiMs: 0,
    hover: null
  };

  var aiMetaCache = {};
  var skipLoadToast = false;

  /* ================================================================== *
   * 2. DOM 引用
   * ================================================================== */

  var ui = {
    html: document.documentElement,
    canvas: $('board'),
    stage: $('board-stage'),
    thinkingBadge: $('thinking-badge'),
    thinkingText: $('thinking-text'),
    statusBadge: $('status-badge'),
    statusMoves: $('status-moves'),
    statusMain: $('status-main'),
    statusSub: $('status-sub'),
    thinking: $('thinking'),
    thinkingTime: $('thinking-time'),
    difficultyList: $('difficulty-list'),
    difficultyTag: $('difficulty-tag'),
    difficultyDesc: $('difficulty-desc'),
    modeSwitch: $('mode-switch'),
    colorSwitch: $('color-switch'),
    btnNew: $('btn-new'),
    btnUndo: $('btn-undo'),
    btnHint: $('btn-hint'),
    btnResign: $('btn-resign'),
    btnShare: $('btn-share'),
    btnTheme: $('btn-theme'),
    btnSound: $('btn-sound'),
    btnCopyMoves: $('btn-copy-moves'),
    moveList: $('move-list'),
    playerBlack: $('player-black'),
    playerWhite: $('player-white'),
    nameBlack: $('name-black'),
    nameWhite: $('name-white'),
    caption: $('board-caption'),
    engineNote: $('engine-note'),
    replayBar: $('replay-bar'),
    replayLabel: $('replay-label'),
    resultOverlay: $('result-overlay'),
    resultEmoji: $('result-emoji'),
    resultTitle: $('result-title'),
    resultDesc: $('result-desc'),
    btnAgain: $('btn-again'),
    btnResultReview: $('btn-result-review'),
    btnResultClose: $('btn-result-close'),
    shareDialog: $('share-dialog'),
    shareLink: $('share-link'),
    shareTip: $('share-tip'),
    toast: $('toast')
  };

  var ctx = ui.canvas.getContext('2d');
  var layout = { size: 0, cell: 0, margin: 0, dpr: 1 };
  var anim = null; // {x, y, t0}
  var animRaf = 0; // 落子动画的 requestAnimationFrame 句柄
  var renderTicks = 0; // renderBoard 被调用的次数（动画帧循环的观测点）
  var toastTimer = 0;

  /* ================================================================== *
   * 3. 工具
   * ================================================================== */

  function isPve() { return state.mode === 'pve'; }

  function toast(message, ms) {
    ui.toast.textContent = message;
    ui.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove('is-visible'); }, ms || 2200);
  }

  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function formatMs(ms) {
    if (!ms && ms !== 0) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function loadPref(key, fallback) {
    try {
      var v = window.localStorage.getItem('gomoku.' + key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function savePref(key, value) {
    try { window.localStorage.setItem('gomoku.' + key, String(value)); } catch (e) { /* 忽略隐私模式 */ }
  }

  function randomSeed() {
    return (Math.floor(Math.random() * 0x7fffffff) ^ (Date.now() & 0x7fffffff)) | 0;
  }

  /* ================================================================== *
   * 4. 游戏状态
   * ================================================================== */

  function rebuild() {
    var r = C.replay(state.moves);
    if (!r.ok) {
      // 理论上不会发生；兜底重置
      state.moves = [];
      r = C.replay([]);
    }
    state.board = r.board;
    state.moves = r.moves;
    state.turn = r.turn || C.playerAt(r.moveCount);
    state.winner = r.winner;
    state.draw = r.draw;
    state.winLine = r.winLine;
    state.winDir = r.dir;
    state.finished = r.finished;
  }

  function resetGame(opts) {
    opts = opts || {};
    cancelPendingAI();
    stopAnim();
    state.moves = [];
    state.board = C.createBoard();
    state.turn = BLACK;
    state.finished = false;
    state.winner = 0;
    state.draw = false;
    state.winLine = null;
    state.winDir = null;
    state.hint = null;
    state.hintThinking = false;
    state.replayCursor = null;
    state.thinking = false;
    state.lastAiMs = 0;
    state.resigned = false;
    state.aiSeed = opts.seed || randomSeed();
    state.aiInstance = null;
    state.hintAI = null;
    hideResult();
    buildAI();
    renderAll();
    syncHash();
    if (isPve() && state.turn !== state.humanColor) scheduleAI(420);
  }

  function buildAI() {
    try {
      state.aiInstance = AI.create(state.difficulty, { seed: state.aiSeed });
    } catch (e) {
      console.error('创建 AI 失败：', e);
      state.aiInstance = FALLBACK_AI.create(state.difficulty);
    }
  }

  function getHintAI() {
    if (!state.hintAI) {
      try {
        state.hintAI = AI.create('master', { seed: 987654321 });
      } catch (e) {
        state.hintAI = FALLBACK_AI.create('master');
      }
    }
    return state.hintAI;
  }

  function cancelPendingAI() {
    state.aiToken++;
    state.thinking = false;
    renderThinking();
  }

  function scheduleAI(delay) {
    if (!isPve() || state.finished || state.replayCursor !== null) return;
    if (state.turn === state.humanColor) return;
    var token = ++state.aiToken;
    state.thinking = true;
    renderThinking();
    renderStatus();
    setTimeout(function () {
      if (token !== state.aiToken || state.finished) return;
      var board = C.cloneBoard(state.board);
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      var move = null;
      try {
        move = state.aiInstance.chooseMove(board, state.turn, { moveCount: state.moves.length });
      } catch (e) {
        console.error('AI 走子异常：', e);
      }
      var elapsed = ((window.performance && performance.now) ? performance.now() : Date.now()) - t0;
      if (token !== state.aiToken) return;
      state.thinking = false;
      if (!move || !C.isInBounds(move.x, move.y) || state.board[C.idx(move.x, move.y)] !== EMPTY) {
        move = randomLegalMove(board);
      }
      state.lastAiMs = elapsed;
      if (move) playMove(move.x, move.y, { ai: true });
      else renderAll();
    }, Math.max(30, delay || 30));
  }

  function randomLegalMove(board) {
    var options = [];
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        if (board[C.idx(x, y)] === EMPTY) options.push({ x: x, y: y });
      }
    }
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }

  function playMove(x, y, opts) {
    opts = opts || {};
    if (state.finished || state.replayCursor !== null) return false;
    if (!C.isInBounds(x, y) || state.board[C.idx(x, y)] !== EMPTY) return false;

    var player = state.turn;
    state.board[C.idx(x, y)] = player;
    state.moves.push({ x: x, y: y, player: player });
    state.hint = null;
    state.hover = null;

    var win = C.checkWin(state.board, x, y);
    if (win) {
      state.winner = win.player;
      state.winLine = win.cells;
      state.winDir = win.dir;
      state.finished = true;
    } else if (C.isFull(state.board)) {
      state.draw = true;
      state.finished = true;
    } else {
      state.turn = C.opponent(player);
    }

    anim = { x: x, y: y, t0: (window.performance && performance.now) ? performance.now() : Date.now() };
    playPlaceSound(player);
    renderAll();
    syncHash();

    if (state.finished) {
      onGameEnd();
    } else if (isPve() && state.turn !== state.humanColor) {
      scheduleAI(220);
    }
    return true;
  }

  function onGameEnd() {
    playEndSound();
    setTimeout(function () {
      if (!state.finished || state.replayCursor !== null) return;
      showResult();
    }, 520);
  }

  function undo() {
    if (state.replayCursor !== null) { exitReplay(); return; }
    if (!state.moves.length) { toast('还没有落子可以悔棋'); return; }
    if (state.thinking) {
      cancelPendingAI();
      toast('已取消 AI 思考');
    }
    if (isPve() && state.humanColor === WHITE && state.moves.length === 1) {
      toast('黑棋由 AI 先行，直接开新局吧');
      return;
    }
    hideResult();
    state.hint = null;
    state.hintThinking = false;
    var guard = 0;
    do {
      state.moves.pop();
      rebuild();
      guard++;
    } while (isPve() && !state.finished && state.moves.length > 0 && state.turn !== state.humanColor && guard < 3);
    rebuild();
    stopAnim();
    renderAll();
    syncHash();
    if (state.moves.length === 0 && isPve() && state.turn !== state.humanColor) {
      scheduleAI(320);
    }
  }

  function resign() {
    if (state.finished || !state.moves.length) { toast('现在还不能认输'); return; }
    var loser = isPve() ? state.humanColor : state.turn;
    var ok = window.confirm(isPve() ? '确定认输吗？本局将判 AI 获胜。' : '确定要替「' + (loser === BLACK ? '黑方' : '白方') + '」认输吗？');
    if (!ok) return;
    state.finished = true;
    state.winner = C.opponent(loser);
    state.draw = false;
    state.winLine = null;
    state.resigned = true;
    renderAll();
    syncHash();
    showResult();
    renderStatus();
  }

  function hint() {
    if (!isPve()) { toast('双人模式下不需要提示'); return; }
    if (state.finished) { toast('对局已经结束，开新局吧'); return; }
    if (state.thinking) { toast('AI 正在思考，稍等'); return; }
    if (state.turn !== state.humanColor) return;
    if (state.hint) { state.hint = null; renderAll(); return; }
    var token = ++state.aiToken;
    state.hintThinking = true;
    renderStatus();
    renderThinking();
    setTimeout(function () {
      if (token !== state.aiToken || state.finished) return;
      var board = C.cloneBoard(state.board);
      var move = null;
      try {
        move = getHintAI().chooseMove(board, state.turn, { moveCount: state.moves.length, timeBudgetMs: 900 });
      } catch (e) {
        console.error('提示计算失败：', e);
      }
      if (token !== state.aiToken) return;
      state.hintThinking = false;
      if (move && C.isInBounds(move.x, move.y) && state.board[C.idx(move.x, move.y)] === EMPTY) {
        state.hint = { x: move.x, y: move.y };
        toast('建议下在 ' + C.coordName(move.x, move.y));
      } else {
        toast('没有找到合适的建议');
      }
      renderAll();
    }, 30);
  }

  /* ================================================================== *
   * 5. 回放
   * ================================================================== */

  function startReplay(cursor) {
    if (!state.moves.length) { toast('还没有棋谱可以回放'); return; }
    hideResult();
    cancelPendingAI();
    stopAnim();
    state.hint = null;
    state.replayCursor = typeof cursor === 'number' ? Math.max(0, Math.min(state.moves.length, cursor)) : state.moves.length;
    renderAll();
    toast('使用 ⏮ ◀ ▶ ⏭ 逐步回放', 2600);
  }

  function exitReplay() {
    state.replayCursor = null;
    renderAll();
    if (!state.finished && isPve() && state.turn !== state.humanColor) scheduleAI(240);
    else if (!state.finished && isPve() && state.turn === state.humanColor) renderStatus();
  }

  function setReplayCursor(cursor) {
    if (state.replayCursor === null) return;
    state.replayCursor = Math.max(0, Math.min(state.moves.length, cursor));
    renderBoard();
    renderReplayBar();
    renderStatus();
    renderMoveList();
  }

  /* ================================================================== *
   * 6. 分享
   * ================================================================== */

  function encodeCurrent() {
    return C.encodeState({
      moves: state.moves,
      difficulty: state.difficulty,
      mode: state.mode,
      humanColor: state.humanColor
    });
  }

  function syncHash() {
    try {
      var hash = '#' + encodeCurrent();
      if (window.location.hash !== hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
      }
    } catch (e) { /* file:// 下个别浏览器限制 replaceState，忽略即可 */ }
  }

  function shareUrl() {
    var base;
    try {
      base = window.location.origin && window.location.origin !== 'null'
        ? window.location.origin + window.location.pathname + window.location.search
        : window.location.href.split('#')[0];
    } catch (e) {
      base = window.location.href.split('#')[0];
    }
    return base + '#' + encodeCurrent();
  }

  function movesText() {
    var lines = [];
    var meta = difficultyMeta(state.difficulty);
    var modeText = isPve() ? '人机对战' : '双人同屏';
    lines.push('五子棋 · ' + meta.label + '难度 · ' + modeText);
    var names = [];
    for (var i = 0; i < state.moves.length; i++) {
      names.push((i + 1) + '.' + C.coordName(state.moves[i].x, state.moves[i].y));
    }
    lines.push(names.join(' '));
    lines.push('结果：' + resultText());
    lines.push('链接：' + shareUrl());
    return lines.join('\n');
  }

  function resultText() {
    if (!state.moves.length) return '空盘';
    if (state.draw) return '平局（棋盘已满）';
    if (!state.winner) return '对局进行中';
    var side = state.winner === BLACK ? '黑方' : '白方';
    if (isPve()) {
      return state.winner === state.humanColor ? '你赢了（' + side + '胜）' : 'AI 获胜（' + side + '胜）';
    }
    return side + '胜';
  }

  function copyText(text, okMessage) {
    function done(ok) {
      toast(ok ? (okMessage || '已复制') : '复制失败，请手动选择复制');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) {
      done(false);
    }
  }

  function openShareDialog() {
    var url = shareUrl();
    ui.shareLink.value = url;
    if (window.location.protocol === 'file:') {
      ui.shareTip.textContent = '提示：当前是以本地文件（file://）打开，这个链接只有你自己能打开。用 python3 serve.py 启动后复制局域网地址，或把 gomoku 目录部署到静态托管，就能分享给任何人了。';
    } else {
      ui.shareTip.textContent = '提示：链接已包含完整棋谱。同一 Wi-Fi 下用 python3 serve.py 启动后，把终端显示的局域网地址发给朋友即可；部署到 GitHub Pages / Netlify / Vercel 等静态托管后则任何人都能打开。';
    }
    if (typeof ui.shareDialog.showModal === 'function') {
      ui.shareDialog.showModal();
    } else {
      ui.shareDialog.setAttribute('open', '');
    }
    setTimeout(function () {
      try { ui.shareLink.focus(); ui.shareLink.select(); } catch (e) { /* 忽略 */ }
    }, 60);
  }

  function closeShareDialog() {
    if (typeof ui.shareDialog.close === 'function') ui.shareDialog.close();
    else ui.shareDialog.removeAttribute('open');
  }

  function nativeShare() {
    var data = {
      title: '五子棋 · 来下一盘',
      text: '我在玩五子棋，这盘棋的局面在这：' + (isPve() ? '（' + difficultyMeta(state.difficulty).label + ' AI）' : ''),
      url: shareUrl()
    };
    if (navigator.share) {
      navigator.share(data).catch(function (err) {
        if (err && err.name !== 'AbortError') toast('系统分享不可用，请复制链接');
      });
    } else {
      toast('当前浏览器不支持系统分享，已为你选中链接');
      try { ui.shareLink.focus(); ui.shareLink.select(); } catch (e) { /* 忽略 */ }
    }
  }

  function saveShareImage() {
    try {
      var canvas = buildShareCard();
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (!blob) { toast('图片生成失败'); return; }
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          var d = new Date();
          var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
          a.href = url;
          a.download = '五子棋-' + stamp + '.png';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
          toast('对局图片已保存');
        }, 'image/png');
      } else {
        var dataUrl = canvas.toDataURL('image/png');
        var link = document.createElement('a');
        link.href = dataUrl;
        link.download = '五子棋对局.png';
        link.click();
      }
    } catch (e) {
      console.error(e);
      toast('图片生成失败');
    }
  }

  /* ================================================================== *
   * 7. 分享图
   * ================================================================== */

  function buildShareCard() {
    var W = 1080;
    var H = 1440;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var g = canvas.getContext('2d');
    var font = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';

    var bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#faf3e6');
    bg.addColorStop(0.55, '#f2e5cf');
    bg.addColorStop(1, '#ead8ba');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    g.fillStyle = 'rgba(120, 88, 44, 0.10)';
    for (var lineY = 0; lineY < H; lineY += 46) {
      g.fillRect(0, lineY, W, 1);
    }

    g.fillStyle = '#3a2b1a';
    g.font = '700 64px ' + font;
    g.textAlign = 'left';
    g.fillText('五子棋 · 对局回顾', 84, 132);

    g.fillStyle = '#7a6344';
    g.font = '500 30px ' + font;
    var meta = difficultyMeta(state.difficulty);
    g.fillText(meta.label + ' 难度 · ' + (isPve() ? '人机对战' : '双人同屏') + ' · 共 ' + state.moves.length + ' 手', 86, 186);

    var panel = { x: 90, y: 240, w: 900, h: 900 };
    g.save();
    g.shadowColor = 'rgba(80, 55, 20, 0.30)';
    g.shadowBlur = 44;
    g.shadowOffsetY = 20;
    g.fillStyle = '#e3c9a0';
    roundRect(g, panel.x, panel.y, panel.w, panel.h, 26);
    g.fill();
    g.restore();

    var wood = g.createLinearGradient(panel.x, panel.y, panel.x + panel.w, panel.y + panel.h);
    wood.addColorStop(0, '#f0dab6');
    wood.addColorStop(0.5, '#e7cda2');
    wood.addColorStop(1, '#dbbd8c');

    g.save();
    g.beginPath();
    roundRect(g, panel.x, panel.y, panel.w, panel.h, 26);
    g.clip();
    g.translate(panel.x, panel.y);
    drawBoardScene(g, panel.w, state.board, {
      last: state.moves.length ? state.moves[state.moves.length - 1] : null,
      winLine: state.winLine,
      theme: 'light',
      showCoords: true,
      bg: wood
    });
    g.restore();

    g.strokeStyle = 'rgba(120, 88, 44, 0.45)';
    g.lineWidth = 2;
    roundRect(g, panel.x + 1, panel.y + 1, panel.w - 2, panel.h - 2, 25);
    g.stroke();

    var resultColor = '#3a2b1a';
    g.textAlign = 'center';
    g.fillStyle = resultColor;
    g.font = '700 46px ' + font;
    g.fillText(resultText(), W / 2, 1236);

    g.fillStyle = '#7a6344';
    g.font = '500 28px ' + font;
    g.fillText('打开链接即可继续这盘棋 · Gomoku', W / 2, 1290);
    var url = shareUrl();
    var shown = url.length > 64 ? url.slice(0, 61) + '…' : url;
    g.font = '400 24px ' + font;
    g.fillStyle = '#8d7655';
    g.fillText(shown, W / 2, 1330);

    g.textAlign = 'left';
    g.fillStyle = 'rgba(58, 43, 26, 0.55)';
    g.font = '500 24px ' + font;
    g.fillText('五子棋 · GOMOKU', 84, H - 52);
    g.textAlign = 'right';
    var d = new Date();
    g.fillText(d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate(), W - 84, H - 52);
    g.textAlign = 'left';
    return canvas;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ================================================================== *
   * 8. 棋盘渲染
   * ================================================================== */

  function resizeCanvas() {
    var rect = ui.canvas.getBoundingClientRect();
    var size = Math.max(1, Math.round(rect.width || ui.canvas.clientWidth || 600));
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (layout.size === size && layout.dpr === dpr) return;
    layout.size = size;
    layout.dpr = dpr;
    ui.canvas.width = Math.round(size * dpr);
    ui.canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout.cell = size / (SIZE + 1.4);
    layout.margin = (size - (SIZE - 1) * layout.cell) / 2;
    renderBoard();
  }

  function viewBoard() {
    if (state.replayCursor === null) return state.board;
    var board = C.createBoard();
    for (var i = 0; i < state.replayCursor; i++) {
      board[C.idx(state.moves[i].x, state.moves[i].y)] = state.moves[i].player;
    }
    return board;
  }

  function viewMoveCount() {
    return state.replayCursor === null ? state.moves.length : state.replayCursor;
  }

  function stopAnim() {
    anim = null;
    if (animRaf) {
      cancelAnimationFrame(animRaf);
      animRaf = 0;
    }
  }

  function renderBoard() {
    if (!layout.size) return;
    renderTicks++;
    var size = layout.size;
    var board = viewBoard();
    var moveCount = viewMoveCount();
    var last = moveCount > 0 ? state.moves[moveCount - 1] : null;
    var winLine = (state.replayCursor === null || state.replayCursor === state.moves.length) ? state.winLine : null;
    var finishedView = state.replayCursor === null ? state.finished : (moveCount === state.moves.length && state.finished);

    var animProgress = 1;
    if (anim) {
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      animProgress = Math.min(1, (now - anim.t0) / 170);
    }

    drawBoardScene(ctx, size, board, {
      last: last,
      winLine: winLine,
      hover: state.hover,
      hint: state.replayCursor === null ? state.hint : null,
      anim: anim && animProgress < 1 ? { x: anim.x, y: anim.y, progress: animProgress } : null,
      theme: state.theme,
      showCoords: true,
      finished: finishedView
    });

    // 落子动画靠 rAF 逐帧驱动；没有这一步时只会画出首帧（P3-1 回归）
    if (anim && animProgress < 1) {
      if (!animRaf) animRaf = requestAnimationFrame(stepAnim);
    } else if (anim) {
      anim = null; // 动画播完，恢复正常渲染
      animRaf = 0;
    }
  }

  function stepAnim() {
    animRaf = 0;
    renderBoard();
  }

  function stoneRadius() { return layout.cell * 0.44; }

  function drawBoardScene(g, size, board, opt) {
    opt = opt || {};
    var cell = size / (SIZE + 1.4);
    var margin = (size - (SIZE - 1) * cell) / 2;
    var r = cell * 0.44;
    var last = opt.last || null;
    var winLine = opt.winLine || null;
    var hover = opt.hover || null;
    var hint = opt.hint || null;
    var animStone = opt.anim || null;
    var light = opt.theme !== 'dark';

    var lineColor = light ? 'rgba(63, 44, 22, 0.82)' : 'rgba(230, 214, 188, 0.72)';
    var starColor = light ? 'rgba(52, 36, 18, 0.9)' : 'rgba(238, 224, 200, 0.85)';
    var labelColor = light ? 'rgba(70, 50, 26, 0.62)' : 'rgba(236, 224, 204, 0.6)';

    if (opt.bg) {
      g.fillStyle = opt.bg;
      g.fillRect(0, 0, size, size);
    } else {
      g.clearRect(0, 0, size, size);
    }

    // 网格
    g.strokeStyle = lineColor;
    g.lineWidth = Math.max(1, size / 760);
    g.beginPath();
    for (var i = 0; i < SIZE; i++) {
      var p = margin + i * cell;
      g.moveTo(margin, p);
      g.lineTo(size - margin, p);
      g.moveTo(p, margin);
      g.lineTo(p, size - margin);
    }
    g.stroke();

    // 外框加粗
    g.lineWidth = Math.max(1.4, size / 420);
    g.strokeStyle = light ? 'rgba(63, 44, 22, 0.92)' : 'rgba(236, 220, 192, 0.82)';
    g.strokeRect(margin, margin, (SIZE - 1) * cell, (SIZE - 1) * cell);

    // 星位
    var stars = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
    g.fillStyle = starColor;
    for (var s = 0; s < stars.length; s++) {
      var sx = margin + stars[s][0] * cell;
      var sy = margin + stars[s][1] * cell;
      g.beginPath();
      g.arc(sx, sy, Math.max(2, cell * 0.085), 0, Math.PI * 2);
      g.fill();
    }

    // 坐标
    if (opt.showCoords) {
      var fontSize = Math.max(9, cell * 0.34);
      g.font = '600 ' + fontSize + 'px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
      g.fillStyle = labelColor;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (var c = 0; c < SIZE; c++) {
        var cx = margin + c * cell;
        g.fillText(C.coordName(c, 0).replace(/\d+$/, ''), cx, margin * 0.5);
        var rowLabel = String(c + 1);
        g.fillText(rowLabel, margin * 0.5, margin + c * cell);
      }
    }

    // 棋子
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        var v = board[C.idx(x, y)];
        if (!v) continue;
        var px = margin + x * cell;
        var py = margin + y * cell;
        var isAnim = animStone && animStone.x === x && animStone.y === y;
        if (isAnim) {
          var ease = 1 - Math.pow(1 - animStone.progress, 3);
          drawStone(g, px, py, r * (0.55 + 0.45 * ease), v, Math.min(1, 0.3 + animStone.progress * 1.6));
        } else {
          drawStone(g, px, py, r, v, 1);
        }
      }
    }

    // 最后一手标记
    if (last && !animStone) {
      var lx = margin + last.x * cell;
      var ly = margin + last.y * cell;
      var stone = board[C.idx(last.x, last.y)];
      g.beginPath();
      g.arc(lx, ly, r * 0.19, 0, Math.PI * 2);
      g.fillStyle = stone === BLACK ? 'rgba(255, 214, 122, 0.95)' : 'rgba(198, 96, 46, 0.95)';
      g.fill();
      g.beginPath();
      g.arc(lx, ly, r * 0.44, 0, Math.PI * 2);
      g.strokeStyle = stone === BLACK ? 'rgba(255, 214, 122, 0.55)' : 'rgba(198, 96, 46, 0.55)';
      g.lineWidth = Math.max(1, r * 0.09);
      g.stroke();
    }

    // 胜利连线
    if (winLine && winLine.length >= 2) {
      var a = winLine[0];
      var b = winLine[winLine.length - 1];
      var ax = margin + a[0] * cell;
      var ay = margin + a[1] * cell;
      var bx = margin + b[0] * cell;
      var by = margin + b[1] * cell;
      g.save();
      g.strokeStyle = light ? 'rgba(214, 88, 48, 0.88)' : 'rgba(255, 156, 108, 0.9)';
      g.lineWidth = Math.max(3, cell * 0.16);
      g.lineCap = 'round';
      g.shadowColor = light ? 'rgba(214, 88, 48, 0.5)' : 'rgba(255, 156, 108, 0.45)';
      g.shadowBlur = cell * 0.4;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
      g.restore();
    }

    // 提示点
    if (hint) {
      var hx = margin + hint.x * cell;
      var hy = margin + hint.y * cell;
      g.save();
      g.strokeStyle = 'rgba(45, 138, 146, 0.95)';
      g.lineWidth = Math.max(2, r * 0.16);
      g.beginPath();
      g.arc(hx, hy, r * 1.35, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(hx, hy, r * 0.7, 0, Math.PI * 2);
      g.fillStyle = 'rgba(45, 138, 146, 0.22)';
      g.fill();
      g.restore();
    }

    // 悬停预览
    if (hover && !animStone) {
      drawStone(g, margin + hover.x * cell, margin + hover.y * cell, r, hover.player, 0.38);
    }
  }

  function drawStone(g, cx, cy, radius, player, alpha) {
    g.save();
    g.globalAlpha = alpha;
    g.shadowColor = 'rgba(24, 16, 8, 0.42)';
    g.shadowBlur = radius * 0.42;
    g.shadowOffsetY = radius * 0.2;
    var grad = g.createRadialGradient(cx - radius * 0.34, cy - radius * 0.38, radius * 0.08, cx, cy, radius * 1.06);
    if (player === BLACK) {
      grad.addColorStop(0, '#6c6c72');
      grad.addColorStop(0.32, '#34343a');
      grad.addColorStop(0.78, '#141416');
      grad.addColorStop(1, '#040405');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.42, '#f8f5ef');
      grad.addColorStop(0.82, '#e3ddd2');
      grad.addColorStop(1, '#bcb4a6');
    }
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, radius, 0, Math.PI * 2);
    g.fill();
    g.restore();

    g.save();
    g.globalAlpha = alpha;
    g.beginPath();
    g.arc(cx, cy, radius, 0, Math.PI * 2);
    g.strokeStyle = player === BLACK ? 'rgba(0, 0, 0, 0.55)' : 'rgba(120, 108, 90, 0.5)';
    g.lineWidth = Math.max(1, radius * 0.055);
    g.stroke();
    g.restore();
  }

  function renderThinking() {
    var busy = state.thinking || state.hintThinking;
    ui.thinkingBadge.hidden = !busy;
    ui.thinking.hidden = !busy;
    ui.thinkingTime.textContent = state.thinking && state.lastAiMs ? '（上一步 ' + formatMs(state.lastAiMs) + '）' : '';
  }

  /* ================================================================== *
   * 9. UI 渲染
   * ================================================================== */

  function renderAll() {
    if (!layout.size) resizeCanvas();
    renderBoard();
    renderStatus();
    renderPlayers();
    renderMoveList();
    renderControls();
    renderReplayBar();
    renderThinking();
    renderDifficulty();
    renderSettingsUI();
    renderCaption();
  }

  function renderStatus() {
    var badge = '对局中';
    var badgeClass = '';
    if (state.replayCursor !== null) { badge = '回放中'; badgeClass = 'is-replay'; }
    else if (state.finished) {
      if (state.draw) { badge = '平局'; badgeClass = 'is-draw'; }
      else if (isPve()) {
        if (state.winner === state.humanColor) { badge = '你赢了'; badgeClass = 'is-win'; }
        else { badge = 'AI 获胜'; badgeClass = 'is-lose'; }
      } else { badge = (state.winner === BLACK ? '黑方胜' : '白方胜'); badgeClass = 'is-win'; }
    }
    ui.statusBadge.textContent = badge;
    ui.statusBadge.className = 'status-badge ' + badgeClass;
    ui.statusMoves.textContent = '第 ' + viewMoveCount() + ' 手';

    var main = '';
    var sub = '';
    if (state.replayCursor !== null) {
      main = '回放中 · ' + state.replayCursor + ' / ' + state.moves.length + ' 手';
      sub = '点击棋谱或使用方向键逐步查看';
    } else if (state.finished) {
      if (state.draw) { main = '平局，棋盘已下满'; sub = '势均力敌，再来一盘？'; }
      else if (isPve()) {
        main = state.winner === state.humanColor ? '你赢了！' : 'AI 获胜';
        sub = state.winner === state.humanColor ? '漂亮，' + difficultyMeta(state.difficulty).label + '难度也挡不住你' : '换个难度或悔棋再试一次';
      } else {
        main = (state.winner === BLACK ? '黑方' : '白方') + '五连获胜';
        sub = '共 ' + state.moves.length + ' 手';
      }
    } else if (state.thinking) {
      main = 'AI 正在思考';
      sub = difficultyMeta(state.difficulty).label + ' AI · ' + (state.turn === BLACK ? '黑棋' : '白棋') + '行棋';
    } else if (state.hintThinking) {
      main = '正在计算最佳落点';
      sub = '请稍候';
    } else {
      if (isPve()) {
        main = state.turn === state.humanColor ? '轮到你落子' : 'AI 回合';
        sub = (state.turn === BLACK ? '黑棋' : '白棋') + ' · ' + (state.turn === state.humanColor ? '你' : difficultyMeta(state.difficulty).label + ' AI');
      } else {
        main = (state.turn === BLACK ? '黑方' : '白方') + '落子';
        sub = '双人同屏 · 轮流点击棋盘';
      }
    }
    ui.statusMain.textContent = main;
    ui.statusSub.textContent = sub;
    ui.thinkingTime.textContent = state.lastAiMs ? '上一步用时 ' + formatMs(state.lastAiMs) : '';
    ui.thinking.hidden = !(state.thinking || state.hintThinking);
    ui.thinkingBadge.hidden = !(state.thinking || state.hintThinking);
    renderCaption();
  }

  function renderPlayers() {
    var meta = difficultyMeta(state.difficulty);
    var blackIsHuman = isPve() ? state.humanColor === BLACK : true;
    var whiteIsHuman = isPve() ? state.humanColor === WHITE : true;
    ui.nameBlack.textContent = isPve() ? (blackIsHuman ? '你' : meta.label + ' AI') : '黑方';
    ui.nameWhite.textContent = isPve() ? (whiteIsHuman ? '你' : meta.label + ' AI') : '白方';
    ui.playerBlack.classList.toggle('is-active', !state.finished && state.turn === BLACK && state.replayCursor === null);
    ui.playerWhite.classList.toggle('is-active', !state.finished && state.turn === WHITE && state.replayCursor === null);
    ui.playerBlack.classList.toggle('is-human', isPve() && blackIsHuman);
    ui.playerWhite.classList.toggle('is-human', isPve() && whiteIsHuman);
  }

  function renderDifficulty() {
    if (!ui.difficultyList.firstChild) {
      C.DIFFICULTY_KEYS.forEach(function (key) {
        var meta = difficultyMeta(key);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'difficulty-item';
        btn.dataset.level = key;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.innerHTML =
          '<span class="diff-emoji" aria-hidden="true">' + meta.emoji + '</span>' +
          '<span class="diff-name">' + meta.label + '</span>' +
          '<span class="diff-stars" aria-hidden="true">' + '★'.repeat(meta.stars) + '☆'.repeat(6 - meta.stars) + '</span>';
        btn.addEventListener('click', function () {
          if (state.thinking) { toast('AI 正在思考，稍后再切换'); return; }
          state.difficulty = key;
          state.hint = null;
          state.hintAI = null;
          buildAI();
          savePref('difficulty', key);
          renderAll();
          syncHash();
          toast('难度：' + meta.label + (state.finished ? '' : '（下一手生效）'));
        });
        ui.difficultyList.appendChild(btn);
      });
    }
    var meta = difficultyMeta(state.difficulty);
    ui.difficultyTag.textContent = meta.label;
    ui.difficultyDesc.textContent = meta.desc;
    var items = ui.difficultyList.children;
    for (var i = 0; i < items.length; i++) {
      var active = items[i].dataset.level === state.difficulty;
      items[i].classList.toggle('is-active', active);
      items[i].setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  function renderSettingsUI() {
    var modeButtons = ui.modeSwitch.querySelectorAll('.seg');
    for (var i = 0; i < modeButtons.length; i++) {
      modeButtons[i].classList.toggle('is-active', modeButtons[i].dataset.mode === state.mode);
      modeButtons[i].setAttribute('aria-pressed', modeButtons[i].dataset.mode === state.mode ? 'true' : 'false');
    }
    var colorButtons = ui.colorSwitch.querySelectorAll('.seg');
    for (var j = 0; j < colorButtons.length; j++) {
      colorButtons[j].classList.toggle('is-active', Number(colorButtons[j].dataset.color) === state.humanColor);
      colorButtons[j].setAttribute('aria-pressed', Number(colorButtons[j].dataset.color) === state.humanColor ? 'true' : 'false');
    }
    ui.colorSwitch.hidden = !isPve();
    ui.btnHint.disabled = !isPve() || state.finished || state.replayCursor !== null || state.thinking || state.hintThinking;
    ui.btnUndo.disabled = state.moves.length === 0 || state.replayCursor !== null;
    ui.btnResign.disabled = state.finished || state.replayCursor !== null || state.moves.length === 0;
    ui.btnSound.classList.toggle('is-off', !state.sound);
    ui.btnSound.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
  }

  function renderControls() {
    ui.btnUndo.disabled = state.moves.length === 0 || state.replayCursor !== null;
    ui.btnHint.disabled = !isPve() || state.finished || state.replayCursor !== null || state.thinking || state.hintThinking;
    ui.btnResign.disabled = state.finished || state.replayCursor !== null || state.moves.length === 0;
  }

  function renderMoveList() {
    var frag = document.createDocumentFragment();
    var cursor = viewMoveCount();
    for (var i = 0; i < state.moves.length; i++) {
      var mv = state.moves[i];
      var li = document.createElement('li');
      li.className = 'move-item';
      li.dataset.index = String(i);
      if (i === cursor - 1) li.classList.add('is-latest');
      if (state.replayCursor !== null && i >= state.replayCursor) li.classList.add('is-future');
      li.innerHTML =
        '<span class="move-no">' + (i + 1) + '</span>' +
        '<span class="move-stone ' + (mv.player === BLACK ? 'black' : 'white') + '" aria-hidden="true"></span>' +
        '<span class="move-coord">' + C.coordName(mv.x, mv.y) + '</span>';
      frag.appendChild(li);
    }
    ui.moveList.innerHTML = '';
    ui.moveList.appendChild(frag);
    if (state.replayCursor === null) {
      ui.moveList.scrollTop = ui.moveList.scrollHeight;
    }
  }

  function renderReplayBar() {
    var on = state.replayCursor !== null;
    ui.replayBar.hidden = !on;
    if (!on) return;
    ui.replayLabel.textContent = '回放 ' + state.replayCursor + ' / ' + state.moves.length;
    $('btn-replay-first').disabled = state.replayCursor === 0;
    $('btn-replay-prev').disabled = state.replayCursor === 0;
    $('btn-replay-next').disabled = state.replayCursor >= state.moves.length;
    $('btn-replay-last').disabled = state.replayCursor >= state.moves.length;
  }

  function showResult() {
    if (state.replayCursor !== null) return;
    var title = '对局结束';
    var desc = '';
    var emoji = '🏁';
    if (state.draw) {
      title = '平局';
      desc = '棋盘已下满，势均力敌。';
      emoji = '🤝';
    } else if (isPve()) {
      if (state.resigned && state.winner !== state.humanColor) {
        title = '你认输了';
        desc = difficultyMeta(state.difficulty).label + ' AI 获胜 · 共 ' + state.moves.length + ' 手';
        emoji = '🏳️';
      } else if (state.winner === state.humanColor) {
        title = '你赢了！';
        desc = '用 ' + state.moves.length + ' 手击败 ' + difficultyMeta(state.difficulty).label + ' AI';
        emoji = '🎉';
      } else {
        title = 'AI 获胜';
        desc = difficultyMeta(state.difficulty).label + ' AI 在第 ' + state.moves.length + ' 手完成五连';
        emoji = '🤖';
      }
    } else {
      title = (state.winner === BLACK ? '黑方' : '白方') + '获胜';
      desc = '共 ' + state.moves.length + ' 手';
      emoji = '🏆';
    }
    ui.resultTitle.textContent = title;
    ui.resultDesc.textContent = desc;
    ui.resultEmoji.textContent = emoji;
    ui.resultOverlay.hidden = false;
  }

  function hideResult() {
    ui.resultOverlay.hidden = true;
    state.resigned = false;
  }

  function renderCaption() {
    var text;
    if (state.replayCursor !== null) text = '回放中 · ← → 逐步查看 · Esc 退出';
    else if (state.finished) text = state.draw ? '平局 · 棋盘已满' : '对局结束 · 点击「回放这盘」复盘';
    else if (state.thinking) text = 'AI 思考中…';
    else if (state.hintThinking) text = '正在计算最佳落点…';
    else if (isPve()) text = state.turn === state.humanColor ? '轮到你 · 点击交叉点落子' : 'AI 行棋中…';
    else text = (state.turn === BLACK ? '黑方' : '白方') + '落子 · 点击交叉点';
    ui.caption.textContent = text;
  }

  /* ================================================================== *
   * 10. 音效
   * ================================================================== */

  var audioCtx = null;

  function ensureAudio() {
    if (!state.sound) return null;
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  function blip(freq, duration, type, gainValue, delay) {
    var ac = ensureAudio();
    if (!ac) return;
    var t = ac.currentTime + (delay || 0);
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(gainValue || 0.12, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  function playPlaceSound(player) {
    if (!state.sound) return;
    blip(player === BLACK ? 320 : 400, 0.07, 'triangle', 0.1, 0);
    blip(player === BLACK ? 180 : 230, 0.05, 'sine', 0.06, 0.012);
  }

  function playEndSound() {
    if (!state.sound) return;
    var win = state.winner === state.humanColor || state.mode === 'pvp';
    var notes = win ? [523.25, 659.25, 783.99, 1046.5] : [392, 329.63, 261.63];
    notes.forEach(function (f, i) { blip(f, 0.3, 'sine', 0.09, i * 0.13); });
  }

  /* ================================================================== *
   * 11. 事件绑定
   * ================================================================== */

  function bindEvents() {
    // 棋盘
    ui.canvas.addEventListener('pointermove', function (e) {
      var cell = eventToCell(e);
      var hover = null;
      if (cell && canPlaceAt(cell.x, cell.y) && !state.finished && state.replayCursor === null) {
        hover = { x: cell.x, y: cell.y, player: state.turn };
      }
      if ((hover && state.hover && hover.x === state.hover.x && hover.y === state.hover.y) || (!hover && !state.hover)) return;
      state.hover = hover;
      renderBoard();
    });
    ui.canvas.addEventListener('pointerleave', function () {
      if (!state.hover) return;
      state.hover = null;
      renderBoard();
    });
    ui.canvas.addEventListener('click', function (e) {
      var cell = eventToCell(e);
      if (!cell) return;
      handleBoardClick(cell.x, cell.y);
    });
    ui.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // 难度 / 模式 / 执子
    ui.modeSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg');
      if (!btn) return;
      var mode = btn.dataset.mode;
      if (mode === state.mode) return;
      if (state.moves.length && !window.confirm('切换模式会开始新的一局，确定吗？')) return;
      state.mode = mode;
      if (mode === 'pvp') state.humanColor = BLACK;
      savePref('mode', mode);
      resetGame();
    });
    ui.colorSwitch.addEventListener('click', function (e) {
      var btn = e.target.closest('.seg');
      if (!btn) return;
      var color = Number(btn.dataset.color);
      if (color === state.humanColor) return;
      if (state.moves.length && !window.confirm('切换先后手会开始新的一局，确定吗？')) return;
      state.humanColor = color;
      savePref('humanColor', color);
      resetGame();
    });

    // 操作
    ui.btnNew.addEventListener('click', function () {
      if (state.moves.length && !state.finished && !window.confirm('确定放弃当前对局，开始新的一局吗？')) return;
      state.resigned = false;
      resetGame();
    });
    ui.btnUndo.addEventListener('click', undo);
    ui.btnHint.addEventListener('click', hint);
    ui.btnResign.addEventListener('click', resign);
    ui.btnCopyMoves.addEventListener('click', function () { copyText(movesText(), '棋谱已复制'); });

    // 顶栏
    ui.btnShare.addEventListener('click', openShareDialog);
    ui.btnTheme.addEventListener('click', toggleTheme);
    ui.btnSound.addEventListener('click', function () {
      state.sound = !state.sound;
      savePref('sound', state.sound ? '1' : '0');
      if (state.sound) playPlaceSound(BLACK);
      renderSettingsUI();
      toast(state.sound ? '音效已开启' : '音效已关闭');
    });

    // 棋谱
    ui.moveList.addEventListener('click', function (e) {
      var li = e.target.closest('.move-item');
      if (!li) return;
      var index = Number(li.dataset.index);
      startReplay(index + 1);
    });

    // 回放
    $('btn-replay-first').addEventListener('click', function () { setReplayCursor(0); });
    $('btn-replay-prev').addEventListener('click', function () { setReplayCursor((state.replayCursor || 0) - 1); });
    $('btn-replay-next').addEventListener('click', function () { setReplayCursor((state.replayCursor || 0) + 1); });
    $('btn-replay-last').addEventListener('click', function () { setReplayCursor(state.moves.length); });
    $('btn-replay-exit').addEventListener('click', exitReplay);

    // 结算浮层
    ui.btnAgain.addEventListener('click', function () { hideResult(); resetGame(); });
    ui.btnResultReview.addEventListener('click', function () { startReplay(state.moves.length); });
    ui.btnResultClose.addEventListener('click', hideResult);
    ui.resultOverlay.addEventListener('click', function (e) {
      if (e.target === ui.resultOverlay) hideResult();
    });

    // 分享弹窗
    $('btn-share-close').addEventListener('click', closeShareDialog);
    $('btn-copy-link').addEventListener('click', function () { copyText(ui.shareLink.value, '链接已复制'); });
    $('btn-share-native').addEventListener('click', nativeShare);
    $('btn-save-image').addEventListener('click', saveShareImage);
    $('btn-share-text').addEventListener('click', function () { copyText(movesText(), '文字棋谱已复制'); });
    ui.shareDialog.addEventListener('click', function (e) {
      if (e.target === ui.shareDialog) closeShareDialog();
    });
    ui.shareDialog.addEventListener('close', function () {
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search + window.location.hash); } catch (e) { /* 忽略 */ }
    });

    // 键盘
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (ui.shareDialog.open) return;
      var key = e.key.toLowerCase();
      if (state.replayCursor !== null) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); setReplayCursor(state.replayCursor - 1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); setReplayCursor(state.replayCursor + 1); return; }
        if (e.key === 'Escape') { exitReplay(); return; }
        if (e.key === 'Home') { setReplayCursor(0); return; }
        if (e.key === 'End') { setReplayCursor(state.moves.length); return; }
      }
      if (key === 'u') undo();
      else if (key === 'h') hint();
      else if (key === 'n') ui.btnNew.click();
      else if (key === 's') openShareDialog();
      else if (key === 't') toggleTheme();
      else if (key === 'escape') hideResult();
    });

    // 窗口尺寸
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { resizeCanvas(); });
      ro.observe(ui.canvas);
    } else {
      window.addEventListener('resize', resizeCanvas);
    }

    // 链接 hash 变化
    window.addEventListener('hashchange', function () {
      loadFromHash(window.location.hash);
    });

    window.addEventListener('popstate', function () {
      loadFromHash(window.location.hash);
    });

    window.addEventListener('beforeunload', function () {
      if (audioCtx) { try { audioCtx.close(); } catch (e) { /* 忽略 */ } }
    });
  }

  function canPlaceAt(x, y) {
    if (state.finished || state.replayCursor !== null) return false;
    if (state.thinking) return false;
    if (isPve() && state.turn !== state.humanColor) return false;
    return C.isInBounds(x, y) && state.board[C.idx(x, y)] === EMPTY;
  }

  function handleBoardClick(x, y) {
    if (state.replayCursor !== null) { exitReplay(); return; }
    if (state.finished) { hideResult(); return; }
    if (state.thinking) { toast('AI 正在思考…'); return; }
    if (isPve() && state.turn !== state.humanColor) return;
    if (!canPlaceAt(x, y)) return;
    playMove(x, y, {});
  }

  function eventToCell(e) {
    if (!layout.size) return null;
    var rect = ui.canvas.getBoundingClientRect();
    var px = (e.clientX - rect.left) / Math.max(1, rect.width) * layout.size;
    var py = (e.clientY - rect.top) / Math.max(1, rect.height) * layout.size;
    var x = Math.round((px - layout.margin) / layout.cell);
    var y = Math.round((py - layout.margin) / layout.cell);
    if (!C.isInBounds(x, y)) return null;
    var cx = layout.margin + x * layout.cell;
    var cy = layout.margin + y * layout.cell;
    var dist = Math.hypot(px - cx, py - cy);
    if (dist > layout.cell * 0.62) return null;
    return { x: x, y: y };
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    ui.html.dataset.theme = state.theme;
    savePref('theme', state.theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#171310' : '#f5ead8');
    renderBoard();
    toast(state.theme === 'dark' ? '已切换到深色模式' : '已切换到浅色模式');
  }

  /* ================================================================== *
   * 12. 载入 / 初始化
   * ================================================================== */

  function loadFromHash(hash) {
    var text = (hash || '').trim();
    if (!text || text === '#') {
      resetGame();
      return;
    }
    var decoded = C.decodeState(text);
    if (!decoded.ok) {
      skipLoadToast = true;
      toast('分享链接无效：' + decoded.error, 3200);
      resetGame();
      return;
    }
    cancelPendingAI();
    hideResult();
    state.mode = decoded.mode;
    state.difficulty = decoded.difficulty;
    state.humanColor = decoded.humanColor;
    state.aiSeed = randomSeed();
    state.hint = null;
    state.hintAI = null;
    state.replayCursor = null;
    state.moves = decoded.moves.map(function (m) { return { x: m.x, y: m.y, player: m.player }; });
    rebuild();
    buildAI();
    stopAnim();
    renderAll();
    if (decoded.finished) {
      state.resigned = false;
      setTimeout(function () { if (state.finished) showResult(); }, 600);
    } else if (isPve() && state.turn !== state.humanColor) {
      scheduleAI(600);
    }
    if (skipLoadToast) {
      skipLoadToast = false;
    } else {
      toast('已载入分享的对局 · 共 ' + state.moves.length + ' 手', 2600);
    }
  }

  function init() {
    state.theme = loadPref('theme', window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    state.sound = loadPref('sound', '1') !== '0';
    state.difficulty = loadPref('difficulty', 'normal');
    if (!C.isDifficultyKey(state.difficulty)) state.difficulty = 'normal';
    state.mode = loadPref('mode', 'pve');
    if (C.MODES.indexOf(state.mode) < 0) state.mode = 'pve';
    var savedColor = Number(loadPref('humanColor', String(BLACK)));
    state.humanColor = savedColor === WHITE ? WHITE : BLACK;
    if (!C.isDifficultyKey(state.difficulty)) state.difficulty = 'normal';
    aiMetaCache = {};
    ui.html.dataset.theme = state.theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#171310' : '#f5ead8');

    bindEvents();
    buildAI();
    if (ui.engineNote) {
      ui.engineNote.textContent = (window.GomokuAI && window.GomokuAI.VERSION)
        ? '自研引擎 v' + window.GomokuAI.VERSION + ' · Alpha-Beta + 威胁搜索'
        : '内置简易引擎（js/ai.js 未加载）';
    }
    resizeCanvas();

    var hash = window.location.hash;
    if (hash && /^#g1\./.test(hash)) {
      loadFromHash(hash);
    } else {
      resetGame();
    }

    // 首帧后再量一次，避免字体加载导致尺寸误差
    setTimeout(resizeCanvas, 120);
    window.addEventListener('load', function () { setTimeout(resizeCanvas, 60); });
  }

  /* 调试/自动化测试接口（不参与 UI） */
  window.GomokuApp = {
    state: state,
    api: {
      resetGame: resetGame,
      playMove: playMove,
      undo: undo,
      hint: hint,
      startReplay: startReplay,
      exitReplay: exitReplay,
      setReplayCursor: setReplayCursor,
      loadFromHash: loadFromHash,
      syncHash: syncHash,
      encodeCurrent: encodeCurrent,
      shareUrl: shareUrl,
      movesText: movesText,
      buildShareCard: buildShareCard,
      getAiMeta: difficultyMeta,
      setDifficulty: function (key) { state.difficulty = key; buildAI(); renderAll(); },
      attachAI: function (engine) { AI = engine; },
      versions: { fallbackAI: AI === FALLBACK_AI },
      renderTicks: function () { return renderTicks; },
      animActive: function () { return !!anim; }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
