(function () {
  "use strict";

  const STORAGE_KEY = "genki_dic_v1";
  const STORAGE_MANIFEST_KEY = `${STORAGE_KEY}_manifest`;
  const STORAGE_CHUNK_PREFIX = `${STORAGE_KEY}_chunk_`;
  const STORAGE_CHUNK_SIZE = 3000;
  const CLOUD_STORAGE_TIMEOUT = 15000;
  const NOTICE_DISMISS_DELAY = 5000;
  const PERSIST_DEBOUNCE_DELAY = 700;
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const isTelegramMiniApp = Boolean(tg && tg.initData);
  const hasCloudStorage = Boolean(isTelegramMiniApp && tg.CloudStorage);
  const starterLessons = Array.isArray(window.GENKI_STARTER_LESSONS)
    ? window.GENKI_STARTER_LESSONS
    : [];

  const state = {
    ready: false,
    route: { name: "home" },
    data: {
      settings: {
        japaneseStyle: "standard",
        fontSize: "medium",
        enableDeletion: false,
        enableEdit: false,
      },
      lessons: [],
    },
    modal: "",
    editEntryId: "",
    addWordOpen: false,
    searchQuery: "",
    readingVisible: new Set(),
    status: "",
    error: "",
  };

  const app = document.getElementById("app");
  let noticeDismissTimer = 0;
  let noticeDismissKey = "";
  let persistQueue = Promise.resolve();
  let persistTimer = 0;
  let pendingPersistSerialized = "";

  const storage = {
    async get() {
      if (hasCloudStorage) {
        return cloudGetData();
      }

      const value = window.localStorage.getItem(STORAGE_KEY);
      return value ? JSON.parse(value) : { lessons: [] };
    },
    async set(data) {
      await writeSerializedData(JSON.stringify(data));
    },
  };

  async function writeSerializedData(serialized) {
    if (hasCloudStorage) {
      await cloudSetData(serialized);
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, serialized);
  }

  function cloudGetItem(key) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error(`CloudStorage timed out reading ${key}`));
      }, CLOUD_STORAGE_TIMEOUT);

      tg.CloudStorage.getItem(key, (error, value) => {
        window.clearTimeout(timeout);

        if (error) {
          reject(new Error(error));
          return;
        }
        resolve(value);
      });
    });
  }

  function cloudSetItem(key, value) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error(`CloudStorage timed out writing ${key}`));
      }, CLOUD_STORAGE_TIMEOUT);

      tg.CloudStorage.setItem(key, value, (error, isStored) => {
        window.clearTimeout(timeout);

        if (error) {
          reject(new Error(error));
          return;
        }

        if (isStored === false) {
          reject(new Error(`CloudStorage did not store ${key}`));
          return;
        }

        resolve();
      });
    });
  }

  async function cloudGetData() {
    const manifestValue = await cloudGetItem(STORAGE_MANIFEST_KEY);

    if (manifestValue) {
      const manifest = JSON.parse(manifestValue);
      const chunkCount = Number(manifest.chunks || 0);

      if (chunkCount > 0) {
        const chunks = await Promise.all(
          Array.from({ length: chunkCount }, (_, index) =>
            cloudGetItem(`${STORAGE_CHUNK_PREFIX}${index}`),
          ),
        );

        if (chunks.some((chunk) => typeof chunk !== "string")) {
          throw new Error("CloudStorage data is incomplete");
        }

        return JSON.parse(chunks.join(""));
      }
    }

    const legacyValue = await cloudGetItem(STORAGE_KEY);
    return legacyValue ? JSON.parse(legacyValue) : { lessons: [] };
  }

  async function cloudSetData(serialized) {
    const chunks = [];

    for (let index = 0; index < serialized.length; index += STORAGE_CHUNK_SIZE) {
      chunks.push(serialized.slice(index, index + STORAGE_CHUNK_SIZE));
    }

    for (let index = 0; index < chunks.length; index += 1) {
      await cloudSetItem(`${STORAGE_CHUNK_PREFIX}${index}`, chunks[index]);
    }

    await cloudSetItem(
      STORAGE_MANIFEST_KEY,
      JSON.stringify({
        version: 1,
        chunks: chunks.length,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  function normalizeData(data) {
    const lessons = Array.isArray(data && data.lessons) ? data.lessons : [];
    const rawStyle = data && data.settings ? data.settings.japaneseStyle : "";
    const japaneseStyle = rawStyle === "book" ? "book" : "standard";
    const rawFontSize = data && data.settings ? data.settings.fontSize : "";
    const fontSize = ["small", "medium", "large"].includes(rawFontSize) ? rawFontSize : "medium";
    const enableDeletion = Boolean(data && data.settings && data.settings.enableDeletion);
    const enableEdit = Boolean(data && data.settings && data.settings.enableEdit);

    return {
      settings: {
        japaneseStyle,
        fontSize,
        enableDeletion,
        enableEdit,
      },
      lessons: lessons
        .map((lesson) => ({
          id: String(lesson.id || createId()),
          lessonNumber: String(lesson.lessonNumber || "").trim(),
          pageNumber: String(lesson.pageNumber || "").trim(),
          createdAt: lesson.createdAt || new Date().toISOString(),
          entries: Array.isArray(lesson.entries)
            ? lesson.entries.map((entry) => {
                const rawFurigana = String(entry.furigana || "").trim();
                const rawRomaji = String(entry.romaji || "").trim();
                const furiganaLooksLikeRomaji = /[A-Za-z]/.test(rawFurigana);

                return {
                  id: String(entry.id || createId()),
                  japanese: String(entry.japanese || "").trim(),
                  furigana: furiganaLooksLikeRomaji ? "" : rawFurigana,
                  romaji: rawRomaji || (furiganaLooksLikeRomaji ? rawFurigana : ""),
                  translation: String(entry.translation || "").trim(),
                  createdAt: entry.createdAt || new Date().toISOString(),
                };
              })
            : [],
        }))
        .filter((lesson) => lesson.lessonNumber && lesson.pageNumber),
    };
  }

  function parseRoute() {
    const hash = window.location.hash.replace(/^#/, "");
    const lessonMatch = hash.match(/^\/lesson\/([^/]+)$/);

    if (lessonMatch) {
      return { name: "lesson", id: decodeURIComponent(lessonMatch[1]) };
    }

    return { name: "home" };
  }

  function navigate(route) {
    if (route.name === "lesson") {
      window.location.hash = `/lesson/${encodeURIComponent(route.id)}`;
      return;
    }

    window.location.hash = "/";
  }

  async function boot() {
    if (isTelegramMiniApp) {
      tg.ready();
      tg.expand();
    }

    try {
      state.data = normalizeData(await storage.get());
      state.ready = true;
    } catch (error) {
      state.error = `Could not load dictionary: ${error.message}`;
      state.ready = true;
    }

    state.route = parseRoute();
    render();
  }

  function persist() {
    pendingPersistSerialized = JSON.stringify(state.data);

    if (persistTimer) {
      window.clearTimeout(persistTimer);
    }

    persistTimer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_DELAY);
  }

  function flushPersist() {
    if (!pendingPersistSerialized) return;

    const serialized = pendingPersistSerialized;
    pendingPersistSerialized = "";
    persistTimer = 0;

    const currentPersist = persistQueue.catch(() => undefined).then(async () => {
      await writeSerializedData(serialized);
    });

    persistQueue = currentPersist;
    currentPersist.catch((error) => {
      if (currentPersist !== persistQueue) return;

      state.status = "";
      state.error = `Could not save changes: ${error.message}`;
      render();
    });
  }

  function lessonSort(a, b) {
    const lessonDelta = Number(a.lessonNumber) - Number(b.lessonNumber);
    if (lessonDelta !== 0) return lessonDelta;
    return Number(a.pageNumber) - Number(b.pageNumber);
  }

  function getCurrentLesson() {
    return state.data.lessons.find((lesson) => lesson.id === state.route.id);
  }

  function findEntryContext(entryId) {
    for (const lesson of state.data.lessons) {
      const entry = lesson.entries.find((item) => item.id === entryId);
      if (entry) return { lesson, entry };
    }

    return null;
  }

  function getSearchResults() {
    const query = state.searchQuery.trim().toLocaleLowerCase();
    if (!query) return [];

    return state.data.lessons
      .flatMap((lesson) =>
        lesson.entries.map((entry) => ({
          lesson,
          entry,
          haystack: [entry.japanese, entry.furigana, entry.romaji, entry.translation]
            .join(" ")
            .toLocaleLowerCase(),
        })),
      )
      .filter((result) => result.haystack.includes(query))
      .sort((a, b) => lessonSort(a.lesson, b.lesson));
  }

  function getImportStats() {
    const lessons = starterLessons.length;
    const words = starterLessons.reduce((count, lesson) => count + lesson.entries.length, 0);

    return { lessons, words };
  }

  function renderJapanese(entry, visible) {
    if (visible && entry.furigana) {
      return `<ruby>${escapeHtml(entry.japanese)}<rt>${escapeHtml(entry.furigana)}</rt></ruby>`;
    }

    return escapeHtml(entry.japanese);
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function render() {
    if (!state.ready) {
      app.innerHTML = `<section class="center-state">Loading dictionary...</section>`;
      return;
    }

    app.dataset.japaneseStyle = state.data.settings.japaneseStyle;
    app.dataset.fontSize = state.data.settings.fontSize;

    if (state.route.name === "lesson") {
      renderLesson();
      return;
    }

    renderHome();
  }

  function renderHome() {
    const lessons = [...state.data.lessons].sort(lessonSort);

    app.innerHTML = `
      ${renderTopbar("Genki Dictionary", "Personal Japanese dictionary")}
      ${renderNotice()}
      ${renderSearchPanel()}

      ${
        lessons.length
          ? `<div class="lesson-list">${lessons.map(renderLessonCard).join("")}</div>`
          : `<section class="empty-state">
              <h2>No lessons yet</h2>
              <p>Create your first Genki page above.</p>
            </section>`
      }
      ${renderModalRoot()}
    `;
  }

  function renderHomeActions() {
    return `
      <section class="home-actions" aria-label="Dictionary actions">
        <button class="icon-button" data-action="open-modal" data-modal="create" aria-label="Create lesson" title="Create lesson">+</button>
        <button class="icon-button" data-action="open-modal" data-modal="settings" aria-label="Open settings" title="Open settings">⚙</button>
      </section>
    `;
  }

  function renderModal() {
    if (!state.modal) return "";

    const titles = {
      settings: "Settings",
      create: "Create lesson",
      editEntry: "Edit word",
    };
    const title = titles[state.modal] || "Settings";
    const content =
      state.modal === "settings"
        ? renderSettings()
        : state.modal === "editEntry"
          ? renderEditEntryForm()
          : renderCreateLessonForm();

    return `
      <section class="modal-backdrop" data-action="close-modal">
        <div class="modal-panel" data-action="modal-panel" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
          <header class="modal-header">
            <h2>${escapeHtml(title)}</h2>
            <button class="icon-button compact" data-action="close-modal" aria-label="Close" title="Close">×</button>
          </header>
          ${content}
        </div>
      </section>
    `;
  }

  function renderModalRoot() {
    return `<div id="modal-root">${renderModal()}</div>`;
  }

  function updateModal() {
    const modalRoot = document.getElementById("modal-root");

    if (!modalRoot) {
      render();
      return;
    }

    modalRoot.innerHTML = renderModal();
    focusModalField();
  }

  function focusModalField() {
    if (state.modal !== "editEntry") return;

    window.requestAnimationFrame(() => {
      const translationInput = document.querySelector(
        "[data-role='edit-translation-input']",
      );
      if (translationInput) {
        translationInput.focus();
        translationInput.select();
      }
    });
  }

  function renderCreateLessonForm() {
    return `
      <section class="panel modal-content-panel">
        <form class="lesson-form" data-action="create-lesson">
          <label>
            <span>Lesson</span>
            <input name="lessonNumber" inputmode="numeric" ${renderInputAssistOff()} placeholder="5" required />
          </label>
          <label>
            <span>Page</span>
            <input name="pageNumber" inputmode="numeric" ${renderInputAssistOff()} placeholder="130" required />
          </label>
          <button class="primary-button" type="submit">Create</button>
        </form>
      </section>
    `;
  }

  function renderEditEntryForm() {
    const context = findEntryContext(state.editEntryId);

    if (!context) {
      return `
        <section class="empty-state compact-state">
          <h2>Word not found</h2>
          <p>This word is no longer in the dictionary.</p>
        </section>
      `;
    }

    const { entry } = context;

    return `
      <section class="panel modal-content-panel">
        <form class="word-form" data-action="update-entry">
          <input type="hidden" name="entryId" value="${escapeAttribute(entry.id)}" />
          <label>
            <span>Japanese</span>
            <input name="japanese" ${renderInputAssistOff()} value="${escapeAttribute(entry.japanese)}" required />
          </label>
          <label>
            <span>Furigana</span>
            <input name="furigana" ${renderInputAssistOff()} value="${escapeAttribute(entry.furigana)}" />
          </label>
          <label>
            <span>Romaji</span>
            <input name="romaji" ${renderInputAssistOff()} value="${escapeAttribute(entry.romaji)}" />
          </label>
          <label>
            <span>Translation</span>
            <input
              data-role="edit-translation-input"
              name="translation"
              ${renderInputAssistOff()}
              value="${escapeAttribute(entry.translation)}"
            />
          </label>
          <button class="primary-button wide" type="submit">Save word</button>
        </form>
      </section>
    `;
  }

  function renderSettings() {
    const style = state.data.settings.japaneseStyle;
    const fontSize = state.data.settings.fontSize;
    const deletionEnabled = state.data.settings.enableDeletion;
    const editEnabled = state.data.settings.enableEdit;

    return `
      <section class="settings-panel">
        <h2>Settings</h2>

        <div class="settings-row">
          <span>Japanese style</span>
          <div class="segmented-control" role="group" aria-label="Japanese text style">
            <button
              class="${style === "standard" ? "active" : ""}"
              data-action="set-japanese-style"
              data-style="standard"
              type="button"
            >Standard</button>
            <button
              class="${style === "book" ? "active" : ""}"
              data-action="set-japanese-style"
              data-style="book"
              type="button"
            >Book</button>
          </div>
        </div>

        <div class="settings-row">
          <span>Font size</span>
          <div class="segmented-control three-options" role="group" aria-label="Word card font size">
            <button
              class="${fontSize === "small" ? "active" : ""}"
              data-action="set-font-size"
              data-size="small"
              type="button"
            >Small</button>
            <button
              class="${fontSize === "medium" ? "active" : ""}"
              data-action="set-font-size"
              data-size="medium"
              type="button"
            >Medium</button>
            <button
              class="${fontSize === "large" ? "active" : ""}"
              data-action="set-font-size"
              data-size="large"
              type="button"
            >Large</button>
          </div>
        </div>

        <div class="settings-row">
          <span>Enable edit</span>
          <button
            class="switch-control ${editEnabled ? "active" : ""}"
            data-action="toggle-edit"
            aria-pressed="${editEnabled ? "true" : "false"}"
            type="button"
          >
            <span></span>
          </button>
        </div>

        <div class="settings-row">
          <span>Enable deletion</span>
          <button
            class="switch-control ${deletionEnabled ? "active" : ""}"
            data-action="toggle-deletion"
            aria-pressed="${deletionEnabled ? "true" : "false"}"
            type="button"
          >
            <span></span>
          </button>
        </div>
      </section>
    `;
  }

  function renderStarterImport() {
    if (!starterLessons.length) return "";

    const { lessons, words } = getImportStats();

    return `
      <section class="import-panel">
        <div>
          <h2>Lessons 3-6</h2>
          <p>${lessons} lessons · ${words} words from your Telegram messages</p>
        </div>
        <button class="ghost-button" data-action="import-starter">Import</button>
      </section>
    `;
  }

  function renderSearchPanel() {
    return `
      <section class="search-panel">
        <label>
          <span>Search all words</span>
          <div class="search-control">
            <input
              data-role="global-search"
              type="search"
              ${renderInputAssistOff()}
              placeholder="食べ物, たべもの, food"
              value="${escapeAttribute(state.searchQuery)}"
            />
            <button
              class="icon-button compact"
              data-action="clear-search"
              aria-label="Clear search"
              title="Clear search"
              ${state.searchQuery ? "" : "hidden"}
            >×</button>
          </div>
        </label>
        <div id="search-results">
          ${renderSearchResults()}
        </div>
      </section>
    `;
  }

  function renderSearchResults() {
    const query = state.searchQuery.trim();
    if (!query) return "";

    const results = getSearchResults();

    if (!results.length) {
      return `
        <section class="empty-state compact-state">
          <h2>No matches</h2>
          <p>Try Japanese, furigana, or translation.</p>
        </section>
      `;
    }

    return `
      <section class="word-list search-list">
        ${results.map(renderSearchResult).join("")}
      </section>
    `;
  }

  function updateSearchResults() {
    const results = document.getElementById("search-results");
    if (results) {
      results.innerHTML = renderSearchResults();
    }

    const clearButton = document.querySelector("[data-action='clear-search']");
    if (clearButton) {
      clearButton.hidden = !state.searchQuery;
    }
  }

  function renderSearchResult(result) {
    const { lesson, entry } = result;
    const hasReading = Boolean(entry.furigana || entry.romaji);
    const visible = state.readingVisible.has(entry.id);

    return `
      <article
        class="word-row has-actions search-result ${hasReading ? "has-reading" : ""}"
        ${hasReading ? `data-action="toggle-reading" data-id="${escapeAttribute(entry.id)}"` : ""}
      >
        <div class="word-main">
          <div class="japanese">
            ${renderJapanese(entry, visible)}
          </div>
        </div>
        <div class="reading">${visible && entry.romaji ? escapeHtml(entry.romaji) : ""}</div>
        <div class="translation">${escapeHtml(entry.translation)}</div>
        <div class="word-actions">
          <button class="ghost-button lesson-link-button" data-action="open-lesson" data-id="${escapeAttribute(lesson.id)}">
            L${escapeHtml(lesson.lessonNumber)}
          </button>
        </div>
      </article>
    `;
  }

  function renderLesson() {
    const lesson = getCurrentLesson();

    if (!lesson) {
      app.innerHTML = `
        ${renderTopbar("Lesson not found", "This page is not in the dictionary")}
        <button class="ghost-button full-width" data-action="go-home">Back to lessons</button>
      `;
      return;
    }

    app.innerHTML = `
      <header class="lesson-header">
        <button class="icon-button" data-action="go-home" aria-label="Back to lessons" title="Back to lessons">
          <span aria-hidden="true">‹</span>
        </button>
        <div>
          <p>Lesson ${escapeHtml(lesson.lessonNumber)} · Page ${escapeHtml(lesson.pageNumber)}</p>
        </div>
        <div class="lesson-header-actions">
          ${renderLessonDeleteButton(lesson, "header")}
          <button class="icon-button" data-action="open-modal" data-modal="settings" aria-label="Open settings" title="Open settings">⚙</button>
        </div>
      </header>

      ${renderNotice()}

      <div id="add-word-root">${renderAddWordBlock()}</div>

      ${
        lesson.entries.length
          ? `<div id="word-list-root">${renderWordList(lesson)}</div>`
          : `<section class="empty-state">
              <h2>No words yet</h2>
              <p>Add Japanese and optional reading or translation.</p>
            </section>`
      }
      ${renderModalRoot()}
    `;
  }

  function renderWordList(lesson) {
    return `<section class="word-list">${lesson.entries.map(renderEntry).join("")}</section>`;
  }

  function updateWordList() {
    const lesson = getCurrentLesson();
    if (!lesson) return;

    const root = document.getElementById("word-list-root");

    if (root) {
      root.innerHTML = renderWordList(lesson);
      return;
    }

    render();
  }

  function renderAddWordBlock() {
    return `
      <section class="add-word-section ${state.addWordOpen ? "open" : ""}">
        <button
          class="add-word-toggle"
          data-action="toggle-add-word"
          aria-expanded="${state.addWordOpen ? "true" : "false"}"
          type="button"
        >
          <span>Add word</span>
          <small>Japanese · Furigana · Romaji · Translation</small>
        </button>

        ${
          state.addWordOpen
            ? `<div class="add-word-panel">
                <form class="word-form" data-action="create-entry">
                  <label>
                    <span>Japanese</span>
                    <input name="japanese" ${renderInputAssistOff()} placeholder="食べ物" required />
                  </label>
                  <label>
                    <span>Furigana</span>
                    <input name="furigana" ${renderInputAssistOff()} placeholder="たべもの" />
                  </label>
                  <label>
                    <span>Romaji</span>
                    <input name="romaji" ${renderInputAssistOff()} placeholder="tabemono" />
                  </label>
                  <label>
                    <span>Translation</span>
                    <input name="translation" ${renderInputAssistOff()} placeholder="food / meal" />
                  </label>
                  <button class="primary-button wide" type="submit">Add word</button>
                </form>
              </div>`
            : ""
        }
      </section>
    `;
  }

  function updateAddWordBlock() {
    const root = document.getElementById("add-word-root");

    if (!root) {
      render();
      return;
    }

    root.innerHTML = renderAddWordBlock();
  }

  function renderInputAssistOff() {
    return 'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"';
  }

  function renderTopbar(title, subtitle) {
    const actions =
      state.route.name === "home"
        ? `<div class="topbar-actions">${renderHomeActions()}</div>`
        : "";

    return `
      <header class="topbar">
        <div>
          <p>${escapeHtml(subtitle)}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        ${actions}
      </header>
    `;
  }

  function renderNotice() {
    syncNoticeDismissTimer();

    const parts = [];

    if (state.error) {
      parts.push(`<div class="notice error is-dismissible">${escapeHtml(state.error)}</div>`);
    }

    if (state.status) {
      parts.push(`<div class="notice is-dismissible">${escapeHtml(state.status)}</div>`);
    }

    return parts.join("");
  }

  function syncNoticeDismissTimer() {
    const key = [state.error, state.status].filter(Boolean).join("\n");

    if (!key) {
      clearNoticeDismissTimer();
      return;
    }

    if (key === noticeDismissKey && noticeDismissTimer) return;

    clearNoticeDismissTimer();
    noticeDismissKey = key;
    noticeDismissTimer = window.setTimeout(() => {
      const currentKey = [state.error, state.status].filter(Boolean).join("\n");
      if (currentKey !== noticeDismissKey) return;

      state.error = "";
      state.status = "";
      noticeDismissTimer = 0;
      noticeDismissKey = "";
      render();
    }, NOTICE_DISMISS_DELAY);
  }

  function clearNoticeDismissTimer() {
    if (noticeDismissTimer) {
      window.clearTimeout(noticeDismissTimer);
    }

    noticeDismissTimer = 0;
    noticeDismissKey = "";
  }

  function renderLessonCard(lesson) {
    return `
      <article class="lesson-card">
        <button class="lesson-open-button" data-action="open-lesson" data-id="${escapeAttribute(lesson.id)}">
          <span>
            <strong>Lesson ${escapeHtml(lesson.lessonNumber)}</strong>
            <small>Page ${escapeHtml(lesson.pageNumber)}</small>
          </span>
          <em>${lesson.entries.length}</em>
        </button>
        ${renderLessonDeleteButton(lesson, "card")}
      </article>
    `;
  }

  function renderLessonDeleteButton(lesson, placement) {
    if (!state.data.settings.enableDeletion) return "";

    const className =
      placement === "card"
        ? "icon-button danger delete-button lesson-card-delete"
        : "icon-button danger delete-button lesson-delete-button";

    return `
      <button
        class="${className}"
        data-action="delete-lesson"
        data-id="${escapeAttribute(lesson.id)}"
        aria-label="Delete Lesson ${escapeAttribute(lesson.lessonNumber)}"
        title="Delete lesson"
      >×</button>
    `;
  }

  function renderEntry(entry) {
    const hasReading = Boolean(entry.furigana || entry.romaji);
    const visible = state.readingVisible.has(entry.id);
    const actions = renderEntryActions(entry);

    return `
      <article
        class="word-row ${actions ? "has-actions" : ""} ${hasReading ? "has-reading" : ""}"
        ${hasReading ? `data-action="toggle-reading" data-id="${escapeAttribute(entry.id)}"` : ""}
      >
        <div class="word-main">
          <div class="japanese">
            ${renderJapanese(entry, visible)}
          </div>
        </div>
        <div class="reading">${visible && entry.romaji ? escapeHtml(entry.romaji) : ""}</div>
        <div class="translation">${escapeHtml(entry.translation)}</div>
        ${actions}
      </article>
    `;
  }

  function renderEntryActions(entry) {
    const actions = [];

    if (state.data.settings.enableEdit) {
      actions.push(
        `<button class="ghost-button edit-button" data-action="open-edit-entry" data-id="${escapeAttribute(entry.id)}" type="button">Edit</button>`,
      );
    }

    if (state.data.settings.enableDeletion) {
      actions.push(
        `<button class="icon-button danger delete-button" data-action="delete-entry" data-id="${escapeAttribute(entry.id)}" aria-label="Delete word" title="Delete word">×</button>`,
      );
    }

    if (!actions.length) return "";

    return `
      <div class="word-actions">
        ${actions.join("")}
      </div>
    `;
  }

  function createLesson(form) {
    const formData = new FormData(form);
    const lessonNumber = String(formData.get("lessonNumber") || "").trim();
    const pageNumber = String(formData.get("pageNumber") || "").trim();

    if (!lessonNumber || !pageNumber) return;

    const lesson = {
      id: createId(),
      lessonNumber,
      pageNumber,
      createdAt: new Date().toISOString(),
      entries: [],
    };

    state.data.lessons.push(lesson);
    state.modal = "";
    form.reset();
    persist();
    navigate({ name: "lesson", id: lesson.id });
  }

  function createEntry(form) {
    const lesson = getCurrentLesson();
    if (!lesson) return;

    const formData = new FormData(form);
    const japanese = String(formData.get("japanese") || "").trim();
    const furigana = String(formData.get("furigana") || "").trim();
    const romaji = String(formData.get("romaji") || "").trim();
    const translation = String(formData.get("translation") || "").trim();

    if (!japanese) return;

    lesson.entries.push({
      id: createId(),
      japanese,
      furigana,
      romaji,
      translation,
      createdAt: new Date().toISOString(),
    });

    form.reset();
    updateWordList();
    persist();
  }

  function updateEntry(form) {
    const formData = new FormData(form);
    const entryId = String(formData.get("entryId") || "");
    const context = findEntryContext(entryId);
    if (!context) return;

    const japanese = String(formData.get("japanese") || "").trim();
    const furigana = String(formData.get("furigana") || "").trim();
    const romaji = String(formData.get("romaji") || "").trim();
    const translation = String(formData.get("translation") || "").trim();

    if (!japanese) return;

    context.entry.japanese = japanese;
    context.entry.furigana = furigana;
    context.entry.romaji = romaji;
    context.entry.translation = translation;
    state.modal = "";
    state.editEntryId = "";
    state.error = "";
    updateModal();
    updateWordList();
    persist();
  }

  function deleteEntry(entryId) {
    const lesson = getCurrentLesson();
    if (!lesson) return;

    lesson.entries = lesson.entries.filter((entry) => entry.id !== entryId);
    state.readingVisible.delete(entryId);
    updateWordList();
    persist();
  }

  function deleteLesson(lessonId) {
    const lesson = state.data.lessons.find((item) => item.id === lessonId);
    if (!lesson) return;

    const confirmed = window.confirm(
      `Delete Lesson ${lesson.lessonNumber} · Page ${lesson.pageNumber} and all ${lesson.entries.length} words?`,
    );

    if (!confirmed) return;

    state.data.lessons = state.data.lessons.filter((item) => item.id !== lessonId);
    lesson.entries.forEach((entry) => state.readingVisible.delete(entry.id));
    state.status = `Deleted Lesson ${lesson.lessonNumber} · Page ${lesson.pageNumber}.`;
    state.error = "";

    if (state.route.name === "lesson" && state.route.id === lessonId) {
      navigate({ name: "home" });
      persist();
      return;
    }

    persist();
  }

  function setJapaneseStyle(style) {
    if (style !== "standard" && style !== "book") return;
    if (state.data.settings.japaneseStyle === style) return;

    state.data.settings.japaneseStyle = style;
    state.error = "";
    app.dataset.japaneseStyle = style;
    persist();
  }

  function setFontSize(size) {
    if (!["small", "medium", "large"].includes(size)) return;
    if (state.data.settings.fontSize === size) return;

    state.data.settings.fontSize = size;
    state.error = "";
    app.dataset.fontSize = size;
    persist();
  }

  function toggleDeletion() {
    state.data.settings.enableDeletion = !state.data.settings.enableDeletion;
    state.error = "";
    persist();
  }

  function toggleEdit() {
    state.data.settings.enableEdit = !state.data.settings.enableEdit;
    state.error = "";
    persist();
  }

  function importStarterLessons() {
    if (!starterLessons.length) return;

    let addedLessons = 0;
    let addedWords = 0;

    starterLessons.forEach((starterLesson) => {
      let lesson = state.data.lessons.find(
        (item) =>
          item.lessonNumber === starterLesson.lessonNumber &&
          item.pageNumber === starterLesson.pageNumber,
      );

      if (!lesson) {
        lesson = {
          id: createId(),
          lessonNumber: starterLesson.lessonNumber,
          pageNumber: starterLesson.pageNumber,
          createdAt: new Date().toISOString(),
          entries: [],
        };
        state.data.lessons.push(lesson);
        addedLessons += 1;
      }

      starterLesson.entries.forEach((starterEntry) => {
        const exists = lesson.entries.some(
          (entry) =>
            entry.japanese === starterEntry.japanese &&
            entry.translation === starterEntry.translation,
        );

        if (exists) return;

        lesson.entries.push({
          id: createId(),
          japanese: starterEntry.japanese,
          furigana: starterEntry.furigana || "",
          romaji: starterEntry.romaji || "",
          translation: starterEntry.translation,
          createdAt: new Date().toISOString(),
        });
        addedWords += 1;
      });
    });

    state.status =
      addedWords > 0
        ? `Imported ${addedLessons} lessons and ${addedWords} words.`
        : "Lessons 3-6 are already imported.";
    state.error = "";

    persist();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-action]");
    if (!form) return;

    event.preventDefault();

    if (form.dataset.action === "create-lesson") {
      createLesson(form);
    }

    if (form.dataset.action === "create-entry") {
      createEntry(form);
    }

    if (form.dataset.action === "update-entry") {
      updateEntry(form);
    }
  });

  document.addEventListener("click", (event) => {
    const control = event.target.closest("[data-action]");
    if (!control) return;

    const action = control.dataset.action;
    event.stopPropagation();

    if (action === "open-lesson") {
      navigate({ name: "lesson", id: control.dataset.id });
    }

    if (action === "go-home") {
      navigate({ name: "home" });
    }

    if (action === "clear-search") {
      state.searchQuery = "";
      const searchInput = document.querySelector("[data-role='global-search']");
      if (searchInput) {
        searchInput.value = "";
      }
      updateSearchResults();
    }

    if (action === "open-modal") {
      state.modal = control.dataset.modal || "";
      updateModal();
    }

    if (action === "open-edit-entry") {
      state.modal = "editEntry";
      state.editEntryId = control.dataset.id || "";
      updateModal();
    }

    if (action === "close-modal") {
      state.modal = "";
      state.editEntryId = "";
      updateModal();
    }

    if (action === "modal-panel") {
      return;
    }

    if (action === "import-starter") {
      importStarterLessons();
    }

    if (action === "set-japanese-style") {
      setJapaneseStyle(control.dataset.style);
      updateModal();
    }

    if (action === "set-font-size") {
      setFontSize(control.dataset.size);
      updateModal();
    }

    if (action === "toggle-deletion") {
      toggleDeletion();
      updateModal();
      updateWordList();
    }

    if (action === "toggle-edit") {
      toggleEdit();
      updateModal();
      updateWordList();
    }

    if (action === "toggle-add-word") {
      state.addWordOpen = !state.addWordOpen;
      updateAddWordBlock();
    }

    if (action === "toggle-reading") {
      const entryId = control.dataset.id;
      const context = findEntryContext(entryId);
      if (state.readingVisible.has(entryId)) {
        state.readingVisible.delete(entryId);
      } else {
        state.readingVisible.add(entryId);
      }

      if (!context) {
        render();
        return;
      }

      control.outerHTML = control.classList.contains("search-result")
        ? renderSearchResult(context)
        : renderEntry(context.entry);
    }

    if (action === "delete-entry") {
      deleteEntry(control.dataset.id);
    }

    if (action === "delete-lesson") {
      deleteLesson(control.dataset.id);
    }
  });

  document.addEventListener("input", (event) => {
    const input = event.target.closest("[data-role='global-search']");
    if (!input) return;

    state.searchQuery = input.value;
    updateSearchResults();
  });

  window.addEventListener("hashchange", () => {
    state.route = parseRoute();
    state.readingVisible.clear();
    state.addWordOpen = false;
    state.modal = "";
    state.editEntryId = "";
    render();
  });

  boot();
})();
