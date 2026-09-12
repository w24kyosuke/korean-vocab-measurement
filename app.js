/**
 * 한국어 어휘력 측정 퀴즈 앱 - 메인 애플리케이션
 *
 * 기능:
 * - 4지선다 + 모름 퀴즈
 * - localStorage 기반 해답 기록 영구 저장
 * - 분류별 통계 (품사, 난이도, 어종, 주제/장면)
 * - 단어 검색 및 리셋
 * - 출제 범위 설정
 */

(function () {
  "use strict";

  // ============================================================
  // 전역 상태
  // ============================================================
  const STORAGE_KEY = "korean-vocab-quiz-records";
  const SETTINGS_KEY = "korean-vocab-quiz-settings";

  let allWords = []; // data/words.json 전체
  let similarityMap = {}; // data/similarity_map.json 전체
  let records = {}; // { word_id: { status: "correct"|"wrong"|"unknown", ts: number } }
  let settings = {
    levels: { 초급: true, 중급: true, 고급: true, 없음: true },
    pos: { 명사: true, 동사: true, 형용사: true },
    wordTypes: { 고유어: true, 한자어: true, 외래어: true, 혼종어: true },
  };

  // word_id → word 객체 매핑
  let wordById = {};

  // 현재 퀴즈 상태
  let currentQuiz = null;
  let quizAnswered = false;

  // 현재 통계 세그먼트
  let currentStatSegment = "pos";

  // 현재 검색 필터
  let currentSearchFilter = "all";
  let currentSearchQuery = "";
  let currentAdvFilters = {
    pos: "all",
    level: "all",
    wtype: "all"
  };

  // 퀴즈 자동 넘김 타이머
  let autoNextTimeout = null;
  let lastQuizState = null;

  // 검색 결과 가상 스크롤용
  let filteredSearchResults = [];
  let searchRenderLimit = 100;

  // ============================================================
  // 초기화
  // ============================================================
  async function init() {
    loadRecords();
    loadSettings();
    bindEvents();
    await loadData();
    applySettingsToUI();
    startQuiz();
  }

  async function loadData() {
    try {
      const [wordsRes, simRes] = await Promise.all([
        fetch("data/words.json"),
        fetch("data/similarity_map.json"),
      ]);

      if (!wordsRes.ok) throw new Error("words.json 로드 실패");
      if (!simRes.ok) throw new Error("similarity_map.json 로드 실패");

      allWords = await wordsRes.json();
      similarityMap = await simRes.json();

      // word_id 매핑 구축
      for (const w of allWords) {
        wordById[w.word_id] = w;
      }

      document.getElementById("quiz-loading").classList.add("hidden");
      document.getElementById("quiz-body").classList.remove("hidden");
    } catch (err) {
      document.getElementById("quiz-loading").innerHTML =
        '<p class="loading-text" style="color:var(--system-red)">' +
        "데이터 로드에 실패했습니다.<br>" +
        err.message +
        "</p>";
      console.error(err);
    }
  }

  // ============================================================
  // localStorage 관리
  // ============================================================
  function loadRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) records = JSON.parse(raw);
    } catch {
      records = {};
    }
  }

  function saveRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // 병합 (누락 키 방지)
        if (saved.levels) Object.assign(settings.levels, saved.levels);
        if (saved.pos) Object.assign(settings.pos, saved.pos);
        if (saved.wordTypes) Object.assign(settings.wordTypes, saved.wordTypes);
        if (saved.quiz) Object.assign(settings.quiz, saved.quiz);
      }
    } catch {
      // 기본값 사용
    }
    // 기본값 보장
    if (!settings.quiz) settings.quiz = { autonext: false };
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function applySettingsToUI() {
    document.querySelectorAll("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      const [category, value] = key.split("-");
      if (category === "level") input.checked = !!settings.levels[value];
      else if (category === "pos") input.checked = !!settings.pos[value];
      else if (category === "wtype") input.checked = !!settings.wordTypes[value];
      else if (category === "quiz") input.checked = !!settings.quiz[value];
    });
  }

  // ============================================================
  // 이벤트 바인딩
  // ============================================================
  function bindEvents() {
    // 탭 전환
    document.querySelectorAll(".tab-bar-item").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // 퀴즈 버튼
    document
      .getElementById("quiz-unknown-btn")
      .addEventListener("click", handleUnknown);
    document
      .getElementById("quiz-next-btn")
      .addEventListener("click", nextQuiz);
    document
      .getElementById("quiz-undo-btn")
      .addEventListener("click", undoLastQuiz);

    // 통계 세그먼트
    document.querySelectorAll("#stats-segment .segment-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("#stats-segment .segment-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentStatSegment = btn.dataset.segment;
        renderStatsDetail();
      });
    });

    // 검색 입력
    const searchInput = document.getElementById("search-input");
    const searchClearBtn = document.getElementById("search-clear-btn");
    
    searchInput.addEventListener("input", (e) => {
      currentSearchQuery = e.target.value.trim();
      
      if (currentSearchQuery.length > 0) {
        searchClearBtn.classList.remove("hidden");
      } else {
        searchClearBtn.classList.add("hidden");
      }
      
      searchRenderLimit = 100;
      renderSearchResults();
    });

    searchClearBtn.addEventListener("click", () => {
      searchInput.value = "";
      currentSearchQuery = "";
      searchClearBtn.classList.add("hidden");
      searchRenderLimit = 100;
      renderSearchResults();
      searchInput.focus();
    });

    // 상세 조건 패널 토글
    document.getElementById("search-adv-toggle").addEventListener("click", () => {
      const panel = document.getElementById("search-adv-panel");
      panel.classList.toggle("hidden");
    });

    // 상세 조건 세그먼트
    document.querySelectorAll(".search-adv-panel .segment-control").forEach((control) => {
      control.querySelectorAll(".segment-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          control.querySelectorAll(".segment-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const type = control.id.split("-").pop(); // pos, level, wtype
          currentAdvFilters[type] = btn.dataset.val;
          searchRenderLimit = 100;
          renderSearchResults();
        });
      });
    });

    // 검색 필터 칩
    document.querySelectorAll("#search-filters .filter-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document
          .querySelectorAll("#search-filters .filter-chip")
          .forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        currentSearchFilter = chip.dataset.filter;
        searchRenderLimit = 100;
        renderSearchResults();
      });
    });

    // 일괄 리셋 버튼
    document.getElementById("bulk-reset-btn").addEventListener("click", () => {
      showDialog(
        "리셋 확인",
        `필터된 ${filteredSearchResults.length}개 단어의 해답 기록을 리셋하시겠습니까?`,
        () => {
          for (const w of filteredSearchResults) {
            delete records[w.word_id];
          }
          saveRecords();
          clearUndoState();
          renderSearchResults();
          updateQuizProgress();
        }
      );
    });

    // 설정 토글
    document.querySelectorAll("[data-setting]").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.setting;
        const [category, value] = key.split("-");
        if (category === "level") settings.levels[value] = input.checked;
        else if (category === "pos") settings.pos[value] = input.checked;
        else if (category === "wtype") settings.wordTypes[value] = input.checked;
        else if (category === "quiz") settings.quiz[value] = input.checked;
        saveSettings();
        // 퀴즈 갱신 (퀴즈 설정 변경시엔 퀴즈 갱신 불필요할 수 있지만, 일단 그대로 유지)
        if (category !== "quiz") {
          clearUndoState();
          if (!quizAnswered) startQuiz();
          else updateQuizProgress();
        }
      });
    });

    // 설정: 데이터 내보내기
    document
      .getElementById("settings-export")
      .addEventListener("click", exportData);

    // 설정: 데이터 가져오기
    document
      .getElementById("settings-import")
      .addEventListener("click", () => {
        document.getElementById("import-file-input").click();
      });
    document
      .getElementById("import-file-input")
      .addEventListener("change", importData);

    // 설정: 전체 리셋
    document
      .getElementById("settings-reset-all")
      .addEventListener("click", () => {
        showDialog(
          "전체 리셋",
          "모든 해답 기록이 삭제됩니다. 이 작업은 되돌릴 수 없습니다.",
          () => {
            records = {};
            saveRecords();
            clearUndoState();
            startQuiz();
            renderSearchResults();
          }
        );
      });

    // 다이얼로그
    document
      .getElementById("dialog-cancel")
      .addEventListener("click", hideDialog);
    document
      .getElementById("dialog-overlay")
      .addEventListener("click", (e) => {
        if (e.target === e.currentTarget) hideDialog();
      });

    // 검색 결과 스크롤 (추가 로드)
    const searchPane = document.getElementById("tab-search");
    // tab-content의 스크롤 이벤트를 대신 감지
    const tabContent = document.querySelector(".tab-content") || searchPane;
  }

  // ============================================================
  // 탭 전환
  // ============================================================
  function switchTab(tabName) {
    // 탭 버튼 활성화
    document.querySelectorAll(".tab-bar-item").forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    // 탭 콘텐츠 활성화
    document.querySelectorAll(".tab-pane").forEach((pane) => {
      pane.classList.toggle("active", pane.id === `tab-${tabName}`);
    });

    // 탭별 갱신
    if (tabName === "stats") {
      renderStats();
    } else if (tabName === "search") {
      renderSearchResults();
    }
  }

  // ============================================================
  // 필터 헬퍼
  // ============================================================
  function isWordInFilter(word) {
    if (!settings.levels[word.level]) return false;
    if (!settings.pos[word.pos]) return false;
    if (!settings.wordTypes[word.word_type]) return false;
    return true;
  }

  function getFilteredWords() {
    return allWords.filter((w) => isWordInFilter(w));
  }

  function getUnansweredWords() {
    return getFilteredWords().filter((w) => !records[w.word_id]);
  }

  // ============================================================
  // 퀴즈 로직
  // ============================================================
  function startQuiz() {
    quizAnswered = false;
    currentQuiz = null;
    generateQuiz();
  }

  function generateQuiz() {
    if (autoNextTimeout) {
      clearTimeout(autoNextTimeout);
      autoNextTimeout = null;
    }
    quizAnswered = false;
    const unanswered = getUnansweredWords();
    updateQuizProgress();

    if (unanswered.length === 0) {
      document.getElementById("quiz-body").classList.add("hidden");
      document.getElementById("quiz-complete").classList.remove("hidden");
      return;
    }

    document.getElementById("quiz-body").classList.remove("hidden");
    document.getElementById("quiz-complete").classList.add("hidden");

    // 랜덤 선택
    const word = unanswered[Math.floor(Math.random() * unanswered.length)];

    // 정답 뜻풀이 선택 (첫 번째 사용)
    const correctDef = word.definitions[0];

    // 오답 후보 생성
    const distractorDefs = getDistractorDefinitions(word, 3);

    // 선택지 셔플
    const options = [
      { text: correctDef, correct: true },
      ...distractorDefs.map((d) => ({ text: d, correct: false })),
    ];
    shuffleArray(options);

    currentQuiz = { word, options, correctDef };
    quizAnswered = false;

    renderQuiz();
  }

  function getDistractorDefinitions(targetWord, count) {
    const distractors = [];
    const usedWords = new Set([targetWord.word]);
    const usedDefs = new Set(targetWord.definitions);

    // 1차: similarity_map에서 유사어의 뜻풀이 가져오기
    const similarWords = similarityMap[targetWord.word] || [];
    for (const simWord of similarWords) {
      if (distractors.length >= count) break;

      // simWord와 같은 텍스트를 가진 사전 내 단어 찾기
      const candidates = allWords.filter(
        (w) => w.word === simWord && !usedWords.has(w.word_id)
      );
      for (const cand of candidates) {
        if (distractors.length >= count) break;
        for (const def of cand.definitions) {
          if (!usedDefs.has(def) && def.length > 2) {
            distractors.push(def);
            usedDefs.add(def);
            usedWords.add(cand.word_id);
            break;
          }
        }
      }
    }

    // 2차: 같은 품사에서 랜덤으로 보충
    if (distractors.length < count) {
      const samePosWords = allWords.filter(
        (w) =>
          w.pos === targetWord.pos &&
          !usedWords.has(w.word_id) &&
          w.word !== targetWord.word
      );
      shuffleArray(samePosWords);

      for (const w of samePosWords) {
        if (distractors.length >= count) break;
        for (const def of w.definitions) {
          if (!usedDefs.has(def) && def.length > 2) {
            distractors.push(def);
            usedDefs.add(def);
            usedWords.add(w.word_id);
            break;
          }
        }
      }
    }

    return distractors.slice(0, count);
  }

  function renderQuiz() {
    if (!currentQuiz) return;
    const { word, options } = currentQuiz;

    document.getElementById("quiz-word").textContent = word.word;
    document.getElementById("quiz-pos").textContent = word.pos;

    const optionsEl = document.getElementById("quiz-options");
    optionsEl.innerHTML = "";

    options.forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.className = "quiz-option-btn";
      btn.type = "button";
      btn.textContent = opt.text;
      btn.addEventListener("click", () => handleOptionClick(idx));
      optionsEl.appendChild(btn);
    });

    document.getElementById("quiz-unknown-btn").style.display = "";
    document.getElementById("quiz-unknown-btn").className = "quiz-unknown-btn";
    document.getElementById("quiz-next-btn").style.display = "none";
  }

  function handleOptionClick(idx) {
    if (quizAnswered) return;
    quizAnswered = true;

    const { word, options } = currentQuiz;
    const selected = options[idx];
    const btns = document.querySelectorAll("#quiz-options .quiz-option-btn");

    lastQuizState = {
      word_id: word.word_id,
      quizObject: currentQuiz,
      previousRecord: records[word.word_id] ? { ...records[word.word_id] } : undefined
    };
    document.getElementById("quiz-undo-btn").classList.remove("hidden");

    // 기록 저장
    records[word.word_id] = {
      status: selected.correct ? "correct" : "wrong",
      ts: Date.now(),
    };
    saveRecords();

    // UI 업데이트
    btns.forEach((btn, i) => {
      btn.classList.add("disabled");
      if (options[i].correct) {
        btn.classList.add("correct");
      }
      if (i === idx && !selected.correct) {
        btn.classList.add("wrong");
      }
    });

    document.getElementById("quiz-unknown-btn").style.display = "none";
    document.getElementById("quiz-next-btn").style.display = "block";
    updateQuizProgress();

    if (settings.quiz?.autonext) {
      autoNextTimeout = setTimeout(() => {
        if (quizAnswered) generateQuiz();
      }, 1500);
    }
  }

  function handleUnknown() {
    if (quizAnswered) return;
    quizAnswered = true;

    const { word, options } = currentQuiz;

    lastQuizState = {
      word_id: word.word_id,
      quizObject: currentQuiz,
      previousRecord: records[word.word_id] ? { ...records[word.word_id] } : undefined
    };
    document.getElementById("quiz-undo-btn").classList.remove("hidden");

    // 기록 저장
    records[word.word_id] = {
      status: "unknown",
      ts: Date.now(),
    };
    saveRecords();

    // UI 업데이트 - 정답 표시
    const btns = document.querySelectorAll("#quiz-options .quiz-option-btn");
    btns.forEach((btn, i) => {
      btn.classList.add("disabled");
      if (options[i].correct) {
        btn.classList.add("highlight-correct");
      }
    });

    document.getElementById("quiz-unknown-btn").style.display = "none";
    document.getElementById("quiz-next-btn").style.display = "block";
    updateQuizProgress();

    if (settings.quiz?.autonext) {
      autoNextTimeout = setTimeout(() => {
        if (quizAnswered) generateQuiz();
      }, 1500);
    }
  }

  function nextQuiz() {
    generateQuiz();
  }

  function updateQuizProgress() {
    const filtered = getFilteredWords();
    const answered = filtered.filter((w) => records[w.word_id]).length;
    const progressEl = document.getElementById("quiz-progress");
    progressEl.textContent = `${answered} / ${filtered.length}`;
  }

  // ============================================================
  // 통계
  // ============================================================
  function renderStats() {
    const filtered = getFilteredWords();
    const answered = filtered.filter((w) => records[w.word_id]);
    const correct = answered.filter(
      (w) => records[w.word_id].status === "correct"
    );

    // 전체 개요
    const progressPct =
      filtered.length > 0
        ? ((answered.length / filtered.length) * 100).toFixed(1)
        : "0";
    const accuracyPct =
      answered.length > 0
        ? ((correct.length / answered.length) * 100).toFixed(1)
        : "0";

    document.getElementById(
      "stats-progress-value"
    ).textContent = `${progressPct}%`;
    document.getElementById(
      "stats-progress-sub"
    ).textContent = `${answered.length} / ${filtered.length}`;
    document.getElementById(
      "stats-progress-bar"
    ).style.width = `${progressPct}%`;

    document.getElementById(
      "stats-accuracy-value"
    ).textContent = `${accuracyPct}%`;
    document.getElementById(
      "stats-accuracy-sub"
    ).textContent = `${correct.length} / ${answered.length}`;
    document.getElementById(
      "stats-accuracy-bar"
    ).style.width = `${accuracyPct}%`;

    renderStatsDetail();
  }

  function renderStatsDetail() {
    const listEl = document.getElementById("stats-detail-list");
    listEl.innerHTML = "";

    let groups;
    switch (currentStatSegment) {
      case "pos":
        groups = groupBy(allWords, (w) => w.pos);
        break;
      case "level":
        groups = groupBy(allWords, (w) => w.level);
        break;
      case "wordtype":
        groups = groupBy(allWords, (w) => w.word_type);
        break;
      case "topic":
        groups = groupByMulti(allWords, (w) => w.topics);
        break;
      default:
        groups = {};
    }

    // 정렬
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      // 난이도는 특정 순서
      if (currentStatSegment === "level") {
        const order = { 초급: 0, 중급: 1, 고급: 2, 없음: 3 };
        return (order[a] ?? 99) - (order[b] ?? 99);
      }
      return a.localeCompare(b, "ko");
    });

    for (const key of sortedKeys) {
      const words = groups[key];
      const total = words.length;
      const answered = words.filter((w) => records[w.word_id]).length;
      const correct = words.filter(
        (w) => records[w.word_id]?.status === "correct"
      ).length;

      const progressPct = total > 0 ? ((answered / total) * 100).toFixed(1) : "0";
      const accuracyPct =
        answered > 0 ? ((correct / answered) * 100).toFixed(1) : "—";

      const row = document.createElement("div");
      row.className = "stats-detail-row";
      row.innerHTML = `
        <div class="stats-detail-label">${escapeHtml(key)}</div>
        <div class="stats-detail-values">
          <div class="stats-detail-primary">${progressPct}% / ${accuracyPct === "—" ? "—" : accuracyPct + "%"}</div>
          <div class="stats-detail-secondary">${answered}/${total} 기출 · ${correct} 정답</div>
        </div>
      `;
      listEl.appendChild(row);
    }

    if (sortedKeys.length === 0) {
      listEl.innerHTML =
        '<div class="stats-detail-row"><div class="stats-detail-label" style="color:var(--label-secondary)">데이터가 없습니다</div></div>';
    }
  }

  function groupBy(arr, keyFn) {
    const map = {};
    for (const item of arr) {
      const key = keyFn(item);
      if (!map[key]) map[key] = [];
      map[key].push(item);
    }
    return map;
  }

  function groupByMulti(arr, keysFn) {
    const map = {};
    for (const item of arr) {
      const keys = keysFn(item);
      if (keys.length === 0) {
        // 주제 없음
        const key = "(없음)";
        if (!map[key]) map[key] = [];
        map[key].push(item);
      } else {
        for (const key of keys) {
          if (!map[key]) map[key] = [];
          map[key].push(item);
        }
      }
    }
    return map;
  }

  // ============================================================
  // 검색/리셋
  // ============================================================
  function renderSearchResults() {
    // 필터링
    filteredSearchResults = allWords.filter((w) => {
      // 텍스트 검색
      if (currentSearchQuery) {
        const q = currentSearchQuery.toLowerCase();
        if (
          !w.word.toLowerCase().includes(q) &&
          !w.definitions.some((d) => d.toLowerCase().includes(q))
        ) {
          return false;
        }
      }

      // 상태 필터
      const record = records[w.word_id];
      switch (currentSearchFilter) {
        case "correct":
          if (record?.status !== "correct") return false;
          break;
        case "wrong":
          if (record?.status !== "wrong") return false;
          break;
        case "unknown":
          if (record?.status !== "unknown") return false;
          break;
        case "unanswered":
          if (record) return false;
          break;
      }

      // 상세 조건 필터
      if (currentAdvFilters.pos !== "all" && w.pos !== currentAdvFilters.pos) return false;
      if (currentAdvFilters.level !== "all" && w.level !== currentAdvFilters.level) return false;
      if (currentAdvFilters.wtype !== "all" && w.word_type !== currentAdvFilters.wtype) return false;

      return true;
    });

    // 결과 수 표시
    document.getElementById(
      "search-result-count"
    ).textContent = `${filteredSearchResults.length}개`;

    // 일괄 리셋 버튼 표시/숨기기
    const hasAnswered = filteredSearchResults.some((w) => records[w.word_id]);
    const bulkActions = document.getElementById("search-bulk-actions");
    bulkActions.classList.toggle("hidden", !hasAnswered);

    // 리스트 렌더링 (최대 searchRenderLimit개)
    const listEl = document.getElementById("search-results");
    listEl.innerHTML = "";

    const renderCount = Math.min(
      filteredSearchResults.length,
      searchRenderLimit
    );

    for (let i = 0; i < renderCount; i++) {
      const w = filteredSearchResults[i];
      const record = records[w.word_id];
      let statusIcon = "미답";
      if (record) {
        switch (record.status) {
          case "correct":
            statusIcon = "정답";
            break;
          case "wrong":
            statusIcon = "오답";
            break;
          case "unknown":
            statusIcon = "모름";
            break;
        }
      }

      const item = document.createElement("div");
      item.className = "word-list-item";
      item.innerHTML = `
        <div class="word-list-status">${statusIcon}</div>
        <div class="word-list-info">
          <div class="word-list-word">${escapeHtml(w.word)}</div>
          <div class="word-list-def">${escapeHtml(w.definitions[0])}</div>
        </div>
        <div class="word-list-tags">
          <span class="word-tag">${escapeHtml(w.pos)}</span>
          <span class="word-tag">${escapeHtml(w.level)}</span>
        </div>
      `;

      // 클릭으로 개별 리셋
      if (record) {
        item.addEventListener("click", () => {
          showDialog(
            "리셋 확인",
            `"${w.word}"의 해답 기록을 리셋하시겠습니까?`,
            () => {
              delete records[w.word_id];
              saveRecords();
              renderSearchResults();
              updateQuizProgress();
            }
          );
        });
      }

      listEl.appendChild(item);
    }

    if (renderCount < filteredSearchResults.length) {
      const moreBtn = document.createElement("div");
      moreBtn.className = "word-list-item";
      moreBtn.style.justifyContent = "center";
      moreBtn.innerHTML = `<span style="color:var(--system-blue);font:var(--font-callout)">더 보기 (${filteredSearchResults.length - renderCount}개 남음)</span>`;
      moreBtn.addEventListener("click", () => {
        searchRenderLimit += 100;
        renderSearchResults();
      });
      listEl.appendChild(moreBtn);
    }

    if (filteredSearchResults.length === 0) {
      listEl.innerHTML =
        '<div class="word-list-item" style="justify-content:center"><span style="color:var(--label-secondary)">결과 없음</span></div>';
    }
  }

  function clearUndoState() {
    lastQuizState = null;
    const btn = document.getElementById("quiz-undo-btn");
    if (btn) btn.classList.add("hidden");
  }

  function undoLastQuiz() {
    if (!lastQuizState) return;
    
    const { word_id, quizObject, previousRecord } = lastQuizState;
    
    if (previousRecord !== undefined) {
      records[word_id] = previousRecord;
    } else {
      delete records[word_id];
    }
    saveRecords();
    
    if (autoNextTimeout) {
      clearTimeout(autoNextTimeout);
      autoNextTimeout = null;
    }
    
    currentQuiz = quizObject;
    quizAnswered = false;
    
    clearUndoState();
    renderQuiz();
    updateQuizProgress();
  }

  // ============================================================
  // 설정
  // ============================================================
  function applySettingsToUI() {
    // 토글 상태 복원
    for (const [level, checked] of Object.entries(settings.levels)) {
      const el = document.querySelector(`[data-setting="level-${level}"]`);
      if (el) el.checked = checked;
    }
    for (const [pos, checked] of Object.entries(settings.pos)) {
      const el = document.querySelector(`[data-setting="pos-${pos}"]`);
      if (el) el.checked = checked;
    }
    for (const [wtype, checked] of Object.entries(settings.wordTypes)) {
      const el = document.querySelector(`[data-setting="wtype-${wtype}"]`);
      if (el) el.checked = checked;
    }
  }

  function exportData() {
    const data = {
      records: records,
      settings: settings,
      exportedAt: new Date().toISOString(),
      version: 1,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `korean-vocab-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.records) {
          records = data.records;
          saveRecords();
        }
        if (data.settings) {
          settings = { ...settings, ...data.settings };
          saveSettings();
          applySettingsToUI();
        }
        startQuiz();
        alert("데이터를 성공적으로 가져왔습니다.");
      } catch (err) {
        alert("파일 형식이 올바르지 않습니다.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // ============================================================
  // 다이얼로그
  // ============================================================
  let dialogCallback = null;

  function showDialog(title, message, onConfirm) {
    document.getElementById("dialog-title").textContent = title;
    document.getElementById("dialog-message").textContent = message;
    document.getElementById("dialog-overlay").classList.add("visible");
    dialogCallback = onConfirm;

    // 확인 버튼 이벤트 (한번만)
    const confirmBtn = document.getElementById("dialog-confirm");
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    newConfirmBtn.addEventListener("click", () => {
      const cb = dialogCallback;
      hideDialog();
      if (cb) cb();
    });
  }

  function hideDialog() {
    document.getElementById("dialog-overlay").classList.remove("visible");
    dialogCallback = null;
  }

  // ============================================================
  // 유틸리티
  // ============================================================
  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================================
  // 시작
  // ============================================================
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
