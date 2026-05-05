(function () {
  "use strict";

  const STORAGE_KEY = "genki_dic_v1";
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const isTelegramMiniApp = Boolean(tg && tg.initData);
  const hasCloudStorage = Boolean(isTelegramMiniApp && tg.CloudStorage);

  const state = {
    ready: false,
    route: { name: "home" },
    data: { lessons: [] },
    searchQuery: "",
    readingVisible: new Set(),
    saving: false,
    error: "",
  };

  const app = document.getElementById("app");

  const storage = {
    async get() {
      if (hasCloudStorage) {
        const value = await cloudGetItem(STORAGE_KEY);
        return value ? JSON.parse(value) : { lessons: [] };
      }

      const value = window.localStorage.getItem(STORAGE_KEY);
      return value ? JSON.parse(value) : { lessons: [] };
    },
    async set(data) {
      const serialized = JSON.stringify(data);

      if (hasCloudStorage) {
        await cloudSetItem(STORAGE_KEY, serialized);
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
      tg.CloudStorage.setItem(key, value, (error) => {
        if (error) {
          reject(new Error(error));
          return;
        }
        resolve();
      });
    });
  }

  function normalizeData(data) {
    const lessons = Array.isArray(data && data.lessons) ? data.lessons : [];

    return {
      lessons: lessons
        .map((lesson) => ({
          id: String(lesson.id || createId()),
          lessonNumber: String(lesson.lessonNumber || "").trim(),
          pageNumber: String(lesson.pageNumber || "").trim(),
          createdAt: lesson.createdAt || new Date().toISOString(),
          entries: Array.isArray(lesson.entries)
            ? lesson.entries.map((entry) => ({
                id: String(entry.id || createId()),
                japanese: String(entry.japanese || "").trim(),
                furigana: String(entry.furigana || "").trim(),
                translation: String(entry.translation || "").trim(),
                createdAt: entry.createdAt || new Date().toISOString(),
              }))
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
          haystack: [entry.japanese, entry.furigana, entry.translation]
            .join(" ")
            .toLocaleLowerCase(),
        })),
      )
      .filter((result) => result.haystack.includes(query))
      .sort((a, b) => lessonSort(a.lesson, b.lesson));
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

      <section class="panel">
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
      <section class="section-head search-head">
        <h2>Results</h2>
        <span>${results.length}</span>
      </section>
      <section class="word-list search-list">
        ${results.map(renderSearchResult).join("")}
      </section>
    `;
  }

  function renderSearchResult(result) {
    const { lesson, entry } = result;
    const hasReading = Boolean(entry.furigana);
    const visible = state.readingVisible.has(entry.id);

    return `
      <article class="word-row search-result">
        <button class="word-main result-button" data-action="open-lesson" data-id="${escapeAttribute(lesson.id)}">
          <small>Lesson ${escapeHtml(lesson.lessonNumber)} · Page ${escapeHtml(lesson.pageNumber)}</small>
          <div class="japanese">
            ${
              hasReading && visible
                ? `<ruby>${escapeHtml(entry.japanese)}<rt>${escapeHtml(entry.furigana)}</rt></ruby>`
                : escapeHtml(entry.japanese)
            }
          </div>
          <div class="translation">${escapeHtml(entry.translation)}</div>
        </button>
        <div class="word-actions">
          ${
            hasReading
              ? `<button class="ghost-button" data-action="toggle-reading" data-id="${escapeAttribute(entry.id)}">
                  ${visible ? "Hide" : "Show"}
                </button>`
              : ""
          }
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

    if (state.saving) {
      parts.push(`<div class="notice">Saving...</div>`);
    }

    return parts.join("");
  }

  function renderLessonCard(lesson) {
    return `
      <article class="lesson-card">
        <button data-action="open-lesson" data-id="${escapeAttribute(lesson.id)}">
          <span>
            <strong>Lesson ${escapeHtml(lesson.lessonNumber)}</strong>
            <small>Page ${escapeHtml(lesson.pageNumber)}</small>
          </span>
          <em>${lesson.entries.length}</em>
        </button>
      </article>
    `;
  }

  function renderEntry(entry) {
    const hasReading = Boolean(entry.furigana);
    const visible = state.readingVisible.has(entry.id);

    return `
      <article class="word-row">
        <div class="word-main">
          <div class="japanese">
            ${
              hasReading && visible
                ? `<ruby>${escapeHtml(entry.japanese)}<rt>${escapeHtml(entry.furigana)}</rt></ruby>`
                : escapeHtml(entry.japanese)
            }
          </div>
          <div class="translation">${escapeHtml(entry.translation)}</div>
        </div>
        <div class="word-actions">
          ${
            hasReading
              ? `<button class="ghost-button" data-action="toggle-reading" data-id="${escapeAttribute(entry.id)}">
                  ${visible ? "Hide" : "Show"}
                </button>`
              : ""
          }
          <button class="icon-button danger" data-action="delete-entry" data-id="${escapeAttribute(entry.id)}" aria-label="Delete word" title="Delete word">×</button>
        </div>
      </article>
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
