(function () {
  "use strict";

  const STORAGE_KEY = "genki_dic_v1";
  const STORAGE_MANIFEST_KEY = `${STORAGE_KEY}_manifest`;
  const STORAGE_CHUNK_PREFIX = `${STORAGE_KEY}_chunk_`;
  const STORAGE_CHUNK_SIZE = 900;
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const isTelegramMiniApp = Boolean(tg && tg.initData);
  const hasCloudStorage = Boolean(isTelegramMiniApp && tg.CloudStorage);
  const starterLessons = Array.isArray(window.GENKI_STARTER_LESSONS)
    ? window.GENKI_STARTER_LESSONS
    : [];

  const state = {
    ready: false,
    route: { name: "home" },
    data: { settings: { japaneseStyle: "standard", enableDeletion: false }, lessons: [] },
    modal: "",
    searchQuery: "",
    readingVisible: new Set(),
    saving: false,
    status: "",
    error: "",
  };

  const app = document.getElementById("app");

  const storage = {
    async get() {
      if (hasCloudStorage) {
        return cloudGetData();
      }

      const value = window.localStorage.getItem(STORAGE_KEY);
      return value ? JSON.parse(value) : { lessons: [] };
    },
    async set(data) {
      const serialized = JSON.stringify(data);

      if (hasCloudStorage) {
        await cloudSetData(serialized);
        return;
      }

      window.localStorage.setItem(STORAGE_KEY, serialized);
    },
  };

  function cloudGetItem(key) {
    return new Promise((resolve, reject) => {
      tg.CloudStorage.getItem(key, (error, value) => {
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
      tg.CloudStorage.setItem(key, value, (error, isStored) => {
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

    const saved = await cloudGetData();
    const savedSerialized = JSON.stringify(saved);

    if (savedSerialized !== serialized) {
      throw new Error("CloudStorage verification failed");
    }
  }

  function normalizeData(data) {
    const lessons = Array.isArray(data && data.lessons) ? data.lessons : [];
    const rawStyle = data && data.settings ? data.settings.japaneseStyle : "";
    const japaneseStyle = rawStyle === "book" ? "book" : "standard";
    const enableDeletion = Boolean(data && data.settings && data.settings.enableDeletion);

    return {
      settings: {
        japaneseStyle,
        enableDeletion,
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

  async function persist() {
    state.saving = true;
    state.error = "";
    render();

    try {
      await storage.set(state.data);
    } catch (error) {
      state.status = "";
      state.error = `Could not save changes: ${error.message}`;
    } finally {
      state.saving = false;
      render();
    }
  }

  function lessonSort(a, b) {
    const lessonDelta = Number(a.lessonNumber) - Number(b.lessonNumber);
    if (lessonDelta !== 0) return lessonDelta;
    return Number(a.pageNumber) - Number(b.pageNumber);
  }

  function getCurrentLesson() {
    return state.data.lessons.find((lesson) => lesson.id === state.route.id);
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
      ${renderHomeActions()}
      ${renderSearchPanel()}

      <section class="section-head">
        <h2>Lessons</h2>
        <span>${lessons.length}</span>
      </section>

      ${
        lessons.length
          ? `<div class="lesson-list">${lessons.map(renderLessonCard).join("")}</div>`
          : `<section class="empty-state">
              <h2>No lessons yet</h2>
              <p>Create your first Genki page above.</p>
            </section>`
      }
      ${renderModal()}
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

    const title = state.modal === "settings" ? "Settings" : "Create lesson";
    const content = state.modal === "settings" ? renderSettings() : renderCreateLessonForm();

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

  function renderCreateLessonForm() {
    return `
      <section class="panel modal-content-panel">
        <form class="lesson-form" data-action="create-lesson">
          <label>
            <span>Lesson</span>
            <input name="lessonNumber" inputmode="numeric" autocomplete="off" placeholder="5" required />
          </label>
          <label>
            <span>Page</span>
            <input name="pageNumber" inputmode="numeric" autocomplete="off" placeholder="130" required />
          </label>
          <button class="primary-button" type="submit">Create</button>
        </form>
      </section>
    `;
  }

  function renderSettings() {
    const style = state.data.settings.japaneseStyle;
    const deletionEnabled = state.data.settings.enableDeletion;

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
              autocomplete="off"
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
          <h1>${lesson.entries.length} ${lesson.entries.length === 1 ? "word" : "words"}</h1>
        </div>
        ${renderLessonDeleteButton(lesson, "header")}
      </header>

      ${renderNotice()}

      <section class="panel">
        <form class="word-form" data-action="create-entry">
          <label>
            <span>Japanese</span>
            <input name="japanese" autocomplete="off" placeholder="食べ物" required />
          </label>
          <label>
            <span>Furigana</span>
            <input name="furigana" autocomplete="off" placeholder="たべもの" />
          </label>
          <label class="wide">
            <span>Translation</span>
            <input name="translation" autocomplete="off" placeholder="food / meal" required />
          </label>
          <button class="primary-button wide" type="submit">Add word</button>
        </form>
      </section>

      ${
        lesson.entries.length
          ? `<section class="word-list">${lesson.entries.map(renderEntry).join("")}</section>`
          : `<section class="empty-state">
              <h2>No words yet</h2>
              <p>Add Japanese, optional furigana, and a translation.</p>
            </section>`
      }
    `;
  }

  function renderTopbar(title, subtitle) {
    return `
      <header class="topbar">
        <div>
          <p>${escapeHtml(subtitle)}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <span class="storage-pill">${hasCloudStorage ? "Telegram Cloud" : "Local browser"}</span>
      </header>
    `;
  }

  function renderNotice() {
    const parts = [];

    if (state.error) {
      parts.push(`<div class="notice error">${escapeHtml(state.error)}</div>`);
    }

    if (state.status) {
      parts.push(`<div class="notice">${escapeHtml(state.status)}</div>`);
    }

    if (state.saving) {
      parts.push(`<div class="notice">Saving...</div>`);
    }

    return parts.join("");
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
    if (!state.data.settings.enableDeletion) return "";

    return `
      <div class="word-actions">
        <button class="icon-button danger delete-button" data-action="delete-entry" data-id="${escapeAttribute(entry.id)}" aria-label="Delete word" title="Delete word">×</button>
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
    const translation = String(formData.get("translation") || "").trim();

    if (!japanese || !translation) return;

    lesson.entries.push({
      id: createId(),
      japanese,
      furigana,
      romaji: "",
      translation,
      createdAt: new Date().toISOString(),
    });

    form.reset();
    persist();
  }

  function deleteEntry(entryId) {
    const lesson = getCurrentLesson();
    if (!lesson) return;

    lesson.entries = lesson.entries.filter((entry) => entry.id !== entryId);
    state.readingVisible.delete(entryId);
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
    state.status = `Japanese style set to ${style === "book" ? "Book" : "Standard"}.`;
    state.error = "";
    persist();
  }

  function toggleDeletion() {
    state.data.settings.enableDeletion = !state.data.settings.enableDeletion;
    state.status = state.data.settings.enableDeletion
      ? "Deletion enabled."
      : "Deletion disabled.";
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
      render();
    }

    if (action === "open-modal") {
      state.modal = control.dataset.modal || "";
      render();
    }

    if (action === "close-modal") {
      state.modal = "";
      render();
    }

    if (action === "modal-panel") {
      return;
    }

    if (action === "import-starter") {
      importStarterLessons();
    }

    if (action === "set-japanese-style") {
      setJapaneseStyle(control.dataset.style);
    }

    if (action === "toggle-deletion") {
      toggleDeletion();
    }

    if (action === "toggle-reading") {
      const entryId = control.dataset.id;
      if (state.readingVisible.has(entryId)) {
        state.readingVisible.delete(entryId);
      } else {
        state.readingVisible.add(entryId);
      }
      render();
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

    const results = document.getElementById("search-results");
    if (results) {
      results.innerHTML = renderSearchResults();
    }

    const clearButton = document.querySelector("[data-action='clear-search']");
    if (clearButton) {
      clearButton.hidden = !state.searchQuery;
    }
  });

  window.addEventListener("hashchange", () => {
    state.route = parseRoute();
    state.readingVisible.clear();
    render();
  });

  boot();
})();
