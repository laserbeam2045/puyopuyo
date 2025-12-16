/**
 * ぷよぷよ ビームサーチAI v3 - CNN潜在連鎖評価版
 *
 * 改善点:
 * - CNNによる潜在連鎖数予測を評価関数に組み込み
 * - 探索深度・ビーム幅を増加
 * - 連鎖形状パターンを評価
 */

(function(global) {
  'use strict';

  // ===== 定数 =====
  const COLS = 6;
  const ROWS = 12;
  const HIDDEN_ROWS = 1;
  const TOTAL_ROWS = ROWS + HIDDEN_ROWS;
  const NUM_COLORS = 4;
  const NUM_CHANNELS = 5;  // 4色 + 空
  const NUM_ACTIONS = COLS * 4;
  const MAX_CHAIN = 18;   // 最大連鎖数
  const NUM_CLASSES = MAX_CHAIN + 1;  // 0-18連鎖 = 19クラス（stableとcollapse統合版）

  // ===== ビームサーチ設定 =====
  const BEAM_WIDTH = 40;
  const SEARCH_DEPTH = 3;

  // ===== CNNモデル =====
  let potentialModel = null;
  let modelLoading = false;
  let modelLoadError = null;
  let useCNN = true;  // CNNを使用するかどうか

  // ===== 評価関数の重み（連鎖構築重視）=====
  const EVAL_WEIGHTS = {
    // CNN関連
    CNN_POTENTIAL: 500,            // CNN予測の潜在連鎖スコア
    // 連鎖関連（最重要）
    CHAIN_POWER: 100,              // 連鎖数のべき乗評価
    CHAIN_POTENTIAL_1: 20,         // 1手で消せる連鎖
    CHAIN_POTENTIAL_2: 50,         // 2段階連鎖ポテンシャル
    CHAIN_POTENTIAL_3: 80,         // 3段階連鎖ポテンシャル

    // 連鎖形状（重要）
    SAME_COLOR_ABOVE: 15,          // 上に同色がある（連鎖の種）
    VERTICAL_PAIR: 8,              // 縦に2連結
    TRIGGER_READY: 25,             // 発火点が準備できている

    // 盤面形状
    HEIGHT_PENALTY: -2,
    MAX_HEIGHT_PENALTY: -5,        // 最大高さへの追加ペナルティ
    VALLEY_PENALTY: -20,
    DEATH_COLUMN_PENALTY: -100,    // 殺し列は致命的

    // ぷよ配置
    CONNECTIVITY_2: 3,
    CONNECTIVITY_3: 12,            // 3連結を重視
    ISOLATED_PENALTY: -8,

    // 形状
    FLATNESS_BONUS: 2,
    STAIR_BONUS: 8,                // 階段形状を重視
    EDGE_STACK_BONUS: 5,           // 端から積むボーナス
  };

  // ===== ゲーム状態のクラス =====
  class GameState {
    constructor() {
      this.board = [];
      for (let r = 0; r < TOTAL_ROWS; r++) {
        this.board.push(new Array(COLS).fill(-1));
      }
      this.currentPuyo = null;
      this.nextPuyo = null;
      this.gameOver = false;
    }

    static fromBoard(board, currentPuyo, nextPuyo, colorToIndex) {
      const state = new GameState();

      for (let r = 0; r < TOTAL_ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (board[r] && board[r][c]) {
            const colorIdx = colorToIndex[board[r][c]];
            state.board[r][c] = colorIdx !== undefined ? colorIdx : -1;
          } else {
            state.board[r][c] = -1;
          }
        }
      }

      if (currentPuyo) {
        state.currentPuyo = {
          main: colorToIndex[currentPuyo.main],
          sub: colorToIndex[currentPuyo.sub]
        };
      }

      if (nextPuyo) {
        state.nextPuyo = {
          main: colorToIndex[nextPuyo.main],
          sub: colorToIndex[nextPuyo.sub]
        };
      }

      return state;
    }

    clone() {
      const state = new GameState();
      state.board = this.board.map(row => [...row]);
      state.currentPuyo = this.currentPuyo ? { ...this.currentPuyo } : null;
      state.nextPuyo = this.nextPuyo ? { ...this.nextPuyo } : null;
      state.gameOver = this.gameOver;
      return state;
    }

    getColumnHeight(col) {
      for (let r = 0; r < TOTAL_ROWS; r++) {
        if (this.board[r][col] !== -1) {
          return TOTAL_ROWS - r;
        }
      }
      return 0;
    }

    isValidPlacement(col, rotation) {
      const offsets = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const offset = offsets[rotation];
      const mainCol = col;
      const subCol = col + offset[0];

      if (mainCol < 0 || mainCol >= COLS) return false;
      if (subCol < 0 || subCol >= COLS) return false;

      const mainHeight = this.getColumnHeight(mainCol);
      const subHeight = this.getColumnHeight(subCol);

      // 隠し行（インデックス0）への配置を禁止するため、ROWSを使用
      if (mainCol === subCol) {
        return mainHeight + 2 <= ROWS;
      }
      return mainHeight + 1 <= ROWS && subHeight + 1 <= ROWS;
    }

    getValidActions() {
      const valid = [];
      for (let action = 0; action < NUM_ACTIONS; action++) {
        const col = action % COLS;
        const rotation = Math.floor(action / COLS);
        if (this.isValidPlacement(col, rotation)) {
          valid.push(action);
        }
      }
      return valid;
    }

    step(action) {
      if (this.gameOver || !this.currentPuyo) {
        return { done: true, chainCount: 0, score: 0 };
      }

      const col = action % COLS;
      const rotation = Math.floor(action / COLS);

      if (!this.isValidPlacement(col, rotation)) {
        return { done: false, chainCount: 0, score: 0, invalid: true };
      }

      this.placePuyo(col, rotation);
      const { chainCount, score } = this.processChains();

      if (this.board[0][2] !== -1 || this.board[1][2] !== -1) {
        this.gameOver = true;
      }

      if (!this.gameOver && this.nextPuyo) {
        this.currentPuyo = this.nextPuyo;
        this.nextPuyo = null;
      }

      return { done: this.gameOver, chainCount, score };
    }

    placePuyo(col, rotation) {
      const offsets = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const offset = offsets[rotation];
      const mainCol = col;
      const subCol = col + offset[0];

      const findDropRow = (c) => {
        for (let r = TOTAL_ROWS - 1; r >= 0; r--) {
          if (this.board[r][c] === -1) return r;
        }
        return -1;
      };

      if (rotation === 2) {
        const subRow = findDropRow(subCol);
        if (subRow >= 0) this.board[subRow][subCol] = this.currentPuyo.sub;
        const mainRow = mainCol === subCol ? subRow - 1 : findDropRow(mainCol);
        if (mainRow >= 0) this.board[mainRow][mainCol] = this.currentPuyo.main;
      } else if (rotation === 0) {
        const mainRow = findDropRow(mainCol);
        if (mainRow >= 0) this.board[mainRow][mainCol] = this.currentPuyo.main;
        const subRow = mainCol === subCol ? mainRow - 1 : findDropRow(subCol);
        if (subRow >= 0) this.board[subRow][subCol] = this.currentPuyo.sub;
      } else {
        const mainRow = findDropRow(mainCol);
        const subRow = findDropRow(subCol);
        if (mainRow >= 0) this.board[mainRow][mainCol] = this.currentPuyo.main;
        if (subRow >= 0) this.board[subRow][subCol] = this.currentPuyo.sub;
      }
    }

    processChains() {
      let chainCount = 0;
      let totalScore = 0;

      while (true) {
        this.applyGravity();
        const popResult = this.popGroups();
        if (popResult.poppedCount === 0) break;

        chainCount++;
        totalScore += this.calculateChainScore(popResult.poppedCount, chainCount);
      }

      return { chainCount, score: totalScore };
    }

    calculateChainScore(poppedCount, chainCount) {
      const CHAIN_BONUS = [0, 0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256];
      const baseScore = poppedCount * 10;
      const chainBonus = chainCount < CHAIN_BONUS.length ? CHAIN_BONUS[chainCount] : 256;
      return baseScore * Math.max(1, chainBonus);
    }

    applyGravity() {
      let changed = true;
      while (changed) {
        changed = false;
        for (let c = 0; c < COLS; c++) {
          for (let r = TOTAL_ROWS - 2; r >= 0; r--) {
            if (this.board[r][c] !== -1 && this.board[r + 1][c] === -1) {
              this.board[r + 1][c] = this.board[r][c];
              this.board[r][c] = -1;
              changed = true;
            }
          }
        }
      }
    }

    popGroups() {
      const visited = [];
      for (let r = 0; r < TOTAL_ROWS; r++) {
        visited.push(new Array(COLS).fill(false));
      }

      const groups = [];

      const floodFill = (r, c, color, group) => {
        if (r < 0 || r >= TOTAL_ROWS || c < 0 || c >= COLS) return;
        if (visited[r][c] || this.board[r][c] !== color) return;
        visited[r][c] = true;
        group.push([r, c]);
        floodFill(r - 1, c, color, group);
        floodFill(r + 1, c, color, group);
        floodFill(r, c - 1, color, group);
        floodFill(r, c + 1, color, group);
      };

      for (let r = 0; r < TOTAL_ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (!visited[r][c] && this.board[r][c] !== -1) {
            const group = [];
            const color = this.board[r][c];
            floodFill(r, c, color, group);
            if (group.length >= 4) {
              groups.push(group);
            }
          }
        }
      }

      let poppedCount = 0;
      for (const group of groups) {
        for (const [r, c] of group) {
          this.board[r][c] = -1;
          poppedCount++;
        }
      }

      return { poppedCount, groups };
    }

    // 連結グループを取得（消さない）
    getConnectedGroups() {
      const visited = [];
      for (let r = 0; r < TOTAL_ROWS; r++) {
        visited.push(new Array(COLS).fill(false));
      }

      const groups = [];

      const floodFill = (r, c, color, group) => {
        if (r < 0 || r >= TOTAL_ROWS || c < 0 || c >= COLS) return;
        if (visited[r][c] || this.board[r][c] !== color) return;
        visited[r][c] = true;
        group.push([r, c]);
        floodFill(r - 1, c, color, group);
        floodFill(r + 1, c, color, group);
        floodFill(r, c - 1, color, group);
        floodFill(r, c + 1, color, group);
      };

      for (let r = 0; r < TOTAL_ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (!visited[r][c] && this.board[r][c] !== -1) {
            const group = [];
            const color = this.board[r][c];
            floodFill(r, c, color, group);
            groups.push({ color, cells: group, size: group.length });
          }
        }
      }

      return groups;
    }
  }

  // ===== 盤面がstable（4連結以上がない）かどうか判定 =====
  function isStableBoard(state) {
    const groups = state.getConnectedGroups();
    for (const group of groups) {
      if (group.size >= 4) {
        return false;  // 4連結以上があればcollapse（不安定）
      }
    }
    return true;  // 4連結以上がなければstable（安定）
  }

  // ===== 盤面評価関数（CNN使用時とフォールバック）=====
  function evaluateBoard(state) {
    // CNNが使用可能かつ安定盤面ならCNN評価を使用
    if (useCNN && potentialModel && isStableBoard(state)) {
      return evaluateBoardWithCNN(state);
    }
    // フォールバック: 基本評価 + 手動の潜在連鎖評価
    return evaluateBoardFallback(state);
  }

  function evaluateBoardFallback(state) {
    if (state.gameOver) {
      return -1000000;
    }

    let score = evaluateBoardBase(state);

    // CNNがない場合は手動の潜在連鎖評価を追加
    score += evaluateChainPotentialDeep(state);

    return score;
  }

  // 連鎖パターン評価（上に同色があるか等）
  function evaluateChainPatterns(state) {
    let score = 0;

    // 各セルの上に同色があるかチェック
    for (let c = 0; c < COLS; c++) {
      const columnColors = [];
      for (let r = TOTAL_ROWS - 1; r >= 0; r--) {
        if (state.board[r][c] !== -1) {
          columnColors.push({ r, color: state.board[r][c] });
        }
      }

      // 同じ列で離れた位置に同色がある = 連鎖の種
      for (let i = 0; i < columnColors.length; i++) {
        for (let j = i + 1; j < columnColors.length; j++) {
          if (columnColors[i].color === columnColors[j].color) {
            const gap = columnColors[j].r - columnColors[i].r - 1;
            if (gap >= 1 && gap <= 3) {
              score += EVAL_WEIGHTS.SAME_COLOR_ABOVE;
            }
          }
        }
      }
    }

    // 3連結の位置を見て発火点を評価
    const groups = state.getConnectedGroups();
    for (const group of groups) {
      if (group.size === 3) {
        // 3連結の上にぷよがあるか（消えたら落ちてくる）
        for (const [r, c] of group.cells) {
          for (let checkR = r - 1; checkR >= 0; checkR--) {
            if (state.board[checkR][c] !== -1 && state.board[checkR][c] !== group.color) {
              score += EVAL_WEIGHTS.TRIGGER_READY;
              break;
            }
          }
        }
      }
    }

    // 縦2連結を評価（連鎖しやすい）
    for (let c = 0; c < COLS; c++) {
      for (let r = TOTAL_ROWS - 1; r > 0; r--) {
        if (state.board[r][c] !== -1 && state.board[r][c] === state.board[r - 1][c]) {
          score += EVAL_WEIGHTS.VERTICAL_PAIR;
        }
      }
    }

    return score;
  }

  // 多段階の潜在連鎖評価（大連鎖に高報酬）
  function evaluateChainPotentialDeep(state) {
    let maxPotential = 0;

    // 各列×各色で1つ追加したときの連鎖をシミュレート
    for (let c = 0; c < COLS; c++) {
      const height = state.getColumnHeight(c);
      if (height >= TOTAL_ROWS - 1) continue;

      const dropRow = TOTAL_ROWS - height - 1;
      if (dropRow < 0) continue;

      for (let color = 0; color < NUM_COLORS; color++) {
        const testState = state.clone();
        testState.board[dropRow][c] = color;

        const { chainCount } = testState.processChains();

        if (chainCount >= 1) {
          // 連鎖数の3乗で指数的に増加
          let potential = Math.pow(chainCount, 2.5) * EVAL_WEIGHTS.CHAIN_POTENTIAL_1;

          // 大連鎖にはさらにボーナス
          if (chainCount >= 4) potential *= 2;
          if (chainCount >= 5) potential *= 2;

          if (potential > maxPotential) {
            maxPotential = potential;
          }
        }
      }
    }

    return maxPotential;
  }

  // ===== CNN評価関数 =====
  // 盤面をone-hot encodingに変換
  function boardToTensor(state) {
    if (typeof tf === 'undefined') return null;

    const data = [];
    for (let r = 0; r < TOTAL_ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const color = state.board[r][c];
        const channels = [];
        for (let ch = 0; ch < NUM_COLORS; ch++) {
          channels.push(color === ch ? 1.0 : 0.0);
        }
        channels.push(color === -1 ? 1.0 : 0.0);  // 空チャンネル
        row.push(channels);
      }
      data.push(row);
    }
    return tf.tensor4d([data]);
  }

  // CNNで潜在連鎖数を予測（統合分類モデル版）
  // 返り値: { potentialChain: 期待連鎖数, predictedClass: 最確クラス, confidence: 確信度 }
  function predictPotentialCNN(state) {
    if (!potentialModel || typeof tf === 'undefined') {
      return null;
    }

    try {
      const inputTensor = boardToTensor(state);
      if (!inputTensor) return null;

      const prediction = potentialModel.predict(inputTensor);
      const probs = prediction.dataSync();

      inputTensor.dispose();
      prediction.dispose();

      // 期待連鎖数を計算（各クラス = 連鎖数）
      let expectedChain = 0;
      let maxProb = 0;
      let maxClass = 0;
      for (let i = 0; i < NUM_CLASSES; i++) {
        expectedChain += i * probs[i];
        if (probs[i] > maxProb) {
          maxProb = probs[i];
          maxClass = i;
        }
      }

      return {
        potentialChain: expectedChain,
        predictedClass: maxClass,
        confidence: maxProb
      };
    } catch (e) {
      console.error('CNN prediction error:', e);
      return null;
    }
  }

  // CNN評価を含めた盤面評価
  function evaluateBoardWithCNN(state) {
    // 基本評価
    let score = evaluateBoardBase(state);

    // CNN評価を追加
    if (useCNN && potentialModel) {
      const cnnResult = predictPotentialCNN(state);
      if (cnnResult !== null) {
        // 潜在連鎖数をスコアに加算（2乗でスケーリング）
        score += Math.pow(cnnResult.potentialChain, 2) * EVAL_WEIGHTS.CNN_POTENTIAL / 100;
      }
    }

    return score;
  }

  // 盤面のぷよ数をカウント
  function countPuyos(state) {
    let count = 0;
    for (let r = 0; r < TOTAL_ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (state.board[r][c] !== -1) {
          count++;
        }
      }
    }
    return count;
  }

  // 潜在連鎖効率を計算（潜在連鎖数 / ぷよ数）
  // 高いほど効率的な盤面（少ないぷよで大きな連鎖が期待できる）
  function calculateChainEfficiency(state) {
    const puyoCount = countPuyos(state);
    if (puyoCount === 0) return 0;

    // CNN予測を使用
    let potentialChain = 0;
    if (useCNN && potentialModel) {
      const result = predictPotentialCNN(state);
      if (result !== null) {
        potentialChain = result.predictedChain;
      }
    }

    // 効率 = 潜在連鎖数 / (ぷよ数 / 4)
    // 4で割るのは、1連鎖に最低4個必要なため
    // 効率1.0 = ぷよ数に見合った連鎖数
    // 効率2.0 = ぷよ数の2倍の連鎖効率（とても良い形）
    return potentialChain / (puyoCount / 4);
  }

  // 盤面の危険度を計算（0.0〜1.0）
  function calculateDanger(state) {
    const heights = [];
    for (let c = 0; c < COLS; c++) {
      heights.push(state.getColumnHeight(c));
    }
    const maxHeight = Math.max(...heights);
    const deathColumnHeight = heights[2];

    let danger = 0;
    if (maxHeight >= 8) {
      danger += (maxHeight - 7) * 0.15;
    }
    if (deathColumnHeight >= 6) {
      danger += (deathColumnHeight - 5) * 0.2;
    }
    return Math.min(1.0, danger);
  }

  // 基本盤面評価（CNN以外）
  function evaluateBoardBase(state) {
    if (state.gameOver) {
      return -1000000;
    }

    let score = 0;

    // === 高さ関連 ===
    const heights = [];
    for (let c = 0; c < COLS; c++) {
      heights.push(state.getColumnHeight(c));
    }
    const maxHeight = Math.max(...heights);
    const avgHeight = heights.reduce((a, b) => a + b, 0) / COLS;

    score += EVAL_WEIGHTS.HEIGHT_PENALTY * avgHeight;
    if (maxHeight > 8) {
      score += EVAL_WEIGHTS.MAX_HEIGHT_PENALTY * (maxHeight - 8) * 2;
    }

    // 殺し列ペナルティ
    const deathColumnHeight = heights[2];
    if (deathColumnHeight > 5) {
      score += EVAL_WEIGHTS.DEATH_COLUMN_PENALTY * (deathColumnHeight - 5);
    }

    // 谷ペナルティ
    for (let c = 1; c < COLS - 1; c++) {
      const valleyDepth = Math.min(heights[c - 1], heights[c + 1]) - heights[c];
      if (valleyDepth >= 2) {
        score += EVAL_WEIGHTS.VALLEY_PENALTY * valleyDepth;
      }
    }

    // === 連結評価 ===
    const groups = state.getConnectedGroups();
    let isolatedCount = 0;
    let twoConnected = 0;
    let threeConnected = 0;

    for (const group of groups) {
      if (group.size === 1) {
        isolatedCount++;
      } else if (group.size === 2) {
        twoConnected++;
      } else if (group.size === 3) {
        threeConnected++;
      }
    }

    score += EVAL_WEIGHTS.ISOLATED_PENALTY * isolatedCount;
    score += EVAL_WEIGHTS.CONNECTIVITY_2 * twoConnected;
    score += EVAL_WEIGHTS.CONNECTIVITY_3 * threeConnected;

    // === 連鎖形状評価 ===
    score += evaluateChainPatterns(state);

    // === 形状ボーナス ===
    for (let c = 0; c < COLS - 1; c++) {
      const diff = Math.abs(heights[c] - heights[c + 1]);
      if (diff <= 1) {
        score += EVAL_WEIGHTS.FLATNESS_BONUS;
      }
    }

    // 階段形状
    let leftStair = true;
    let rightStair = true;
    for (let c = 0; c < COLS - 1; c++) {
      if (heights[c] < heights[c + 1]) leftStair = false;
      if (heights[COLS - 1 - c] < heights[COLS - 2 - c]) rightStair = false;
    }
    if (leftStair || rightStair) {
      score += EVAL_WEIGHTS.STAIR_BONUS * 3;
    }

    // 端積みボーナス
    if (heights[0] >= heights[2] || heights[5] >= heights[3]) {
      score += EVAL_WEIGHTS.EDGE_STACK_BONUS * 2;
    }

    return score;
  }

  // 軽量盤面評価（中間ノード用）
  function evaluateBoardLight(state) {
    if (state.gameOver) return -100000;

    let score = 0;
    const heights = [];
    for (let c = 0; c < COLS; c++) {
      heights.push(state.getColumnHeight(c));
    }

    const avgHeight = heights.reduce((a, b) => a + b, 0) / COLS;
    score += EVAL_WEIGHTS.HEIGHT_PENALTY * avgHeight;

    // 殺し列
    if (heights[2] > 5) {
      score += EVAL_WEIGHTS.DEATH_COLUMN_PENALTY * (heights[2] - 5);
    }

    // 3連結ボーナス
    const groups = state.getConnectedGroups();
    for (const group of groups) {
      if (group.size === 3) {
        score += EVAL_WEIGHTS.CONNECTIVITY_3;
      }
    }

    // 簡易潜在連鎖評価
    for (let c = 0; c < COLS; c++) {
      const height = state.getColumnHeight(c);
      if (height >= TOTAL_ROWS - 1) continue;
      const dropRow = TOTAL_ROWS - height - 1;
      if (dropRow < 0) continue;

      for (let color = 0; color < NUM_COLORS; color++) {
        const testState = state.clone();
        testState.board[dropRow][c] = color;
        const { chainCount } = testState.processChains();
        if (chainCount >= 2) {
          score += EVAL_WEIGHTS.CHAIN_POTENTIAL_1 * chainCount;
          break;
        }
      }
    }

    return score;
  }

  // ===== ビームサーチ =====
  function beamSearch(state, depth = SEARCH_DEPTH, beamWidth = BEAM_WIDTH) {
    let beam = [{
      state: state.clone(),
      actions: [],
      totalChainScore: 0,
      maxChain: 0
    }];

    for (let d = 0; d < depth; d++) {
      const candidates = [];

      for (const node of beam) {
        if (node.state.gameOver) {
          candidates.push({
            ...node,
            finalScore: node.totalChainScore + evaluateBoard(node.state)
          });
          continue;
        }

        const validActions = node.state.getValidActions();

        for (const action of validActions) {
          const newState = node.state.clone();
          const result = newState.step(action);

          if (result.invalid) continue;

          // 連鎖スコア（10連鎖以上に指数的報酬）
          let chainScore = 0;
          if (result.chainCount >= 10) {
            // 10連鎖以上：指数的ボーナス
            chainScore = Math.pow(result.chainCount, 3) * EVAL_WEIGHTS.CHAIN_POWER;
          }
          // 9連鎖以下：報酬もペナルティもなし（CNNの盤面評価に任せる）

          const newMaxChain = Math.max(node.maxChain, result.chainCount);

          candidates.push({
            state: newState,
            actions: [...node.actions, action],
            totalChainScore: node.totalChainScore + chainScore,
            maxChain: newMaxChain
          });
        }
      }

      if (candidates.length === 0) break;

      const isLastDepth = (d === depth - 1);

      // CNNは最終深度の上位候補のみで評価（速度最適化）
      // まず軽量評価でソート
      for (const candidate of candidates) {
        if (candidate.state.gameOver) {
          candidate.finalScore = candidate.totalChainScore - 1000000;
        } else if (isLastDepth) {
          // 最終深度: フォールバック評価を使用
          candidate.finalScore = candidate.totalChainScore + evaluateBoardFallback(candidate.state);
        } else {
          candidate.finalScore = candidate.totalChainScore + evaluateBoardLight(candidate.state);
        }
      }

      // 最終深度でCNNがある場合、上位候補のみCNN再評価
      if (isLastDepth && useCNN && potentialModel) {
        candidates.sort((a, b) => b.finalScore - a.finalScore);
        const topCandidates = candidates.slice(0, Math.min(10, beamWidth));
        for (const candidate of topCandidates) {
          // stable盤面の場合のみCNN評価を適用
          if (!candidate.state.gameOver && isStableBoard(candidate.state)) {
            const cnnResult = predictPotentialCNN(candidate.state);
            if (cnnResult !== null) {
              // 潜在連鎖数をスコアに加算
              candidate.finalScore += Math.pow(cnnResult.potentialChain, 2) * EVAL_WEIGHTS.CNN_POTENTIAL / 100;
            }
          }
        }
      }

      candidates.sort((a, b) => b.finalScore - a.finalScore);
      beam = candidates.slice(0, beamWidth);
    }

    if (beam.length > 0 && beam[0].actions.length > 0) {
      return {
        action: beam[0].actions[0],
        score: beam[0].finalScore,
        maxChain: beam[0].maxChain
      };
    }

    const validActions = state.getValidActions();
    return {
      action: validActions.length > 0 ? validActions[0] : 0,
      score: 0,
      maxChain: 0
    };
  }

  // ===== メインAPI =====
  const PuyoAI = {
    // CNNモデルをロード
    async loadModel(modelPath = './model_potential/model.json') {
      if (modelLoading) {
        console.log('Model is already loading...');
        return false;
      }

      if (typeof tf === 'undefined') {
        console.warn('TensorFlow.js not loaded, CNN evaluation disabled');
        useCNN = false;
        return false;
      }

      modelLoading = true;
      modelLoadError = null;

      try {
        console.log('Loading potential CNN model from:', modelPath);
        potentialModel = await tf.loadLayersModel(modelPath);
        console.log('CNN model loaded successfully');
        useCNN = true;
        modelLoading = false;
        return true;
      } catch (e) {
        console.warn('Failed to load CNN model:', e.message);
        modelLoadError = e;
        potentialModel = null;
        useCNN = false;
        modelLoading = false;
        return false;
      }
    },

    // モデルの状態を取得
    getModelStatus() {
      return {
        loaded: potentialModel !== null,
        loading: modelLoading,
        error: modelLoadError ? modelLoadError.message : null,
        useCNN: useCNN
      };
    },

    // CNNの使用を切り替え
    setUseCNN(enabled) {
      useCNN = enabled && potentialModel !== null;
      return useCNN;
    },

    findBestMove(board, currentPuyo, nextPuyo, colorToIndex) {
      try {
        const state = GameState.fromBoard(board, currentPuyo, nextPuyo, colorToIndex);
        const result = beamSearch(state);

        const col = result.action % COLS;
        const rotation = Math.floor(result.action / COLS);

        return {
          col: col,
          rotation: rotation,
          score: result.score,
          action: result.action
        };
      } catch (e) {
        console.error('PuyoAI.findBestMove error:', e);
        return { col: 2, rotation: 0, score: 0, action: 8 };
      }
    },

    getGhostPositions(board, placement, currentPuyo) {
      if (!placement || !currentPuyo) return [];

      const col = placement.col;
      const rotation = placement.rotation;

      // 範囲チェック
      if (col < 0 || col >= COLS || rotation < 0 || rotation >= 4) return [];

      const offsets = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      const offset = offsets[rotation];

      const mainC = col;
      const subC = col + offset[0];

      // subCの範囲チェック
      if (subC < 0 || subC >= COLS) return [];

      const findDropRow = (c) => {
        if (c < 0 || c >= COLS) return -1;
        // HIDDEN_ROWS以上の行のみを対象とする（row 0は非表示行）
        for (let r = TOTAL_ROWS - 1; r >= HIDDEN_ROWS; r--) {
          if (!board[r] || !board[r][c]) return r;
        }
        return -1;
      };

      const mainDropR = findDropRow(mainC);
      const subDropR = findDropRow(subC);

      // 有効な行が見つからない場合は空配列を返す
      if (mainDropR < HIDDEN_ROWS || subDropR < HIDDEN_ROWS) return [];

      const positions = [];

      if (rotation === 2) {
        positions.push({ r: subDropR, c: subC, color: currentPuyo.sub });
        const mainR = (mainC === subC) ? subDropR - 1 : mainDropR;
        // 隠し行より上の位置のみ許可
        if (mainR >= HIDDEN_ROWS) {
          positions.push({ r: mainR, c: mainC, color: currentPuyo.main });
        }
      } else if (rotation === 0) {
        positions.push({ r: mainDropR, c: mainC, color: currentPuyo.main });
        const subR = (mainC === subC) ? mainDropR - 1 : subDropR;
        // 隠し行より上の位置のみ許可
        if (subR >= HIDDEN_ROWS) {
          positions.push({ r: subR, c: subC, color: currentPuyo.sub });
        }
      } else {
        positions.push({ r: mainDropR, c: mainC, color: currentPuyo.main });
        positions.push({ r: subDropR, c: subC, color: currentPuyo.sub });
      }

      return positions;
    },

    config: {
      BEAM_WIDTH,
      SEARCH_DEPTH,
      COLS,
      ROWS,
      TOTAL_ROWS
    }
  };

  global.PuyoAI = PuyoAI;

})(typeof window !== 'undefined' ? window : global);
